// One git worktree per issue, so a run never switches branches in the main checkout. It lives at
// <main checkout>/.ralph/wt/issue-<N> on branch feature/issue-<N>: the existing local or remote
// branch if there is one, else a new branch from origin/main.
import { execFile } from 'node:child_process';
import { rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { exists } from './fs.ts';
import { branchName } from './github.ts';

const run = promisify(execFile);

export class WorktreeError extends Error {}

export interface WorktreeOptions {
  /** `commands.install`; runs with `sh -c` in a new worktree. Empty: skipped. */
  install: string;
  env: NodeJS.ProcessEnv;
  /** Gets the last lines of the install output. */
  log: (line: string) => void;
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    return (await run('git', ['-C', cwd, ...args], { env })).stdout.trim();
  } catch (error) {
    throw new WorktreeError(`git ${args.join(' ')} failed: ${detail(error)}`, { cause: error });
  }
}

const hasRef = (root: string, ref: string) =>
  git(root, ['show-ref', '--verify', '--quiet', ref]).then(
    () => true,
    () => false,
  );

/** The main checkout, also when `cwd` is inside a worktree. */
async function mainRoot(cwd: string): Promise<string> {
  return dirname(await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
}

/** Creates issue `n`'s worktree (or reuses an existing one) and resolves with its path. */
export async function createWorktree(
  cwd: string,
  n: number,
  { install, env, log }: WorktreeOptions,
): Promise<string> {
  const root = await mainRoot(cwd);
  const wt = join(root, '.ralph/wt', `issue-${n}`);
  const branch = branchName(n);
  await git(root, ['fetch', 'origin', '--quiet', '--prune'], env);
  if (await exists(wt)) return wt;

  await git(root, ['worktree', 'prune']);
  if (await hasRef(root, `refs/heads/${branch}`)) {
    await git(root, ['worktree', 'add', '--quiet', wt, branch]);
  } else if (await hasRef(root, `refs/remotes/origin/${branch}`)) {
    await git(root, [
      'worktree',
      'add',
      '--quiet',
      '--track',
      '-b',
      branch,
      wt,
      `origin/${branch}`,
    ]);
  } else {
    await git(root, ['worktree', 'add', '--quiet', '--no-track', '-b', branch, wt, 'origin/main']);
  }
  if (await exists(join(root, '.env'))) {
    await rm(join(wt, '.env'), { force: true });
    await symlink(join(root, '.env'), join(wt, '.env'));
  }
  if (install !== '') {
    try {
      const { stdout, stderr } = await run('sh', ['-c', install], {
        cwd: wt,
        env,
        maxBuffer: 64 * 1024 * 1024,
      });
      for (const line of tail(`${stdout}${stderr}`)) log(line);
    } catch (error) {
      throw new WorktreeError(`\`${install}\` failed in ${wt}: ${detail(error)}`, {
        cause: error,
      });
    }
  }
  return wt;
}

/** Removes issue `n`'s worktree and its local branch; a missing one is fine. */
export async function removeWorktree(cwd: string, n: number): Promise<void> {
  const root = await mainRoot(cwd);
  const wt = join(root, '.ralph/wt', `issue-${n}`);
  if (await exists(wt)) await git(root, ['worktree', 'remove', '--force', wt]);
  await git(root, ['worktree', 'prune']);
  await git(root, ['branch', '-D', branchName(n)]).catch(() => {});
}

/** The last three non-empty lines, like `| tail -3`. */
function tail(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-3);
}

function detail(error: unknown): string {
  if (error instanceof Error && 'stderr' in error && typeof error.stderr === 'string') {
    const stderr = error.stderr.trim();
    if (stderr !== '') return tail(stderr).join(' / ');
  }
  return error instanceof Error ? error.message : String(error);
}
