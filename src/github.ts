// Tracker module: every GitHub call of the loop. All calls are `gh api` REST (no GraphQL) and go
// through one runner, the seam tests replace. Every JSON response is checked with Zod.
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Config } from './config.ts';
import { isNotFound } from './fs.ts';

/** Runs `gh` with these arguments and resolves with its stdout; rejects on a non-zero exit. */
export type Gh = (args: string[]) => Promise<string>;

export class GhError extends Error {}

/** The real runner: the `gh` binary on PATH. */
export function ghCli(env: NodeJS.ProcessEnv = process.env): Gh {
  return async (args) => {
    try {
      const { stdout } = await promisify(execFile)('gh', args, {
        env,
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const stderr =
        error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
          ? error.stderr.trim()
          : '';
      const detail = stderr || (error instanceof Error ? error.message : String(error));
      throw new GhError(`gh ${args.join(' ')} failed: ${detail}`, { cause: error });
    }
  };
}

export const PROGRESS_MARKER = '<!-- ralph-progress -->';

const Label = z.object({ name: z.string() });
const Issue = z.object({
  number: z.int(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  labels: z.array(Label),
  pull_request: z.unknown().optional(),
});
export type Issue = z.output<typeof Issue>;
const Comment = z.object({ id: z.int(), body: z.string().nullable() });
const Pull = z.object({ number: z.int(), head: z.object({ sha: z.string() }) });
const CheckRunsPage = z.object({
  check_runs: z.array(
    z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() }),
  ),
});
const CombinedStatus = z.object({
  state: z.string(),
  total_count: z.int(),
  statuses: z.array(z.object({ context: z.string(), state: z.string() })),
});
const Commit = z.object({ sha: z.string() });

export type IssueState = 'closed' | 'needs-human' | 'blocked' | 'open';
export type CheckState = 'none' | 'pending' | 'red' | 'green';

const OK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/**
 * Issue numbers listed under the body's `## Blocked by` section, which ends at the next `## `
 * heading, a `---` rule or the end. Undefined when the body has no such section.
 */
export function blockedBy(body: string | null): number[] | undefined {
  const section = /## Blocked by([\s\S]*?)(\n## |\n---|$)/.exec(body ?? '')?.[1];
  if (section === undefined) return undefined;
  return [...section.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

export interface MergeOptions {
  /** Waits between CI polls; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type Tracker = ReturnType<typeof createTracker>;

export function createTracker(
  config: Pick<Config, 'repo' | 'labels' | 'merge'>,
  gh: Gh,
  log: (line: string) => void = () => {},
) {
  const repo = `repos/${config.repo}`;
  const { labels } = config;

  async function call(args: string[]): Promise<string> {
    return gh(['api', ...args]);
  }

  /** GET (or a write) whose JSON output must match `schema`. */
  async function api<T>(schema: z.ZodType<T>, args: string[]): Promise<T> {
    const path = args.find((arg) => arg.startsWith('repos/')) ?? args.join(' ');
    const stdout = await call(args);
    let data: unknown;
    try {
      data = JSON.parse(stdout);
    } catch (error) {
      throw new GhError(`unexpected response from gh api ${path}: not JSON`, { cause: error });
    }
    const result = schema.safeParse(data);
    if (!result.success) {
      const issue = result.error.issues[0];
      const where = issue?.path.map(String).join('.') || '(root)';
      throw new GhError(`unexpected response from gh api ${path}: ${where}: ${issue?.message}`);
    }
    return result.data;
  }

  /** Every item of a paginated list endpoint. */
  async function list<T>(item: z.ZodType<T>, path: string): Promise<T[]> {
    const pages = await api(z.array(z.array(item)), ['--paginate', '--slurp', path]);
    return pages.flat();
  }

  /** Every page of a paginated endpoint whose pages are objects. */
  async function pages<T>(page: z.ZodType<T>, path: string): Promise<T[]> {
    return api(z.array(page), ['--paginate', '--slurp', path]);
  }

  const hasLabel = (issue: Issue, name: string) => issue.labels.some((l) => l.name === name);
  const getIssue = (n: number) => api(Issue, [`${repo}/issues/${n}`]);
  const openIssues = async () =>
    (await list(Issue, `${repo}/issues?state=open&per_page=100`)).filter(
      (issue) => issue.pull_request === undefined,
    );
  const removeLabel = (n: number, name: string) =>
    call(['-X', 'DELETE', `${repo}/issues/${n}/labels/${encodeURIComponent(name)}`]);
  const comment = (n: number, body: string) =>
    call([`${repo}/issues/${n}/comments`, '-f', `body=${body}`]);

  async function issueState(n: number): Promise<IssueState> {
    const issue = await getIssue(n);
    if (issue.state === 'closed') return 'closed';
    if (hasLabel(issue, labels.needsHuman)) return 'needs-human';
    if (hasLabel(issue, labels.blocked)) return 'blocked';
    return 'open';
  }

  /** True when every issue under `## Blocked by` is closed (no section counts as true). */
  const unblocked = (issue: Issue, open: Set<number>) =>
    !(blockedBy(issue.body) ?? []).some((n) => open.has(n));

  async function unblockDependents(): Promise<void> {
    const issues = await openIssues();
    const open = new Set(issues.map((issue) => issue.number));
    for (const issue of issues) {
      if (!hasLabel(issue, labels.blocked) || blockedBy(issue.body) === undefined) continue;
      if (!unblocked(issue, open)) continue;
      log(`Unblocking #${issue.number}`);
      await removeLabel(issue.number, labels.blocked);
    }
  }

  async function progressCommentId(n: number): Promise<number | undefined> {
    const comments = await list(Comment, `${repo}/issues/${n}/comments?per_page=100`);
    return comments.find((c) => (c.body ?? '').startsWith(PROGRESS_MARKER))?.id;
  }

  const progressFile = (cwd: string, n: number) => join(cwd, 'logs', `issue-${n}.progress.md`);

  /** CI state of a commit from its check runs and legacy commit statuses. */
  async function checkState(sha: string): Promise<CheckState> {
    const runs = (
      await pages(CheckRunsPage, `${repo}/commits/${sha}/check-runs?per_page=100`)
    ).flatMap((page) => page.check_runs);
    let runState: CheckState;
    if (runs.length === 0) runState = 'none';
    else if (runs.some((r) => r.status !== 'completed')) runState = 'pending';
    else if (runs.some((r) => !OK_CONCLUSIONS.has(r.conclusion ?? ''))) runState = 'red';
    else runState = 'green';

    const status = await api(CombinedStatus, [`${repo}/commits/${sha}/status`]);
    if (status.total_count === 0) return runState;
    if (status.state === 'failure' || status.state === 'error') return 'red';
    if (status.state === 'pending' && runState === 'green') return 'pending';
    return runState;
  }

  /** Names of failing check runs and legacy statuses of a commit, sorted and unique. */
  async function failingChecks(sha: string): Promise<string[]> {
    const runs = (await pages(CheckRunsPage, `${repo}/commits/${sha}/check-runs?per_page=100`))
      .flatMap((page) => page.check_runs)
      .filter((r) => r.status === 'completed' && !OK_CONCLUSIONS.has(r.conclusion ?? ''))
      .map((r) => r.name);
    const statuses = (await pages(CombinedStatus, `${repo}/commits/${sha}/status`))
      .flatMap((page) => page.statuses)
      .filter((s) => s.state === 'failure' || s.state === 'error')
      .map((s) => s.context);
    return [...new Set([...runs, ...statuses])].sort();
  }

  async function findPr(n: number): Promise<{ number: number; sha: string } | undefined> {
    const owner = config.repo.split('/')[0] ?? '';
    const head = encodeURIComponent(`${owner}:feature/issue-${n}`);
    const pulls = await api(z.array(Pull), [`${repo}/pulls?head=${head}&state=open`]);
    const pr = pulls[0];
    return pr && { number: pr.number, sha: pr.head.sha };
  }

  /** Failing checks of `sha` when every one of them also fails on main; else undefined. */
  async function redOnlyOnMain(sha: string): Promise<string[] | undefined> {
    const main = await api(Commit, [`${repo}/commits/main`]);
    const prFailing = await failingChecks(sha);
    const mainFailing = new Set(await failingChecks(main.sha));
    if (prFailing.length === 0 || prFailing.some((name) => !mainFailing.has(name))) return;
    return prFailing;
  }

  /** Opens `main is red: <check>` unless an open issue has that title. Never throws. */
  async function ensureMainRedIssue(check: string, pr: number, warn: (l: string) => void) {
    const title = `main is red: ${check}`;
    let issues;
    try {
      issues = await list(Issue, `${repo}/issues?state=open&per_page=100`);
    } catch {
      warn(`warn: could not list open issues; not opening '${title}'.`);
      return;
    }
    if (issues.some((issue) => issue.title === title)) return;
    const body = `The check \`${check}\` is failing on \`main\`. Found while merging PR #${pr}, which was red only on checks also red on main. Fix the check, or remove it if it is not ours.`;
    const labelArgs = labels.pickLabel === '' ? [] : ['-f', `labels[]=${labels.pickLabel}`];
    try {
      await call([`${repo}/issues`, '-f', `title=${title}`, ...labelArgs, '-f', `body=${body}`]);
      warn(`Opened issue: ${title}`);
    } catch {
      warn(`warn: could not open issue '${title}'.`);
    }
  }

  return {
    issueState,
    getIssue,

    async isLocked(n: number): Promise<boolean> {
      return hasLabel(await getIssue(n), labels.lock);
    },

    async lock(n: number): Promise<void> {
      await call([`${repo}/issues/${n}/labels`, '-f', `labels[]=${labels.lock}`]);
    },

    /** Removes the lock label; never throws, like the exit trap it replaces. */
    async unlock(n: number): Promise<void> {
      try {
        await removeLabel(n, labels.lock);
      } catch {
        // Already gone, or GitHub is unreachable: the next run reports the stale lock.
      }
    },

    /**
     * The oldest open issue (not a PR) with the pick label (when set), none of the blocked,
     * needs-human or lock labels, and no still-open issue under `## Blocked by`.
     */
    async nextIssue(): Promise<Issue | undefined> {
      const issues = await openIssues();
      const open = new Set(issues.map((issue) => issue.number));
      const skip = [labels.blocked, labels.needsHuman, labels.lock];
      return issues
        .filter(
          (issue) =>
            (labels.pickLabel === '' || hasLabel(issue, labels.pickLabel)) &&
            !skip.some((name) => hasLabel(issue, name)) &&
            unblocked(issue, open),
        )
        .sort((a, b) => a.number - b.number)[0];
    },

    unblockDependents,

    /** Writes the progress comment of issue `n` to `logs/issue-<n>.progress.md` under `cwd`. */
    async progressPull(n: number, cwd: string): Promise<void> {
      const id = await progressCommentId(n);
      if (id === undefined) return;
      const { body } = await api(Comment, [`${repo}/issues/comments/${id}`]);
      // Drop the marker, the opening fence and the closing fence.
      const lines = (body ?? '').replace(/\n$/, '').split('\n').slice(2, -1);
      await mkdir(join(cwd, 'logs'), { recursive: true });
      await writeFile(progressFile(cwd, n), lines.length === 0 ? '' : `${lines.join('\n')}\n`);
    },

    /** Writes `logs/issue-<n>.progress.md` under `cwd` to the progress comment, in place. */
    async progressPush(n: number, cwd: string): Promise<void> {
      let text: string;
      try {
        text = await readFile(progressFile(cwd, n), 'utf8');
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
      const end = text === '' || text.endsWith('\n') ? '' : '\n';
      const body = `${PROGRESS_MARKER}\n\`\`\`text\n${text}${end}\`\`\`\n`;
      const id = await progressCommentId(n);
      if (id === undefined) await comment(n, body);
      else await call(['-X', 'PATCH', `${repo}/issues/comments/${id}`, '-f', `body=${body}`]);
    },

    findPr,
    checkState,
    failingChecks,

    /**
     * Waits for CI on the issue's open PR, merges it when green (or red only on checks also red on
     * main), closes the issue and unblocks dependents. True when merged; false when the LLM merge
     * phase is needed (no open PR, CI red, or the merge was refused).
     */
    async merge(n: number, { sleep = wait }: MergeOptions = {}): Promise<boolean> {
      const out = log;
      const branch = `feature/issue-${n}`;
      let pr;
      try {
        pr = await findPr(n);
      } catch (error) {
        out(`GitHub API lookup of the PR for ${branch} failed: ${message(error)}`);
        return false;
      }
      if (pr === undefined) {
        out(`No open PR for ${branch}.`);
        return false;
      }

      // Checks can take a moment to register after the last push; CI itself can take a while.
      out(`Waiting for CI on PR #${pr.number}...`);
      let state: CheckState | 'error' = 'none';
      for (let i = 1; i <= 360; i++) {
        try {
          state = await checkState(pr.sha);
        } catch {
          state = 'error';
        }
        if (state === 'green' || state === 'red') break;
        if (state === 'none' && i > 12) break;
        await sleep(10_000);
      }

      let redOnMain: string[] | undefined;
      if (state === 'red') {
        try {
          redOnMain = await redOnlyOnMain(pr.sha);
        } catch {
          redOnMain = undefined;
        }
      }
      if (redOnMain) {
        out(`PR #${pr.number} is red only on checks also red on main; merging anyway.`);
      } else if (state !== 'green') {
        out(`CI is not green on PR #${pr.number} (${state}).`);
        return false;
      }

      try {
        await call([
          '-X',
          'PUT',
          `${repo}/pulls/${pr.number}/merge`,
          '-f',
          `merge_method=${config.merge.method}`,
        ]);
      } catch {
        out(`Merge of PR #${pr.number} failed.`);
        return false;
      }
      if (redOnMain) {
        try {
          await comment(pr.number, `Merged with checks also red on main: ${redOnMain.join(', ')}`);
        } catch {
          out(`warn: could not comment on merged PR #${pr.number}.`);
        }
        for (const check of redOnMain) await ensureMainRedIssue(check, pr.number, out);
      }
      // The local branch is checked out in the issue's worktree; only the remote one goes here.
      try {
        await call(['-X', 'DELETE', `${repo}/git/refs/heads/${branch}`]);
      } catch {
        // Already deleted, e.g. by the repo's auto-delete setting.
      }

      // "Closes #N" normally closes the issue; close it explicitly if the PR body lacked it.
      if ((await getIssue(n)).state !== 'closed') {
        await comment(n, `Merged in #${pr.number}.`);
        await call(['-X', 'PATCH', `${repo}/issues/${n}`, '-f', 'state=closed']);
      }
      await unblockDependents();
      out(`PR #${pr.number} merged; issue #${n} closed.`);
      return true;
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
