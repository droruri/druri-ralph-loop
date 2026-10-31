// `ralph init`: writes `.ralph/config.json` from detected defaults and answers, and gitignores the
// loop's worktrees and logs.
import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { agentFiles } from './agents.ts';
import {
  CONFIG_PATH,
  ConfigError,
  getIn,
  invalidConfig,
  parseConfig,
  saveConfig,
  SCHEMA_REF,
  setIn,
  setValue,
} from './config.ts';
import { exists, isNotFound } from './fs.ts';

const run = promisify(execFile);

/** Settings `init` asks for, in order. */
const PROMPTS = [
  'repo',
  'labels.pickLabel',
  'labels.blocked',
  'labels.needsHuman',
  'labels.lock',
  'models.build',
  'models.review',
  'models.merge',
  'models.escalation',
  'phases',
  'smallDiffLines',
  'commands.install',
  'commands.check',
  'commands.diffExclude',
  'specDoc',
  'subagents.investigator',
  'subagents.planner',
  'subagents.reviewer.type',
  'subagents.reviewer.parallel',
  'subagents.browserCheck',
  'skills.tdd',
  'skills.plan',
  'plugins',
  'merge.method',
  'merge.auto',
];

const GITIGNORE_LINES = ['.ralph/wt/', '.ralph/logs/'];

const LOCKFILE_INSTALL: [lockfile: string, install: string][] = [
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['package-lock.json', 'npm ci'],
  ['yarn.lock', 'yarn install --frozen-lockfile'],
  ['bun.lock', 'bun install'],
  ['bun.lockb', 'bun install'],
];

export interface InitOptions {
  cwd: string;
  /** Take every default without asking; keep an existing config. */
  yes: boolean;
  ask: (question: string) => Promise<string>;
  log: (line: string) => void;
}

export async function init({ cwd, yes, ask, log }: InitOptions): Promise<void> {
  const root = await gitRoot(cwd);

  if (await exists(join(root, CONFIG_PATH))) {
    const overwrite = yes ? '' : await ask(`Overwrite ${CONFIG_PATH}? [y/N] `);
    if (!/^y(es)?$/i.test(overwrite.trim())) {
      log(`Kept the existing ${CONFIG_PATH}.`);
      await ignoreRalphDirs(root);
      return;
    }
  }

  const agents = await agentFiles(root);
  const detected: Record<string, string> = {
    repo: await detectRepo(root),
    'commands.install': await detectInstall(root),
  };
  // Defaults of the schema, shown next to each prompt; `repo` has none.
  const defaults = parseConfig({ repo: 'owner/name' });

  if (!yes && agents.length > 0) log(`Agent types in .claude/agents: ${agents.join(', ')}`);
  let raw: Record<string, unknown> = { $schema: SCHEMA_REF };
  for (const key of PROMPTS) {
    const schemaDefault = defaults.ok && key !== 'repo' ? getIn(defaults.config, key) : undefined;
    const detectedValue = detected[key] ?? '';
    const shown =
      detectedValue !== '' || schemaDefault === undefined
        ? detectedValue
        : typeof schemaDefault === 'string'
          ? schemaDefault
          : JSON.stringify(schemaDefault);
    const answer = yes ? '' : (await ask(`${key} [${shown}]: `)).trim();
    // An empty answer keeps the default; only detected values and answers go in the file.
    if (answer !== '') raw = setValue(raw, key, answer);
    else if (detectedValue !== '') raw = setIn(raw, key, detectedValue);
  }

  const result = parseConfig(raw);
  if (!result.ok) throw invalidConfig(result.errors);
  await saveConfig(root, raw);
  await ignoreRalphDirs(root);
  log(`Wrote ${CONFIG_PATH}. Change it later with \`ralph config set <key> <value>\`.`);
}

async function gitRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { cwd });
    return stdout.trim();
  } catch (error) {
    throw new ConfigError('not a git repository; run `ralph init` inside one', { cause: error });
  }
}

/** `owner/name` of the `origin` GitHub remote, or "" when there is none. */
async function detectRepo(root: string): Promise<string> {
  let url: string;
  try {
    url = (await run('git', ['remote', 'get-url', 'origin'], { cwd: root })).stdout.trim();
  } catch {
    return '';
  }
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? '';
}

async function detectInstall(root: string): Promise<string> {
  for (const [lockfile, install] of LOCKFILE_INSTALL) {
    if (await exists(join(root, lockfile))) return install;
  }
  return '';
}

/** Appends the missing ralph lines to `.gitignore`, keeping what is there. */
async function ignoreRalphDirs(root: string): Promise<void> {
  const path = join(root, '.gitignore');
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    // No .gitignore yet: appendFile creates it.
    if (!isNotFound(error)) throw error;
  }
  const present = new Set(text.split('\n').map((line) => line.trim()));
  const missing = GITIGNORE_LINES.filter((line) => !present.has(line));
  if (missing.length === 0) return;
  const separator = text === '' || text.endsWith('\n') ? '' : '\n';
  await appendFile(path, `${separator}${missing.join('\n')}\n`);
}
