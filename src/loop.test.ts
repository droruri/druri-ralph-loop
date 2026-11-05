import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import { saveConfig } from './config.ts';
import { exists } from './fs.ts';
import { fakeGh } from './gh.fake.ts';
import { git, gitRepo } from './git.fake.ts';
import { run, type RunOptions } from './loop.ts';

const FAKES = resolve(import.meta.dirname, '../test/fakes');
const R = 'repos/acme/app';
const NOW = Date.UTC(2026, 10, 5, 10, 0, 0);
const LOCK = 'ralph%3Arunning';

let dir = '';
let root = '';
let claudeDir = '';
let home = '';
let out: string[] = [];
let sleeps: number[] = [];

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: { name: string }[];
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ralph-loop-'));
  root = await gitRepo(dir);
  claudeDir = join(dir, 'claude');
  home = join(dir, 'home');
  await mkdir(claudeDir);
  await mkdir(home);
  await saveConfig(root, { repo: 'acme/app' });
  out = [];
  sleeps = [];
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const wtPath = (n: number) => join(root, '.ralph/wt', `issue-${n}`);
const closedMarker = (n: number) => join(wtPath(n), 'closed-by-claude');

/** A GitHub with these issues; an issue closes once a fake claude run touches its marker file. */
function github(...issues: FakeIssue[]) {
  const gh = fakeGh();
  const sync = (issue: FakeIssue) => {
    if (existsSync(closedMarker(issue.number))) issue.state = 'closed';
    return issue;
  };
  gh.on(`GET ${R}/issues`, () => issues.map(sync).filter((i) => i.state === 'open'));
  gh.on(`GET ${R}/pulls`, []);
  for (const issue of issues) {
    const n = issue.number;
    gh.on(`GET ${R}/issues/${n}`, () => sync(issue));
    gh.on(`GET ${R}/issues/${n}/comments`, []);
    gh.on(`POST ${R}/issues/${n}/labels`, () => {
      issue.labels.push({ name: 'ralph:running' });
      return '[]';
    });
    gh.on(`DELETE ${R}/issues/${n}/labels/${LOCK}`, () => {
      issue.labels = issue.labels.filter((l) => l.name !== 'ralph:running');
      return '[]';
    });
    gh.on(`PATCH ${R}/issues/${n}`, () => {
      issue.state = 'closed';
      return '{}';
    });
  }
  return gh;
}

const issue = (number: number, extra: Partial<FakeIssue> = {}): FakeIssue => ({
  number,
  title: `Issue ${number}`,
  body: 'Do it.\n- [ ] works',
  state: 'open',
  labels: [{ name: 'ready-for-agent' }],
  ...extra,
});

/** Side effects of fake claude run `k`, a shell script run in the worktree. */
const onClaude = (k: number, script: string) => writeFile(join(claudeDir, `${k}.sh`), script);
const progress = (n: number, text: string) =>
  `mkdir -p logs && printf '%s\\n' '${text}' > logs/issue-${n}.progress.md\n`;
const close = (n: number) => `touch ${closedMarker(n)}\n`;
const stream = (k: number, lines: unknown[]) =>
  writeFile(
    join(claudeDir, `${k}.jsonl`),
    lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n',
  );

async function calls(): Promise<string[]> {
  try {
    return (await readFile(join(claudeDir, 'calls'), 'utf8')).trim().split('\n');
  } catch {
    return [];
  }
}

function ralph(gh: ReturnType<typeof fakeGh>, opts: Partial<RunOptions> = {}) {
  return run({
    root,
    gh: gh.gh,
    home,
    env: {
      ...process.env,
      PATH: `${FAKES}${delimiter}${process.env.PATH ?? ''}`,
      FAKE_CLAUDE_DIR: claudeDir,
      ANTHROPIC_API_KEY: 'sk-should-be-dropped',
    },
    log: (line) => out.push(line),
    err: (line) => out.push(line),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => NOW,
    ...opts,
  });
}

describe('ralph run <N>', () => {
  test('runs build, review and merge, closes the issue and removes the worktree', async () => {
    const gh = github(issue(4));
    await onClaude(1, progress(4, 'next: step 8'));
    await onClaude(3, close(4));
    expect(await ralph(gh, { issue: 4 })).toBe(0);

    expect(await calls()).toEqual([
      'sonnet build key=unset ci=true',
      'haiku review key=unset ci=true',
      'haiku merge key=unset ci=true',
    ]);
    expect(await exists(wtPath(4))).toBe(false);
    expect(git(root, 'branch', '--list', 'feature/issue-4')).toBe('');
    expect(gh.writes()).toContain(`POST ${R}/labels`);
    expect(gh.writes()).toContain(`POST ${R}/issues/4/labels`);
    expect(gh.writes().at(-1)).toBe(`DELETE ${R}/issues/4/labels/${LOCK}`);
    expect(out).toContain('\n---> Issue #4 closed.');
  });

  test('passes the config-derived flags and the rendered prompt to claude', async () => {
    await saveConfig(root, {
      repo: 'acme/app',
      subagents: { reviewer: { type: 'caveman:cavecrew-reviewer' } },
      skills: { tdd: 'mattpocock-skills:tdd' },
      plugins: ['extra@market'],
    });
    await mkdir(join(home, '.claude/plugins'), { recursive: true });
    await writeFile(
      join(home, '.claude/plugins/installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'caveman@caveman': [{ installPath: '/x' }],
          'mattpocock-skills@claude-plugins-official': [{ installPath: '/y' }],
        },
      }),
    );
    await onClaude(1, close(4));
    expect(await ralph(github(issue(4)), { issue: 4 })).toBe(0);

    const args = (await readFile(join(claudeDir, '1.args'), 'utf8')).split('\n');
    expect(args.slice(0, 15)).toEqual([
      '--model',
      'sonnet',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--tools',
      'Bash,Read,Edit,Write,Skill,Agent',
      '--setting-sources',
      'project',
      '--settings',
      JSON.stringify({
        disableAllHooks: true,
        enabledPlugins: {
          'caveman@caveman': true,
          'extra@market': true,
          'mattpocock-skills@claude-plugins-official': true,
        },
      }),
      '--dangerously-skip-permissions',
      '--verbose',
      '--print',
      '--output-format',
    ]);
    expect(args.slice(15, 17).join('\n')).toMatch(/^stream-json\n# Ralph Task/);
    expect(args.join('\n')).toContain('ISSUE TITLE: Issue 4');
  });

  test('skips review when build already reviewed a small diff (next: step 10)', async () => {
    await onClaude(1, progress(4, 'step: 9\nnext: step 10'));
    await onClaude(2, close(4));
    expect(await ralph(github(issue(4)), { issue: 4 })).toBe(0);
    expect(await calls()).toEqual([
      'sonnet build key=unset ci=true',
      'haiku merge key=unset ci=true',
    ]);
    expect(out).toContain('--- Issue #4: review already done in build, skipping ---');
  });

  test('a successful ralph merge runs no merge-phase claude', async () => {
    const gh = github(issue(4));
    gh.on(`GET ${R}/pulls`, [{ number: 12, head: { sha: 'abc' } }]);
    gh.on(`GET ${R}/commits/abc/check-runs`, {
      check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
    });
    gh.on(`GET ${R}/commits/abc/status`, { state: 'pending', total_count: 0, statuses: [] });
    expect(await ralph(gh, { issue: 4 })).toBe(0);
    expect(await calls()).toEqual([
      'sonnet build key=unset ci=true',
      'haiku review key=unset ci=true',
    ]);
    expect(gh.writes()).toContain(`PUT ${R}/pulls/12/merge`);
    expect(await exists(wtPath(4))).toBe(false);
  });

  test('waits out a usage limit with the injected sleep, then resumes the phase', async () => {
    const resetsAt = NOW / 1000 + 600;
    await stream(1, [
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt } },
      { type: 'result', num_turns: 2, total_cost_usd: 0.5, duration_ms: 3000, is_error: true },
    ]);
    await onClaude(2, close(4));
    expect(await ralph(github(issue(4)), { issue: 4 })).toBe(0);
    expect(sleeps).toEqual([660_000]);
    expect(await calls()).toEqual([
      'sonnet build key=unset ci=true',
      'sonnet build key=unset ci=true',
    ]);
    expect(out).toContain(
      '--- Usage limit reached. Sleeping 11 min until it resets, then resuming phase build. ---',
    );
  });

  test('gives up on a phase after 3 usage-limit waits', async () => {
    const limited = {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected' as const, resetsAt: 1 },
    };
    for (const k of [1, 2, 3, 4]) await stream(k, [limited]);
    await onClaude(4, close(4));
    expect(await ralph(github(issue(4)), { issue: 4 })).toBe(0);
    expect(sleeps).toEqual([60_000, 60_000, 60_000]);
    expect(out).toContain('--- Still rate-limited after 3 waits. Giving up on phase build. ---');
  });

  test('an issue still open after all phases gets one more pass on opus', async () => {
    await onClaude(4, close(4));
    expect(await ralph(github(issue(4)), { issue: 4 })).toBe(0);
    expect((await calls()).map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual([
      'sonnet build',
      'haiku review',
      'haiku merge',
      'opus build',
    ]);
  });

  test('--model opus runs build on opus and skips the escalation pass', async () => {
    expect(await ralph(github(issue(4)), { issue: 4, model: 'opus' })).toBe(1);
    expect((await calls()).map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual([
      'opus build',
      'haiku review',
      'haiku merge',
    ]);
  });

  test('still open: exits 1, keeps the worktree and prints the progress file', async () => {
    await saveConfig(root, { repo: 'acme/app', models: { escalation: false } });
    await onClaude(1, progress(4, 'next: step 8 (stuck)'));
    const gh = github(issue(4));
    expect(await ralph(gh, { issue: 4 })).toBe(1);
    expect(await calls()).toHaveLength(3);
    expect(await exists(wtPath(4))).toBe(true);
    expect(out).toContain('next: step 8 (stuck)');
    expect(out).toContain(`Worktree kept at ${wtPath(4)}.`);
    expect(gh.writes().at(-1)).toBe(`DELETE ${R}/issues/4/labels/${LOCK}`);
  });

  test('an issue another run holds is not touched', async () => {
    const gh = github(issue(4, { labels: [{ name: 'ralph:running' }] }));
    expect(await ralph(gh, { issue: 4 })).toBe(1);
    expect(await calls()).toEqual([]);
    expect(gh.writes()).toEqual([`POST ${R}/labels`]);
    expect(out.join('\n')).toContain('has the ralph:running label');
  });

  test('a closed issue exits 0 and a needs-human one exits 1, with no claude run', async () => {
    expect(await ralph(github(issue(4, { state: 'closed' })), { issue: 4 })).toBe(0);
    const stuck = github(issue(5, { labels: [{ name: 'needs-human' }] }));
    expect(await ralph(stuck, { issue: 5 })).toBe(1);
    expect(await calls()).toEqual([]);
    expect(out).toEqual([
      'Issue #4 is closed. Nothing to run.',
      'Issue #5 is needs-human. Nothing to run.',
    ]);
  });

  test('writes the raw log, a ledger row per run and skips non-JSON lines', async () => {
    await stream(1, [
      'warning: not json',
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Planning.' }] } },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
      },
      '{"type":"assistant","message":42}',
      { type: 'result', num_turns: 3, total_cost_usd: 0.25, duration_ms: 1500, is_error: false },
      { type: 'result', num_turns: 2, total_cost_usd: 0.4, duration_ms: 2600, is_error: false },
    ]);
    await onClaude(1, close(4));
    expect(await ralph(github(issue(4)), { issue: 4 })).toBe(0);

    expect(out).toContain('Planning.');
    expect(out).toContain('  → Bash {"command":"ls"}');
    expect(out).toContain('--- phase done: 5 turns, $0.4, 4s ---');
    const log = await readFile(join(root, '.ralph/logs/issue-4.build.log'), 'utf8');
    expect(log).toContain('warning: not json\n');
    const ledger = await readFile(join(root, '.ralph/logs/ralph-costs.tsv'), 'utf8');
    expect(ledger).toBe(
      'date\tissue\tphase\tmodel\tturns\tcost_usd\tseconds\terror\n' +
        '2026-11-05T10:00:00Z\t4\tbuild\tsonnet\t5\t0.4\t4\tfalse\n',
    );
  });

  test('Ctrl-C stops the run and removes the lock label', async () => {
    const controller = new AbortController();
    const gh = github(issue(4));
    gh.on(`GET ${R}/issues/4/comments`, () => {
      controller.abort();
      return [];
    });
    expect(await ralph(gh, { issue: 4, signal: controller.signal })).toBe(130);
    expect(await calls()).toEqual([]);
    expect(gh.writes().at(-1)).toBe(`DELETE ${R}/issues/4/labels/${LOCK}`);
  });

  test('loads .env but never passes ANTHROPIC_API_KEY to claude', async () => {
    await writeFile(join(root, '.env'), 'ANTHROPIC_API_KEY=sk-from-env\nCI=false\n');
    await onClaude(1, close(4));
    expect(await ralph(github(issue(4)), { issue: 4 })).toBe(0);
    expect(await calls()).toEqual(['sonnet build key=unset ci=true']);
  });

  test('logs go to the main checkout when run from inside a worktree', async () => {
    git(root, 'worktree', 'add', '--quiet', '-b', 'other', join(root, '.ralph/wt/other'));
    await saveConfig(join(root, '.ralph/wt/other'), { repo: 'acme/app' });
    await onClaude(1, close(4));
    expect(await ralph(github(issue(4)), { issue: 4, root: join(root, '.ralph/wt/other') })).toBe(
      0,
    );
    expect(await exists(join(root, '.ralph/logs/ralph-costs.tsv'))).toBe(true);
  });
});

describe('ralph run', () => {
  test('works through the queue, then stops when nothing is left', async () => {
    await onClaude(1, close(3));
    await onClaude(2, close(5));
    const gh = github(issue(3), issue(5, { body: '## Blocked by\n- #3' }));
    expect(await ralph(gh)).toBe(0);
    expect((await calls()).map((c) => c.split(' ')[1])).toEqual(['build', 'build']);
    expect(sleeps).toEqual([5000, 5000]);
    expect(out).toContain('No more unblocked issues found. Ralph Loop finished!');
  });

  test('stops at an issue still open after all phases', async () => {
    await saveConfig(root, { repo: 'acme/app', models: { escalation: false } });
    expect(await ralph(github(issue(3), issue(5)))).toBe(1);
    expect((await calls()).map((c) => c.split(' ')[1])).toEqual(['build', 'review', 'merge']);
  });
});
