// Command dispatch for `ralph`. Each command's logic lives in its own module.
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { ConfigError, findRoot, getConfigValue, loadConfig, setConfigValue } from './config.ts';
import { doctor } from './doctor.ts';
import { createTracker, type Gh, GhError, ghCli } from './github.ts';
import { init } from './init.ts';

const USAGE = `Usage: ralph <command>

  ralph init [--yes]               Write .ralph/config.json; --yes takes every default
  ralph config get <key>           Print a setting, e.g. models.build
  ralph config set <key> <value>   Change a setting; the value is checked before it is saved
  ralph doctor                     Check that this project is ready to run the loop
  ralph progress pull|push <N>     Sync logs/issue-<N>.progress.md with the issue's progress comment
  ralph merge <N>                  Wait for CI on issue N's PR, merge it, close the issue
                                   (exit 0 merged, 1 the merge phase needs Claude)`;

export interface Io {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Runner for `gh`; the real binary when unset. */
  gh?: Gh;
}

class UsageError extends Error {}

/** Runs one command; returns the exit code (0 ok, 1 failed, 2 usage error). */
export async function main(argv: string[], io: Io): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`ralph: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    if (error instanceof ConfigError || error instanceof GhError) {
      io.err(`ralph: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function dispatch(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { yes: { type: 'boolean', short: 'y' }, help: { type: 'boolean', short: 'h' } },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error), { cause: error });
  }
  const { values, positionals } = parsed;
  const [command, ...args] = positionals;
  if (values.help === true || command === undefined) {
    io.out(USAGE);
    return values.help === true ? 0 : 2;
  }

  switch (command) {
    case 'init':
      expectArgs(args, 0);
      await withPrompter((ask) =>
        init({ cwd: io.cwd, yes: values.yes === true, ask, log: io.out }),
      );
      return 0;
    case 'config':
      return configCommand(args, io);
    case 'doctor': {
      expectArgs(args, 0);
      const root = await findRoot(io.cwd);
      const ok = await doctor({ root, home: homedir(), env: process.env, log: io.out });
      return ok ? 0 : 1;
    }
    case 'progress': {
      const [action, issue] = args;
      expectArgs(args, 2);
      if (action !== 'pull' && action !== 'push') {
        throw new UsageError('expected `progress pull <N>` or `progress push <N>`');
      }
      const n = issueNumber(issue);
      const tracker = await trackerFor(io);
      await (action === 'pull' ? tracker.progressPull(n, io.cwd) : tracker.progressPush(n, io.cwd));
      return 0;
    }
    case 'merge': {
      expectArgs(args, 1);
      const n = issueNumber(args[0]);
      return (await (await trackerFor(io)).merge(n)) ? 0 : 1;
    }
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

async function configCommand(args: string[], io: Io): Promise<number> {
  const [action, key, value] = args;
  const root = await findRoot(io.cwd);
  if (action === 'get' && key !== undefined) {
    expectArgs(args, 2);
    const result = await getConfigValue(root, key);
    io.out(typeof result === 'string' ? result : JSON.stringify(result));
    return 0;
  }
  if (action === 'set' && key !== undefined && value !== undefined) {
    expectArgs(args, 3);
    await setConfigValue(root, key, value);
    return 0;
  }
  throw new UsageError('expected `config get <key>` or `config set <key> <value>`');
}

function issueNumber(text: string | undefined): number {
  if (text === undefined || !/^\d+$/.test(text)) {
    throw new UsageError(`expected an issue number, got: ${text ?? ''}`);
  }
  return Number(text);
}

async function trackerFor(io: Io) {
  const config = await loadConfig(await findRoot(io.cwd));
  return createTracker(config, io.gh ?? ghCli(), io.out);
}

function expectArgs(args: string[], count: number): void {
  if (args.length !== count) throw new UsageError(`unexpected argument: ${args[count] ?? ''}`);
}

/** Runs `use` with a terminal prompt, closing it afterwards. */
async function withPrompter(use: (ask: (q: string) => Promise<string>) => Promise<void>) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await use((question) => rl.question(question));
  } finally {
    rl.close();
  }
}
