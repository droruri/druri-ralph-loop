// `ralph init`: writes `.ralph/config.json` from detected defaults and answers, writes
// `.ralph/README.md` and the `/ralph-issue` skill, and gitignores the loop's worktrees and logs.
// `ralph upgrade` rewrites the files ralph owns (the skill, `.ralph/README.md`).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { agentFiles } from './agents.ts';
import {
  CONFIG_PATH,
  ConfigError,
  getIn,
  invalidConfig,
  loadConfig,
  parseConfig,
  saveConfig,
  SCHEMA_REF,
  setIn,
  setValue,
} from './config.ts';
import { renderProjectReadme } from './docs.ts';
import { exists, isNotFound } from './fs.ts';
import { cliVersion } from './report.ts';

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

const README_PATH = '.ralph/README.md';

export const SKILL_PATH = '.claude/skills/ralph-issue/SKILL.md';

// Same relative path from `src/` (tests) and `dist/` (the built package).
export const SKILL_TEMPLATE = resolve(import.meta.dirname, '../templates/ralph-issue/SKILL.md');

/** Last line of a written skill: the ralph version and the hash of everything above it. */
const SKILL_MARKER = /<!-- ralph (\S+) sha256:([0-9a-f]{64}) -->\n$/;

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

const isYes = (answer: string) => /^y(es)?$/i.test(answer.trim());

export async function init({ cwd, yes, ask, log }: InitOptions): Promise<void> {
  const root = await gitRoot(cwd);
  // --yes keeps a hand-edited skill, as it keeps an existing config.
  const overwriteEdited = async () => !yes && isYes(await ask(EDITED_QUESTION));

  if (await exists(join(root, CONFIG_PATH))) {
    const overwrite = yes ? '' : await ask(`Overwrite ${CONFIG_PATH}? [y/N] `);
    if (!isYes(overwrite)) {
      log(`Kept the existing ${CONFIG_PATH}.`);
      await writeProjectFiles(root);
      await writeSkill(root, overwriteEdited, log);
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
  await writeProjectFiles(root);
  await writeSkill(root, overwriteEdited, log);
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

/** Writes `.ralph/README.md` (generated, so always overwritten) and the `.gitignore` lines. */
async function writeProjectFiles(root: string): Promise<void> {
  await mkdir(join(root, '.ralph'), { recursive: true });
  await writeFile(join(root, README_PATH), renderProjectReadme());
  await ignoreRalphDirs(root);
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

/** `ralph upgrade`: rewrites `.ralph/README.md` and the skill; asks before replacing hand edits. */
export async function upgrade({ cwd, yes, ask, log }: InitOptions): Promise<void> {
  const root = await gitRoot(cwd);
  await loadConfig(root);
  await writeProjectFiles(root);
  // --yes overwrites a hand-edited skill: rewriting it is what upgrade is for.
  await writeSkill(root, async () => yes || isYes(await ask(EDITED_QUESTION)), log);
}

const EDITED_QUESTION = `Overwrite the hand-edited ${SKILL_PATH}? [y/N] `;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The written skill's version ("unknown" without a marker) and whether it was edited by hand. */
async function installedSkill(root: string) {
  let text: string;
  try {
    text = await readFile(join(root, SKILL_PATH), 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  const match = SKILL_MARKER.exec(text);
  if (match === null) return { version: 'unknown', edited: true };
  const [, version = 'unknown', hash] = match;
  return { version, edited: sha256(text.slice(0, match.index)) !== hash };
}

/**
 * Writes the `/ralph-issue` skill from the shipped template with a version marker. A hand-edited
 * skill is replaced only when `overwriteEdited` resolves true.
 */
async function writeSkill(
  root: string,
  overwriteEdited: () => Promise<boolean>,
  log: (line: string) => void,
): Promise<void> {
  const installed = await installedSkill(root);
  if (installed?.edited === true && !(await overwriteEdited())) {
    log(`Kept the hand-edited ${SKILL_PATH}.`);
    return;
  }
  const version = await cliVersion();
  const body = await readFile(SKILL_TEMPLATE, 'utf8');
  const path = join(root, SKILL_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${body}<!-- ralph ${version} sha256:${sha256(body)} -->\n`);
  log(`/ralph-issue skill: ${installed?.version ?? 'none'} -> ${version}`);
}
