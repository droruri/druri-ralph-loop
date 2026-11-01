import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import { parseConfig, type Config } from './config.ts';
import { fakeGh } from './gh.fake.ts';
import { blockedBy, createTracker, GhError, ghCli } from './github.ts';

function config(raw: Record<string, unknown> = {}): Config {
  const result = parseConfig({ repo: 'acme/app', ...raw });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.config;
}

const R = 'repos/acme/app';

interface IssueSpec {
  number: number;
  labels?: string[];
  body?: string | null;
  state?: 'open' | 'closed';
  pr?: boolean;
}

function issue({ number, labels = [], body = '', state = 'open', pr = false }: IssueSpec) {
  return {
    number,
    title: `Issue ${number}`,
    body,
    state,
    labels: labels.map((name) => ({ name })),
    ...(pr ? { pull_request: { url: 'x' } } : {}),
  };
}

describe('issueState', () => {
  test.each([
    [{ state: 'closed' as const, labels: ['needs-human'] }, 'closed'],
    [{ labels: ['blocked', 'needs-human'] }, 'needs-human'],
    [{ labels: ['blocked'] }, 'blocked'],
    [{ labels: ['other'] }, 'open'],
  ])('%o is %s', async (spec, expected) => {
    const fake = fakeGh({ [`GET ${R}/issues/7`]: issue({ number: 7, ...spec }) });
    expect(await createTracker(config(), fake.gh).issueState(7)).toBe(expected);
  });

  test('uses the label names from config', async () => {
    const fake = fakeGh({ [`GET ${R}/issues/7`]: issue({ number: 7, labels: ['stuck'] }) });
    const tracker = createTracker(config({ labels: { blocked: 'stuck' } }), fake.gh);
    expect(await tracker.issueState(7)).toBe('blocked');
  });

  test('a malformed response fails with a clear error', async () => {
    const fake = fakeGh({ [`GET ${R}/issues/7`]: { number: 'seven' } });
    await expect(createTracker(config(), fake.gh).issueState(7)).rejects.toThrow(
      /unexpected response from gh api repos\/acme\/app\/issues\/7/,
    );
  });

  test('non-JSON output fails with a clear error', async () => {
    const fake = fakeGh({ [`GET ${R}/issues/7`]: 'not json' });
    await expect(createTracker(config(), fake.gh).issueState(7)).rejects.toThrow(/not JSON/);
  });
});

describe('lock', () => {
  test('isLocked reads the lock label; lock and unlock add and remove it', async () => {
    const fake = fakeGh({ [`GET ${R}/issues/7`]: issue({ number: 7, labels: ['ralph:running'] }) });
    const tracker = createTracker(config(), fake.gh);
    expect(await tracker.isLocked(7)).toBe(true);
    await tracker.lock(7);
    await tracker.unlock(7);
    expect(fake.writes()).toEqual([
      `POST ${R}/issues/7/labels`,
      `DELETE ${R}/issues/7/labels/ralph%3Arunning`,
    ]);
    expect(fake.calls[1]?.fields).toEqual({ 'labels[]': ['ralph:running'] });
  });

  test('unlock ignores a failure', async () => {
    const fake = fakeGh({ [`DELETE ${R}/issues/7/labels/ralph%3Arunning`]: new Error('404') });
    await createTracker(config(), fake.gh).unlock(7);
  });
});

describe('nextIssue', () => {
  const open = (issues: IssueSpec[]) =>
    fakeGh({ [`GET ${R}/issues?state=open&per_page=100`]: issues.map(issue) });

  test('picks the oldest open issue with the pick label', async () => {
    const fake = open([
      { number: 5, labels: ['ready-for-agent'] },
      { number: 3, labels: ['ready-for-agent'] },
      { number: 2 },
    ]);
    expect((await createTracker(config(), fake.gh).nextIssue())?.number).toBe(3);
  });

  test('any open issue when the pick label is empty', async () => {
    const fake = open([{ number: 5 }, { number: 2 }]);
    const tracker = createTracker(config({ labels: { pickLabel: '' } }), fake.gh);
    expect((await tracker.nextIssue())?.number).toBe(2);
  });

  test('skips pull requests and blocked, needs-human or locked issues', async () => {
    const pick = 'ready-for-agent';
    const fake = open([
      { number: 1, labels: [pick], pr: true },
      { number: 2, labels: [pick, 'blocked'] },
      { number: 3, labels: [pick, 'needs-human'] },
      { number: 4, labels: [pick, 'ralph:running'] },
      { number: 9, labels: [pick] },
    ]);
    expect((await createTracker(config(), fake.gh).nextIssue())?.number).toBe(9);
  });

  test('skips an issue blocked by a still-open issue', async () => {
    const pick = 'ready-for-agent';
    const fake = open([
      { number: 4, labels: [pick], body: 'Text\n\n## Blocked by\n\n- #6\n- #1\n\n## Notes\n#8' },
      { number: 5, labels: [pick], body: '## Blocked by\n\n- #1 (closed)\n\n## Notes\n- #6' },
      { number: 6 },
    ]);
    expect((await createTracker(config(), fake.gh).nextIssue())?.number).toBe(5);
  });

  test('undefined when no issue qualifies', async () => {
    const fake = open([{ number: 2 }]);
    expect(await createTracker(config(), fake.gh).nextIssue()).toBeUndefined();
  });
});

describe('unblockDependents', () => {
  test('removes blocked only when every blocking issue is closed and a section exists', async () => {
    const fake = fakeGh({
      [`GET ${R}/issues?state=open&per_page=100`]: [
        issue({ number: 2 }),
        issue({ number: 3, labels: ['blocked'], body: '## Blocked by\n- #1\n---\nsee #2' }),
        issue({ number: 4, labels: ['blocked'], body: '## Blocked by\n- #1\n- #2' }),
        issue({ number: 5, labels: ['blocked'], body: 'No section, mentions #1' }),
        issue({ number: 6, labels: ['blocked'], body: null }),
        issue({ number: 7, body: '## Blocked by\n- #1' }),
      ],
    });
    const log: string[] = [];
    await createTracker(config(), fake.gh, (l) => log.push(l)).unblockDependents();
    expect(fake.writes()).toEqual([`DELETE ${R}/issues/3/labels/blocked`]);
    expect(log).toEqual(['Unblocking #3']);
  });
});

describe('blockedBy', () => {
  test.each([
    ['## Blocked by\n\n- #1\n- #12', [1, 12]],
    ['## Blocked by\n- #1\n## Next\n- #2', [1]],
    ['## Blocked by\n- #1\n---\n#2', [1]],
    ['## Blocked by\n\nNone', []],
    ['Mentions #1', undefined],
    [null, undefined],
  ])('%j -> %j', (body, expected) => {
    expect(blockedBy(body)).toEqual(expected);
  });
});

describe('progress', () => {
  let cwd = '';
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'ralph-progress-'));
  });
  afterEach(() => rm(cwd, { recursive: true, force: true }));

  const file = () => join(cwd, 'logs/issue-7.progress.md');
  const comments = `GET ${R}/issues/7/comments?per_page=100`;
  const body = '<!-- ralph-progress -->\n```text\nstep 3 done\nnext: step 4\n```';

  test('pull with no comment writes no file', async () => {
    const fake = fakeGh({ [comments]: [{ id: 1, body: 'hello' }] });
    await createTracker(config(), fake.gh).progressPull(7, cwd);
    await expect(readFile(file(), 'utf8')).rejects.toThrow(/ENOENT/);
  });

  test('pull writes the comment without the marker and fences', async () => {
    const fake = fakeGh({
      [comments]: [
        { id: 1, body: 'hello' },
        { id: 42, body },
      ],
      [`GET ${R}/issues/comments/42`]: { id: 42, body },
    });
    await createTracker(config(), fake.gh).progressPull(7, cwd);
    expect(await readFile(file(), 'utf8')).toBe('step 3 done\nnext: step 4\n');
  });

  test('push with no file does nothing', async () => {
    const fake = fakeGh();
    await createTracker(config(), fake.gh).progressPush(7, cwd);
    expect(fake.calls).toEqual([]);
  });

  test('push edits the existing comment and does not create a second one', async () => {
    const fake = fakeGh({ [comments]: [{ id: 42, body }] });
    await mkdir(join(cwd, 'logs'));
    await writeFile(file(), 'step 5 done\n');
    await createTracker(config(), fake.gh).progressPush(7, cwd);
    expect(fake.writes()).toEqual([`PATCH ${R}/issues/comments/42`]);
    expect(fake.calls[1]?.fields.body).toEqual([
      '<!-- ralph-progress -->\n```text\nstep 5 done\n```\n',
    ]);
  });

  test('push creates the comment when there is none', async () => {
    const fake = fakeGh({ [comments]: [] });
    await mkdir(join(cwd, 'logs'));
    await writeFile(file(), 'step 1 done\n');
    await createTracker(config(), fake.gh).progressPush(7, cwd);
    expect(fake.writes()).toEqual([`POST ${R}/issues/7/comments`]);
  });
});

describe('merge', () => {
  const PR = `GET ${R}/pulls?head=acme%3Afeature%2Fissue-7&state=open`;
  const green = { check_runs: [{ name: 'check', status: 'completed', conclusion: 'success' }] };
  const red = (...names: string[]) => ({
    check_runs: names.map((name) => ({ name, status: 'completed', conclusion: 'failure' })),
  });
  const noStatus = { state: 'pending', total_count: 0, statuses: [] };

  function setup(routes: Record<string, unknown> = {}) {
    const fake = fakeGh({
      [PR]: [{ number: 30, head: { sha: 'abc' } }],
      [`GET ${R}/commits/abc/check-runs?per_page=100`]: green,
      [`GET ${R}/commits/abc/status`]: noStatus,
      [`GET ${R}/issues/7`]: issue({ number: 7 }),
      [`GET ${R}/issues?state=open&per_page=100`]: [],
      ...routes,
    });
    const log: string[] = [];
    const tracker = createTracker(config({ merge: { method: 'rebase' } }), fake.gh, (l) =>
      log.push(l),
    );
    const merge = () => tracker.merge(7, { sleep: async () => {} });
    return { fake, log, merge };
  }

  test('no open PR needs the LLM phase', async () => {
    const { log, merge } = setup({ [PR]: [] });
    expect(await merge()).toBe(false);
    expect(log).toEqual(['No open PR for feature/issue-7.']);
  });

  test('green CI merges with the configured method, closes the issue and unblocks', async () => {
    const { fake, log, merge } = setup({
      [`GET ${R}/issues?state=open&per_page=100`]: [
        issue({ number: 8, labels: ['blocked'], body: '## Blocked by\n- #7' }),
      ],
    });
    expect(await merge()).toBe(true);
    expect(fake.writes()).toEqual([
      `PUT ${R}/pulls/30/merge`,
      `DELETE ${R}/git/refs/heads/feature/issue-7`,
      `POST ${R}/issues/7/comments`,
      `PATCH ${R}/issues/7`,
      `DELETE ${R}/issues/8/labels/blocked`,
    ]);
    expect(fake.calls.find((c) => c.method === 'PUT')?.fields).toEqual({
      merge_method: ['rebase'],
    });
    expect(log.at(-1)).toBe('PR #30 merged; issue #7 closed.');
  });

  test('an issue already closed by the PR is not closed again', async () => {
    const { fake, merge } = setup({ [`GET ${R}/issues/7`]: issue({ number: 7, state: 'closed' }) });
    expect(await merge()).toBe(true);
    expect(fake.writes()).toEqual([
      `PUT ${R}/pulls/30/merge`,
      `DELETE ${R}/git/refs/heads/feature/issue-7`,
    ]);
  });

  test('waits while CI is pending, then merges when it turns green', async () => {
    let polls = 0;
    const { fake, merge } = setup({
      [`GET ${R}/commits/abc/check-runs?per_page=100`]: () =>
        ++polls < 3 ? { check_runs: [{ name: 'c', status: 'queued', conclusion: null }] } : green,
    });
    expect(await merge()).toBe(true);
    expect(polls).toBe(3);
    expect(fake.writes()[0]).toBe(`PUT ${R}/pulls/30/merge`);
  });

  test('a failing legacy status counts as red', async () => {
    const { fake, merge } = setup({
      [`GET ${R}/commits/abc/status`]: {
        state: 'failure',
        total_count: 1,
        statuses: [{ context: 'ci/legacy', state: 'failure' }],
      },
      [`GET ${R}/commits/main`]: { sha: 'main1' },
      [`GET ${R}/commits/main1/check-runs?per_page=100`]: green,
      [`GET ${R}/commits/main1/status`]: noStatus,
    });
    expect(await merge()).toBe(false);
    expect(fake.writes()).toEqual([]);
  });

  test('no checks after the grace polls needs the LLM phase', async () => {
    const { fake, log, merge } = setup({
      [`GET ${R}/commits/abc/check-runs?per_page=100`]: { check_runs: [] },
    });
    expect(await merge()).toBe(false);
    expect(log.at(-1)).toBe('CI is not green on PR #30 (none).');
    expect(fake.calls.filter((c) => c.path.endsWith('/check-runs?per_page=100'))).toHaveLength(13);
  });

  test('red on a check that main passes needs the LLM phase', async () => {
    const { fake, log, merge } = setup({
      [`GET ${R}/commits/abc/check-runs?per_page=100`]: red('lint', 'test'),
      [`GET ${R}/commits/main`]: { sha: 'main1' },
      [`GET ${R}/commits/main1/check-runs?per_page=100`]: red('test'),
      [`GET ${R}/commits/main1/status`]: noStatus,
    });
    expect(await merge()).toBe(false);
    expect(log.at(-1)).toBe('CI is not green on PR #30 (red).');
    expect(fake.writes()).toEqual([]);
  });

  test('red only on checks also red on main merges and opens one issue per check', async () => {
    const { fake, log, merge } = setup({
      [`GET ${R}/commits/abc/check-runs?per_page=100`]: red('test', 'e2e'),
      [`GET ${R}/commits/main`]: { sha: 'main1' },
      [`GET ${R}/commits/main1/check-runs?per_page=100`]: red('e2e', 'test', 'other'),
      [`GET ${R}/commits/main1/status`]: noStatus,
      [`GET ${R}/issues?state=open&per_page=100`]: [
        { ...issue({ number: 3 }), title: 'main is red: e2e' },
      ],
      [`GET ${R}/issues/7`]: issue({ number: 7, state: 'closed' }),
    });
    expect(await merge()).toBe(true);
    expect(log).toContain('PR #30 is red only on checks also red on main; merging anyway.');
    expect(fake.writes()).toEqual([
      `PUT ${R}/pulls/30/merge`,
      `POST ${R}/issues/30/comments`,
      `POST ${R}/issues`,
      `DELETE ${R}/git/refs/heads/feature/issue-7`,
    ]);
    expect(fake.calls.find((c) => c.path === `${R}/issues/30/comments`)?.fields.body).toEqual([
      'Merged with checks also red on main: e2e, test',
    ]);
    const opened = fake.calls.find((c) => c.path === `${R}/issues`);
    expect(opened?.fields.title).toEqual(['main is red: test']);
    expect(opened?.fields['labels[]']).toEqual(['ready-for-agent']);
  });

  test('a refused merge needs the LLM phase', async () => {
    const { log, merge } = setup({ [`PUT ${R}/pulls/30/merge`]: new Error('405 not mergeable') });
    expect(await merge()).toBe(false);
    expect(log.at(-1)).toBe('Merge of PR #30 failed.');
  });

  test('a malformed PR lookup needs the LLM phase and does not throw', async () => {
    const { log, merge } = setup({ [PR]: [{ number: 'x' }] });
    expect(await merge()).toBe(false);
    expect(log[0]).toMatch(/^GitHub API lookup of the PR for feature\/issue-7 failed: unexpected/);
  });
});

describe('ghCli', () => {
  const FAKES = resolve(import.meta.dirname, '../test/fakes');
  const env = (extra: Record<string, string>) => ({ PATH: `${FAKES}:/usr/bin:/bin`, ...extra });

  test('runs the gh binary and returns its stdout', async () => {
    const gh = ghCli(env({ FAKE_GH_API: '{"sha":"abc"}' }));
    expect(await gh(['api', 'repos/acme/app/commits/main'])).toBe('{"sha":"abc"}\n');
  });

  test('a failing gh rejects with GhError carrying its stderr', async () => {
    const gh = ghCli(env({ FAKE_GH_API_FAIL: 'HTTP 404: Not Found' }));
    await expect(gh(['api', 'repos/acme/app/issues/1'])).rejects.toThrow(
      new GhError('gh api repos/acme/app/issues/1 failed: HTTP 404: Not Found'),
    );
  });
});
