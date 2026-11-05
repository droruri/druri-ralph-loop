// A git checkout for tests: a clone of a local bare `origin` with one commit on main. No network.
import { execFileSync } from 'node:child_process';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

/** Creates `<base>/origin.git` and its checkout `<base>/app`; resolves with the checkout path. */
export async function gitRepo(base: string): Promise<string> {
  const origin = join(base, 'origin.git');
  const checkout = join(base, 'app');
  git(base, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(base, 'clone', '--quiet', origin, checkout);
  git(checkout, 'config', 'user.email', 'ralph@test');
  git(checkout, 'config', 'user.name', 'ralph');
  git(checkout, 'config', 'commit.gpgsign', 'false');
  git(checkout, 'checkout', '--quiet', '-b', 'main');
  await writeFile(join(checkout, 'README.md'), 'app\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '--quiet', '-m', 'init');
  git(checkout, 'push', '--quiet', '-u', 'origin', 'main');
  return realpath(checkout);
}
