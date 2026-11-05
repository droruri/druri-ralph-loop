import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import { exists } from './fs.ts';
import { git, gitRepo } from './git.fake.ts';
import { createWorktree, removeWorktree, WorktreeError } from './worktree.ts';

let dir = '';
let root = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ralph-wt-'));
  root = await gitRepo(dir);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const opts = (install = '') => ({ install, env: process.env, log: () => {} });

describe('createWorktree', () => {
  test('creates .ralph/wt/issue-N on a new branch from origin/main, links .env, runs install', async () => {
    await writeFile(join(root, '.env'), 'A=1\n');
    const wt = await createWorktree(root, 7, opts('echo hi > installed.txt'));
    expect(wt).toBe(join(root, '.ralph/wt/issue-7'));
    expect(git(wt, 'branch', '--show-current')).toBe('feature/issue-7');
    expect((await lstat(join(wt, '.env'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(wt, 'installed.txt'), 'utf8')).toBe('hi\n');
  });

  test('reuses an existing worktree without reinstalling', async () => {
    const wt = await createWorktree(root, 7, opts());
    expect(await createWorktree(root, 7, opts('touch again'))).toBe(wt);
    expect(await exists(join(wt, 'again'))).toBe(false);
  });

  test('uses an existing local branch', async () => {
    git(root, 'branch', 'feature/issue-8');
    const wt = await createWorktree(root, 8, opts());
    expect(git(wt, 'branch', '--show-current')).toBe('feature/issue-8');
  });

  test('tracks an existing remote branch', async () => {
    git(root, 'push', '--quiet', 'origin', 'main:feature/issue-9');
    const wt = await createWorktree(root, 9, opts());
    expect(git(wt, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feature/issue-9');
  });

  test('a failing install throws', async () => {
    await expect(createWorktree(root, 7, opts('exit 3'))).rejects.toThrow(WorktreeError);
  });
});

describe('removeWorktree', () => {
  test('removes the worktree and the local branch', async () => {
    const wt = await createWorktree(root, 7, opts());
    await removeWorktree(root, 7);
    expect(await exists(wt)).toBe(false);
    expect(git(root, 'branch', '--list', 'feature/issue-7')).toBe('');
  });

  test('is a no-op when nothing exists', async () => {
    await expect(removeWorktree(root, 42)).resolves.toBeUndefined();
  });
});
