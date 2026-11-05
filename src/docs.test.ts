import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vite-plus/test';
import { configJsonSchema } from './config.ts';
import { COMMANDS, CONFIG_DOCS, renderExplain, renderProjectReadme, renderReadme } from './docs.ts';

const repoRoot = join(import.meta.dirname, '..');

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Dotted leaf keys of a JSON schema: object nodes with `properties` recurse, the rest are leaves. */
function schemaKeys(node: unknown, prefix = ''): string[] {
  const properties = isObject(node) ? node.properties : undefined;
  if (!isObject(properties)) return [prefix];
  return Object.entries(properties)
    .filter(([key]) => key !== '$schema')
    .flatMap(([key, child]) => schemaKeys(child, prefix === '' ? key : `${prefix}.${key}`));
}

describe('docs', () => {
  test('every config schema key is documented, and nothing else', () => {
    expect(Object.keys(CONFIG_DOCS).sort()).toEqual(schemaKeys(configJsonSchema()).sort());
  });

  test('every command registered in cli.ts is documented, and only planned ones are not registered', async () => {
    const cli = await readFile(join(import.meta.dirname, 'cli.ts'), 'utf8');
    const registered = [...cli.matchAll(/^ {4}case '([\w-]+)':/gm)].map((m) => m[1]);
    expect(registered.length).toBeGreaterThan(0);
    const built = COMMANDS.filter((c) => c.planned !== true).map((c) => c.name);
    const planned = COMMANDS.filter((c) => c.planned === true).map((c) => c.name);
    expect(new Set(registered)).toEqual(new Set(built));
    for (const name of planned) expect(registered).not.toContain(name);
  });

  test('explain covers commands, the skill, config keys, phases and labels', () => {
    const text = renderExplain();
    for (const command of COMMANDS) expect(text).toContain(command.usage);
    for (const key of Object.keys(CONFIG_DOCS)) expect(text).toContain(key);
    for (const word of [
      'npm i -g',
      'ralph run --model opus',
      '/ralph-issue <N>',
      '## Blocked by',
      'ready-for-agent',
      'needs-human',
      'ralph:running',
      'runs inline',
    ]) {
      expect(text).toContain(word);
    }
  });

  test('config defaults come from the schema', () => {
    const text = renderExplain();
    expect(text).toMatch(/smallDiffLines\s+default 150/);
    expect(text).toMatch(/labels\.pickLabel\s+default "ready-for-agent"/);
    expect(text).toMatch(/subagents\.planner\s+unset/);
  });

  test('the project README points to ralph explain', () => {
    expect(renderProjectReadme()).toContain('ralph explain');
  });

  // `pnpm run docs` regenerates README.md; CI runs this test through `pnpm test`.
  test('README.md is up to date with src/docs.ts (run `pnpm run docs`)', async () => {
    const path = join(repoRoot, 'README.md');
    if (process.env.RALPH_WRITE_DOCS === '1') await writeFile(path, renderReadme());
    expect(await readFile(path, 'utf8')).toBe(renderReadme());
  });
});
