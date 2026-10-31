// `ralph doctor`: checks that a project is ready to run the loop, one line per check.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { missingAgentTypes } from './agents.ts';
import { type Config, loadConfig } from './config.ts';

const run = promisify(execFile);

export interface DoctorOptions {
  root: string;
  /** Home directory holding the user's `.claude` settings, agents and plugins. */
  home: string;
  /** Environment for `gh` and `claude`, including PATH. */
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
}

interface Check {
  ok: boolean;
  detail: string;
}

/** Runs every check; true when all pass. */
export async function doctor({ root, home, env, log }: DoctorOptions): Promise<boolean> {
  let config: Config | undefined;
  let configCheck: Check;
  try {
    config = await loadConfig(root);
    configCheck = { ok: true, detail: '.ralph/config.json is valid' };
  } catch (error) {
    configCheck = { ok: false, detail: message(error).replaceAll('\n  ', '; ') };
  }

  const checks: [name: string, check: Check][] = [
    ['config', configCheck],
    ['gh', await command('gh', ['auth', 'status'], env, () => 'authenticated')],
    ['claude', await command('claude', ['--version'], env, (stdout) => stdout.trim())],
    ['agents', config ? await agentsCheck(config, root, home) : skipped()],
  ];
  for (const [name, { ok, detail }] of checks) log(`${ok ? '✓' : '✗'} ${name}  ${detail}`);
  return checks.every(([, check]) => check.ok);
}

/** Runs a command; passes when it exits 0. */
async function command(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  describe: (stdout: string) => string,
): Promise<Check> {
  try {
    const { stdout } = await run(file, args, { env });
    return { ok: true, detail: describe(stdout) };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { ok: false, detail: `${file} not found on PATH` };
    }
    const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : '';
    return { ok: false, detail: stderr || message(error) };
  }
}

async function agentsCheck(config: Config, root: string, home: string): Promise<Check> {
  const { investigator, planner, reviewer, browserCheck } = config.subagents;
  const types = [investigator, planner, reviewer?.type, browserCheck].filter(
    (type) => type !== undefined,
  );
  if (types.length === 0) return { ok: true, detail: 'none set; every step runs inline' };
  const missing = await missingAgentTypes(types, root, home);
  if (missing.length > 0) return { ok: false, detail: `not found: ${missing.join(', ')}` };
  return { ok: true, detail: types.join(', ') };
}

function skipped(): Check {
  return { ok: false, detail: 'skipped: the config is invalid' };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
