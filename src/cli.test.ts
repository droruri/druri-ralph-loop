import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import { main } from './cli.ts';
import { saveConfig } from './config.ts';
import { fakeGh } from './gh.fake.ts';

let root = '';
const out: string[] = [];
const err: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ralph-cli-'));
  out.length = 0;
  err.length = 0;
  gh = fakeGh();
});
afterEach(() => rm(root, { recursive: true, force: true }));

let gh = fakeGh();
const ralph = (...argv: string[]) =>
  main(argv, { cwd: root, out: (l) => out.push(l), err: (l) => err.push(l), gh: gh.gh });

describe('ralph', () => {
  test('config get prints strings raw and other values as JSON', async () => {
    await saveConfig(root, { repo: 'acme/app' });
    expect(await ralph('config', 'get', 'models.build')).toBe(0);
    expect(await ralph('config', 'get', 'commands.diffExclude')).toBe(0);
    expect(out).toEqual(['sonnet', '[]']);
  });

  test('config set saves a valid value', async () => {
    await saveConfig(root, { repo: 'acme/app' });
    expect(await ralph('config', 'set', 'smallDiffLines', '90')).toBe(0);
    expect(await ralph('config', 'get', 'smallDiffLines')).toBe(0);
    expect(out).toEqual(['90']);
  });

  test('an invalid config exits 1 with an error naming the key', async () => {
    await mkdir(join(root, '.ralph'));
    await writeFile(join(root, '.ralph/config.json'), '{"repo":"acme/app","merge":{"auto":"yes"}}');
    expect(await ralph('config', 'get', 'repo')).toBe(1);
    expect(err.join('\n')).toMatch(/merge\.auto: /);
  });

  test('usage errors exit 2', async () => {
    expect(await ralph('nope')).toBe(2);
    expect(await ralph('config', 'set', 'repo')).toBe(2);
    expect(await ralph('init', '--bogus')).toBe(2);
    expect(err.join('\n')).toContain('Usage: ralph');
  });

  test('--help prints usage and exits 0', async () => {
    expect(await ralph('--help')).toBe(0);
    expect(out.join('\n')).toContain('ralph init [--yes]');
  });

  test.each([
    [['progress', 'fetch', '7']],
    [['progress', 'pull', 'seven']],
    [['progress', 'pull']],
    [['merge']],
    [['merge', '7', '8']],
  ])('%j is a usage error', async (argv) => {
    await saveConfig(root, { repo: 'acme/app' });
    expect(await ralph(...argv)).toBe(2);
  });

  test('progress pull writes the file in the current directory', async () => {
    await saveConfig(root, { repo: 'acme/app' });
    const body = '<!-- ralph-progress -->\n```text\nnext: step 4\n```';
    gh = fakeGh({
      'GET repos/acme/app/issues/7/comments?per_page=100': [{ id: 1, body }],
      'GET repos/acme/app/issues/comments/1': { id: 1, body },
    });
    expect(await ralph('progress', 'pull', '7')).toBe(0);
    expect(await readFile(join(root, 'logs/issue-7.progress.md'), 'utf8')).toBe('next: step 4\n');
  });

  test('merge exits 1 when there is no open PR', async () => {
    await saveConfig(root, { repo: 'acme/app' });
    gh = fakeGh({ 'GET repos/acme/app/pulls?head=acme%3Afeature%2Fissue-7&state=open': [] });
    expect(await ralph('merge', '7')).toBe(1);
    expect(out).toEqual(['No open PR for feature/issue-7.']);
  });

  test('merge exits 0 when the PR is merged', async () => {
    await saveConfig(root, { repo: 'acme/app' });
    gh = fakeGh({
      'GET repos/acme/app/pulls?head=acme%3Afeature%2Fissue-7&state=open': [
        { number: 30, head: { sha: 'abc' } },
      ],
      'GET repos/acme/app/commits/abc/check-runs': {
        check_runs: [{ name: 'check', status: 'completed', conclusion: 'success' }],
      },
      'GET repos/acme/app/commits/abc/status': { state: 'pending', total_count: 0, statuses: [] },
      'GET repos/acme/app/issues/7': {
        number: 7,
        title: 't',
        body: '',
        state: 'closed',
        labels: [],
      },
      'GET repos/acme/app/issues': [],
    });
    expect(await ralph('merge', '7')).toBe(0);
    expect(out.at(-1)).toBe('PR #30 merged; issue #7 closed.');
  });

  test('a malformed gh response exits 1 with a clear error', async () => {
    await saveConfig(root, { repo: 'acme/app' });
    gh = fakeGh({ 'GET repos/acme/app/issues/7/comments?per_page=100': { oops: true } });
    expect(await ralph('progress', 'pull', '7')).toBe(1);
    expect(err[0]).toMatch(/^ralph: unexpected response from gh api repos\/acme\/app\/issues\/7/);
  });
});
