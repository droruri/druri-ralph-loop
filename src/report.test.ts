import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import { saveConfig } from './config.ts';
import { fakeGh } from './gh.fake.ts';
import { GhError } from './github.ts';
import { redact, redactText, report } from './report.ts';

let root = '';
let gh = fakeGh();
const events: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ralph-report-'));
  events.length = 0;
  gh = fakeGh({
    'GET user': { login: 'someone' },
    'POST repos/droruri/druri-ralph-loop/issues': {
      number: 42,
      html_url: 'https://github.com/droruri/druri-ralph-loop/issues/42',
    },
  });
  await saveConfig(root, { repo: 'acme/secret-app', models: { build: 'opus' } });
});
afterEach(() => rm(root, { recursive: true, force: true }));

/** Runs `report` answering the prompts in order; records logs and questions in `events`. */
function run(answers: string[], attachLog = false) {
  const queue = [...answers];
  return report({
    root,
    attachLog,
    gh: gh.gh,
    ask: async (q) => {
      events.push(`ask: ${q}`);
      return queue.shift() ?? '';
    },
    log: (line) => events.push(`log: ${line}`),
    claudeVersion: async () => '2.0.0 (Claude Code)',
  });
}

const sentBody = () => gh.calls.find((c) => c.method === 'POST')?.fields.body?.[0] ?? '';

describe('report', () => {
  test('on confirm, creates one from-cli issue with the environment and redacted config', async () => {
    expect(await run(['It breaks', 'Steps here', 'y'])).toBe(true);
    expect(gh.writes()).toEqual(['POST repos/droruri/druri-ralph-loop/issues']);
    const post = gh.calls.find((c) => c.method === 'POST');
    expect(post?.fields.title).toEqual(['It breaks']);
    expect(post?.fields['labels[]']).toEqual(['from-cli']);
    const body = sentBody();
    expect(body).toContain('Steps here');
    expect(body).toMatch(/ralph: \d+\.\d+\.\d+/);
    expect(body).toContain(`OS: ${process.platform}`);
    expect(body).toContain('claude: 2.0.0 (Claude Code)');
    expect(body).toContain('"build": "opus"');
    expect(body).not.toContain('acme/secret-app');
    expect(events).toContain('log: https://github.com/droruri/druri-ralph-loop/issues/42');
  });

  test('shows the full body before asking to confirm', async () => {
    await run(['It breaks', 'Steps here', 'y']);
    const preview = events.findIndex((e) => e.startsWith('log: ') && e.includes('Steps here'));
    const confirm = events.findIndex((e) => e.includes('[y/N]'));
    expect(preview).toBeGreaterThan(-1);
    expect(preview).toBeLessThan(confirm);
    expect(events[preview]).toBe(`log: ${sentBody()}`);
  });

  test.each(['n', ''])('declining (%j) sends nothing', async (answer) => {
    expect(await run(['It breaks', 'Steps here', answer])).toBe(true);
    expect(gh.writes()).toEqual([]);
    expect(events).toContain('log: Nothing sent.');
  });

  test('an empty title sends nothing', async () => {
    expect(await run(['  '])).toBe(false);
    expect(gh.writes()).toEqual([]);
  });

  test('without --attach-log, no log content is in the body', async () => {
    await mkdir(join(root, '.ralph/logs'));
    await writeFile(join(root, '.ralph/logs/run.log'), 'LOG-LINE-SECRET\n');
    await run(['t', 'd', 'y']);
    expect(sentBody()).not.toContain('LOG-LINE-SECRET');
  });

  test('--attach-log adds the tail of the newest log only', async () => {
    await mkdir(join(root, '.ralph/logs'));
    const old = join(root, '.ralph/logs/old.log');
    await writeFile(old, 'OLD-LOG\n');
    await utimes(old, 1000, 1000);
    const lines = Array.from({ length: 150 }, (_, i) => `line ${i}`).join('\n');
    await writeFile(join(root, '.ralph/logs/new.log'), `${lines}\n`);
    await run(['t', 'd', 'y'], true);
    const body = sentBody();
    expect(body).toContain('new.log');
    expect(body).toContain('line 149');
    expect(body).not.toContain('line 49\n');
    expect(body).not.toContain('OLD-LOG');
  });

  test('--attach-log redacts the log and keeps it inside its fence', async () => {
    await mkdir(join(root, '.ralph/logs'));
    await writeFile(join(root, '.ralph/logs/run.log'), 'DB_PASSWORD=hunter2\n```\n@someone\n');
    await run(['t', 'd', 'y'], true);
    const body = sentBody();
    expect(body).not.toContain('hunter2');
    expect(body).toContain('````text\nDB_PASSWORD=[redacted]\n```\n@someone\n````');
  });

  test('--attach-log without logs says so', async () => {
    await run(['t', 'd', 'y'], true);
    expect(sentBody()).toContain('(no log in .ralph/logs)');
  });

  test('a missing config is still reported', async () => {
    await rm(join(root, '.ralph'), { recursive: true });
    await run(['t', 'd', 'y']);
    expect(sentBody()).toContain('not found');
  });

  test('unauthenticated gh says to run gh auth login and asks nothing', async () => {
    gh.on('GET user', new Error('To get started with GitHub CLI, please run:  gh auth login'));
    await expect(run(['t', 'd', 'y'])).rejects.toThrow(GhError);
    await expect(run(['t', 'd', 'y'])).rejects.toThrow(/gh auth login/);
    expect(gh.writes()).toEqual([]);
    expect(events.filter((e) => e.startsWith('ask: '))).toEqual([]);
  });
});

describe('redact', () => {
  test('hides secret assignments and URL credentials in text', () => {
    expect(redactText('NPM_TOKEN=abc npm ci; curl https://me:pw@host/x; ok=1')).toBe(
      'NPM_TOKEN=[redacted] npm ci; curl https://[redacted]@host/x; ok=1',
    );
  });

  test('hides repo, secret-named keys and token-looking values; keeps the rest', () => {
    const raw = {
      repo: 'acme/app',
      models: { build: 'sonnet' },
      labels: { lock: 'ralph-lock' },
      env: { GITHUB_TOKEN: 'abc', apiKey: 'x', nested: [{ password: 'p' }] },
      commands: {
        check: 'pnpm test',
        install: 'curl -H ghp_abcdefghijklmnopqrstuvwxyz0123456789 x',
        other: 'sk-proj-abc123',
        hex: '0123456789abcdef0123456789abcdef01234567',
      },
    };
    expect(redact(raw)).toEqual({
      repo: '[redacted]',
      models: { build: 'sonnet' },
      labels: { lock: 'ralph-lock' },
      env: {
        GITHUB_TOKEN: '[redacted]',
        apiKey: '[redacted]',
        nested: [{ password: '[redacted]' }],
      },
      commands: {
        check: 'pnpm test',
        install: 'curl -H [redacted] x',
        other: '[redacted]',
        hex: '[redacted]',
      },
    });
  });
});
