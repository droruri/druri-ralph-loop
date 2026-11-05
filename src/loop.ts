// `ralph run [N]`: the loop engine. Each issue runs in its own worktree as up to three phases
// (build, review, merge), each a fresh `claude` process; the progress comment on the issue is the
// hand-off between phases and machines. Ported from notes-organizer's run-ralph.sh.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { pluginIds } from './agents.ts';
import { loadConfig, type Phase } from './config.ts';
import { exists, isNotFound } from './fs.ts';
import { createTracker, type Gh, ghCli, type Issue, type IssueState } from './github.ts';
import { renderPrompt } from './prompt.ts';
import { createWorktree, removeWorktree } from './worktree.ts';

export const LOGS_DIR = '.ralph/logs';
const LEDGER_HEADER = 'date\tissue\tphase\tmodel\tturns\tcost_usd\tseconds\terror\n';
const TOOLS = 'Bash,Read,Edit,Write,Skill,Agent';
const ESCALATION_MODEL = 'opus';
const USAGE_LIMIT_WAITS = 3;

export interface RunOptions {
  /** The project root holding `.ralph/`. */
  root: string;
  /** Run only this issue; unset works through the queue. */
  issue?: number | undefined;
  /** Overrides `models.build` for this run. */
  model?: string | undefined;
  /** Runner for `gh`; the real binary (with the run's environment) when unset. */
  gh?: Gh | undefined;
  /** Base environment; `.env` is loaded on top of it. */
  env: NodeJS.ProcessEnv;
  /** Home directory holding the user's installed Claude Code plugins. */
  home: string;
  log: (line: string) => void;
  err: (line: string) => void;
  /** Usage-limit waits, the CI wait and the pause between issues; tests pass a recorder. */
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** Ctrl-C: stops claude, removes the lock label and makes run resolve with 130. */
  signal?: AbortSignal;
}

// One stream-json event; anything else (stderr, other event types) is skipped like `fromjson?`.
const Assistant = z.object({
  type: z.literal('assistant'),
  message: z.object({ content: z.array(z.unknown()) }),
});
const Text = z.object({ type: z.literal('text'), text: z.string() });
const ToolUse = z.object({ type: z.literal('tool_use'), name: z.string(), input: z.unknown() });
const Result = z.object({
  type: z.literal('result'),
  num_turns: z.number().nullish(),
  total_cost_usd: z.number().nullish(),
  duration_ms: z.number().nullish(),
  is_error: z.boolean().nullish(),
});
const RateLimit = z.object({
  type: z.literal('rate_limit_event'),
  rate_limit_info: z.object({ status: z.string(), resetsAt: z.number().nullish() }),
});
const StreamEvent = z.union([Assistant, Result, RateLimit]);
type StreamEvent = z.output<typeof StreamEvent>;

function parseLine(line: string): StreamEvent | undefined {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return undefined;
  }
  const event = StreamEvent.safeParse(data);
  return event.success ? event.data : undefined;
}

/** The terminal summary of one event: text and tool calls. */
function summary(event: StreamEvent): string[] {
  if (event.type !== 'assistant') return [];
  return event.message.content.flatMap((block) => {
    const text = Text.safeParse(block);
    if (text.success) return [text.data.text];
    const tool = ToolUse.safeParse(block);
    if (!tool.success) return [];
    return [`  → ${tool.data.name} ${(JSON.stringify(tool.data.input) ?? 'null').slice(0, 150)}`];
  });
}

/** The run's environment: `.env` loaded, no API key, nothing that waits for input. */
export async function runEnv(root: string, base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const env = { ...base };
  try {
    Object.assign(env, parseEnv(await readFile(join(root, '.env'), 'utf8')));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  // Use the claude.ai login, never an API key: a stray key bills API credits instead.
  delete env.ANTHROPIC_API_KEY;
  // A command that would prompt (git credentials, a watch mode) fails at once instead of hanging.
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GH_PROMPT_DISABLED: '1',
    CI: 'true',
  };
}

class Interrupted extends Error {}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Runs the loop; resolves with the exit code (0 done, 1 stopped on an issue, 130 interrupted). */
export async function run(opts: RunOptions): Promise<number> {
  const { root, log, err, signal } = opts;
  const sleep = opts.sleep ?? ((ms: number) => delay(ms, undefined, { signal }));
  const now = opts.now ?? Date.now;
  const config = await loadConfig(root);
  const env = await runEnv(root, opts.env);
  const tracker = createTracker(config, opts.gh ?? ghCli(env), log);
  const logsDir = join(root, LOGS_DIR);
  const ledger = join(logsDir, 'ralph-costs.tsv');
  const buildModel = opts.model ?? config.models.build;

  const plugins = await pluginIds(config, opts.home);
  if (plugins.missing.length > 0) {
    err(`warn: plugins not installed, not enabled: ${plugins.missing.join(', ')}`);
  }
  const settings = JSON.stringify({
    disableAllHooks: true,
    enabledPlugins: Object.fromEntries(plugins.ids.map((id) => [id, true])),
  });

  const checkAbort = () => {
    if (signal?.aborted === true) throw new Interrupted();
  };

  /** One fresh claude run for one phase; resolves with the usage-limit reset time (0: none). */
  async function runClaude(issue: Issue, wt: string, phase: Phase, model: string) {
    const n = issue.number;
    const logFile = join(logsDir, `issue-${n}.${phase}.log`);
    log(`\n--- Issue #${n}: phase ${phase} on ${model} (log: ${logFile}) ---`);
    const prompt = await renderPrompt(phase, issue, config, root);
    checkAbort();
    const args = [
      '--model',
      model,
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--tools',
      TOOLS,
      '--setting-sources',
      'project',
      '--settings',
      settings,
      '--dangerously-skip-permissions',
      '--verbose',
      '--print',
      '--output-format',
      'stream-json',
      prompt,
    ];
    const child = spawn('claude', args, {
      cwd: wt,
      env: {
        ...env,
        CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
        CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });
    const raw = createWriteStream(logFile);
    const results: z.output<typeof Result>[] = [];
    let resetsAt = 0;
    const onLine = (line: string) => {
      raw.write(`${line}\n`);
      const event = parseLine(line);
      if (event === undefined) return;
      if (event.type === 'result') results.push(event);
      else if (event.type === 'rate_limit_event') {
        if (event.rate_limit_info.status === 'rejected') {
          resetsAt = event.rate_limit_info.resetsAt ?? 0;
        }
      } else for (const text of summary(event)) log(text);
    };
    // stdout and stderr both go to the log, like `2>&1 | tee`.
    const readers = [child.stdout, child.stderr].map((stream) => {
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      lines.on('line', onLine);
      return new Promise<void>((resolve) => lines.on('close', resolve));
    });
    await new Promise<void>((resolve) => {
      child.on('close', () => resolve());
      child.on('error', (error) => {
        // A failed claude run is not fatal (`|| true`); the phase checks below decide.
        if (signal?.aborted !== true) err(`claude failed: ${error.message}`);
        resolve();
      });
    });
    await Promise.all(readers);
    await new Promise<void>((resolve) => raw.end(resolve));
    checkAbort();

    // A phase log can hold several claude sessions: turns and time sum over all of them, cost is
    // the final cumulative value.
    const last = results.at(-1);
    let cost = 0;
    if (last !== undefined) {
      const turns = results.reduce((sum, r) => sum + (r.num_turns ?? 0), 0);
      cost = last.total_cost_usd ?? 0;
      const ms = results.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0);
      const seconds = Math.floor(ms / 1000);
      const date = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const error = last.is_error ?? '';
      await appendFile(
        ledger,
        `${[date, n, phase, model, turns, cost, seconds, error].join('\t')}\n`,
      );
      log(`--- phase done: ${turns} turns, $${round2(cost)}, ${seconds}s ---`);
    }
    return { resetsAt, cost };
  }

  /** runClaude, waiting out up to 3 usage limits; the progress comment syncs around each run. */
  async function runPhase(issue: Issue, wt: string, phase: Phase, model: string) {
    let cost = 0;
    for (let attempt = 0; attempt <= USAGE_LIMIT_WAITS; attempt++) {
      await tracker.progressPull(issue.number, wt);
      checkAbort();
      const result = await runClaude(issue, wt, phase, model);
      cost += result.cost;
      await tracker.progressPush(issue.number, wt);
      if (result.resetsAt === 0) return cost;
      if (attempt === USAGE_LIMIT_WAITS) break;
      const wait = Math.max(60, Math.round(result.resetsAt - now() / 1000 + 60));
      log(
        `--- Usage limit reached. Sleeping ${Math.floor(wait / 60)} min until it resets, then resuming phase ${phase}. ---`,
      );
      await sleep(wait * 1000);
      checkAbort();
    }
    log(
      `--- Still rate-limited after ${USAGE_LIMIT_WAITS} waits. Giving up on phase ${phase}. ---`,
    );
    return cost;
  }

  const progressFile = (wt: string, n: number) => join(wt, 'logs', `issue-${n}.progress.md`);
  async function readProgress(wt: string, n: number): Promise<string | undefined> {
    try {
      return await readFile(progressFile(wt, n), 'utf8');
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  /** The configured phases for one issue, stopping when it leaves "open"; resolves with the cost. */
  async function runPhases(issue: Issue, wt: string, model: string) {
    const n = issue.number;
    let cost = 0;
    for (const phase of config.phases) {
      // A small diff is reviewed inside the build phase, which then hands off `next: step 10`.
      if (phase === 'review' && /^next: step 10/m.test((await readProgress(wt, n)) ?? '')) {
        log(`--- Issue #${n}: review already done in build, skipping ---`);
        continue;
      }
      // Waiting for CI and merging needs no LLM; claude runs the merge phase only when that fails.
      if (phase === 'merge' && (await tracker.merge(n, { sleep }))) break;
      checkAbort();
      // Only build needs the strong model; review and merge relay findings and run commands.
      cost += await runPhase(issue, wt, phase, phase === 'build' ? model : config.models[phase]);
      if ((await tracker.issueState(n)) !== 'open') break;
    }
    return cost;
  }

  /** Locks issue `issue`, runs it in its worktree and resolves with its final state. */
  async function runIssue(issue: Issue): Promise<IssueState> {
    const n = issue.number;
    log(`Processing Issue #${n}: ${issue.title}`);
    await tracker.lock(n);
    let state: IssueState;
    let wt: string;
    let cost = 0;
    try {
      wt = await createWorktree(root, n, { install: config.commands.install, env, log: err });
      cost += await runPhases(issue, wt, buildModel);
      if (
        config.models.escalation &&
        buildModel !== ESCALATION_MODEL &&
        (await tracker.issueState(n)) === 'open'
      ) {
        log(
          `\n--- Issue #${n} still open after all phases on ${buildModel}. One more pass on ${ESCALATION_MODEL}. ---`,
        );
        cost += await runPhases(issue, wt, ESCALATION_MODEL);
      }
      state = await tracker.issueState(n);
    } finally {
      await tracker.unlock(n);
    }
    log(`\n--- Issue #${n}: total cost $${round2(cost)} (ledger: ${ledger}) ---`);

    if (state === 'closed') {
      await removeWorktree(root, n);
    } else {
      // Keep the worktree so a human can inspect it.
      const progress = await readProgress(wt, n);
      if (progress !== undefined) {
        log(`\n--- Progress for Issue #${n} ---`);
        log(progress.replace(/\n$/, ''));
        log('---');
      }
      log(`Worktree kept at ${wt}.`);
    }
    return state;
  }

  async function loop(): Promise<number> {
    await mkdir(logsDir, { recursive: true });
    if (!(await exists(ledger))) await writeFile(ledger, LEDGER_HEADER);
    await tracker.ensureLockLabel();

    for (;;) {
      let issue: Issue | undefined;
      if (opts.issue !== undefined) {
        const n = opts.issue;
        // Don't start on a closed issue, one a human has to look at first, or one another run holds.
        const start = await tracker.issueState(n);
        if (start !== 'open') {
          log(`Issue #${n} is ${start}. Nothing to run.`);
          return start === 'closed' ? 0 : 1;
        }
        if (await tracker.isLocked(n)) {
          log(
            `Issue #${n} has the ${config.labels.lock} label: another ralph run is on it. Remove the label if that run died.`,
          );
          return 1;
        }
        issue = await tracker.getIssue(n);
      } else {
        log('\n==========================================');
        log('=== Fetching next unblocked issue ===');
        log('==========================================');
        issue = await tracker.nextIssue();
        if (issue === undefined) {
          log('No more unblocked issues found. Ralph Loop finished!');
          return 0;
        }
      }

      const n = issue.number;
      const state = await runIssue(issue);
      // Stop instead of re-running the same issue forever if the run ended without closing it.
      if (state === 'open') {
        log(
          `Issue #${n} is still open after all phases. Stopping so you can check ${join(logsDir, `issue-${n}.*.log`)}.`,
        );
        return 1;
      }
      if (opts.issue !== undefined) {
        log(`\n---> Issue #${n} ${state}.`);
        return 0;
      }
      log(`\n---> Issue #${n} ${state}! Moving to next issue in 5 seconds...\n`);
      await sleep(5000);
      checkAbort();
    }
  }

  try {
    return await loop();
  } catch (error) {
    if (signal?.aborted === true) {
      err('Interrupted.');
      return 130;
    }
    throw error;
  }
}
