// Single owner of the `.ralph/config.json` schema, its defaults and its file I/O.
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

export const CONFIG_PATH = '.ralph/config.json';
export const SCHEMA_PATH = '.ralph/config.schema.json';
/** Value of the config's `$schema`, relative to the config file. */
export const SCHEMA_REF = './config.schema.json';

// An agent type name, e.g. `general-purpose` or `caveman:cavecrew-reviewer`.
// Unset means that step runs inline in the phase session.
const agentType = z.string().min(1);

export const ConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'expected owner/name'),
  labels: z
    .strictObject({
      // "" picks any open issue.
      pickLabel: z.string().default('ready-for-agent'),
      blocked: z.string().min(1).default('blocked'),
      needsHuman: z.string().min(1).default('needs-human'),
      lock: z.string().min(1).default('ralph:running'),
    })
    .prefault({}),
  models: z
    .strictObject({
      build: z.string().min(1).default('sonnet'),
      review: z.string().min(1).default('haiku'),
      merge: z.string().min(1).default('haiku'),
      // One more pass on opus when an issue is still open after all phases.
      escalation: z.boolean().default(true),
    })
    .prefault({}),
  phases: z
    .array(z.enum(['build', 'review', 'merge']))
    .min(1)
    .default(['build', 'review', 'merge']),
  smallDiffLines: z.int().positive().default(150),
  commands: z
    .strictObject({
      // Runs in each new worktree.
      install: z.string().default(''),
      // Lint + typecheck + related tests.
      check: z.string().default(''),
      // Paths left out of the diff size.
      diffExclude: z.array(z.string()).default([]),
    })
    .prefault({}),
  specDoc: z.string().min(1).optional(),
  subagents: z
    .strictObject({
      investigator: agentType.optional(),
      planner: agentType.optional(),
      reviewer: z
        .strictObject({
          type: agentType,
          parallel: z.int().positive().default(1),
        })
        .optional(),
      browserCheck: agentType.optional(),
    })
    .prefault({}),
  skills: z
    .strictObject({
      tdd: z.string().min(1).optional(),
      plan: z.string().min(1).optional(),
    })
    .prefault({}),
  // Extra plugins; the ones the agent types and skills need are added on top.
  plugins: z.array(z.string().min(1)).default([]),
  merge: z
    .strictObject({
      method: z.enum(['squash', 'merge', 'rebase']).default('squash'),
      auto: z.boolean().default(true),
    })
    .prefault({}),
});

export type Config = z.output<typeof ConfigSchema>;

export type ParseResult = { ok: true; config: Config } | { ok: false; errors: string[] };

/** Validates raw config data; each error line starts with the dotted key it is about. */
export function parseConfig(raw: unknown): ParseResult {
  const result = ConfigSchema.safeParse(raw);
  if (result.success) return { ok: true, config: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => {
      const key = issue.path.map(String).join('.') || '(root)';
      return `${key}: ${issue.message}`;
    }),
  };
}

export class ConfigError extends Error {}

/** The project root holding `.ralph/`: the git top level of `cwd`, else `cwd` itself. */
export async function findRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', '--show-toplevel'], { cwd });
    return stdout.trim();
  } catch {
    return cwd;
  }
}

/** Reads the raw JSON object of `.ralph/config.json` in `root`. */
export async function readRawConfig(root: string): Promise<unknown> {
  const path = join(root, CONFIG_PATH);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new ConfigError(`${CONFIG_PATH} not found; run \`ralph init\``, { cause: error });
    }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${CONFIG_PATH} is not valid JSON`, { cause: error });
  }
}

/** Reads and validates `.ralph/config.json`, with defaults filled in. */
export async function loadConfig(root: string): Promise<Config> {
  const result = parseConfig(await readRawConfig(root));
  if (!result.ok) throw invalidConfig(result.errors);
  return result.config;
}

export function invalidConfig(errors: string[]): ConfigError {
  return new ConfigError(`invalid ${CONFIG_PATH}:\n  ${errors.join('\n  ')}`);
}

/** Writes the raw config and the JSON schema its `$schema` points to. */
export async function saveConfig(root: string, raw: unknown): Promise<void> {
  const path = join(root, CONFIG_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(join(root, SCHEMA_PATH), `${JSON.stringify(configJsonSchema(), null, 2)}\n`);
  await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
}

/** JSON schema of the config file, for editor autocomplete; keys with defaults are optional. */
export function configJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ConfigSchema, { io: 'input' });
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function splitKey(key: string): string[] {
  const parts = key.split('.');
  if (parts.some((part) => part === '')) throw new ConfigError(`invalid key: ${key}`);
  return parts;
}

/** Value at a dotted key, or undefined when any part of the path is missing. */
export function getIn(data: unknown, key: string): unknown {
  let current = data;
  for (const part of splitKey(key)) {
    if (!isObject(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

/** Copy of `data` with the dotted key set; missing objects on the path are created. */
export function setIn(data: unknown, key: string, value: unknown): JsonObject {
  const [head, ...rest] = splitKey(key);
  const base = isObject(data) ? data : {};
  if (head === undefined) return base;
  const next = rest.length === 0 ? value : setIn(base[head], rest.join('.'), value);
  return { ...base, [head]: next };
}

/** A CLI value as JSON when it parses (`false`, `150`, `["a"]`), else the raw string. */
export function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Sets a dotted key in the project's config; saves only when the whole config stays valid. */
export async function setConfigValue(root: string, key: string, text: string): Promise<void> {
  const raw = setIn(await readRawConfig(root), key, parseValue(text));
  const result = parseConfig(raw);
  if (!result.ok) throw invalidConfig(result.errors);
  await saveConfig(root, raw);
}

/** Value at a dotted key of the project's config, with defaults filled in. */
export async function getConfigValue(root: string, key: string): Promise<unknown> {
  const value = getIn(await loadConfig(root), key);
  if (value === undefined) throw new ConfigError(`no value at ${key}`);
  return value;
}
