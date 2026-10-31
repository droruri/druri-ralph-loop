import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import {
  configJsonSchema,
  getConfigValue,
  parseConfig,
  saveConfig,
  setConfigValue,
} from './config.ts';

describe('parseConfig', () => {
  test('fills every default from a repo alone', () => {
    const result = parseConfig({ repo: 'acme/app' });
    expect(result).toEqual({
      ok: true,
      config: {
        repo: 'acme/app',
        labels: {
          pickLabel: 'ready-for-agent',
          blocked: 'blocked',
          needsHuman: 'needs-human',
          lock: 'ralph:running',
        },
        models: { build: 'sonnet', review: 'haiku', merge: 'haiku', escalation: true },
        phases: ['build', 'review', 'merge'],
        smallDiffLines: 150,
        commands: { install: '', check: '', diffExclude: [] },
        subagents: {},
        skills: {},
        plugins: [],
        merge: { method: 'squash', auto: true },
      },
    });
  });

  test('names the dotted key of a wrong type', () => {
    const result = parseConfig({ repo: 'acme/app', labels: { pickLabel: 5 } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^labels\.pickLabel: /);
  });

  test('names an unknown key', () => {
    const result = parseConfig({ repo: 'acme/app', models: { biuld: 'opus' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join('\n')).toContain('biuld');
  });
});

describe('config get and set', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ralph-config-'));
    await saveConfig(root, { repo: 'acme/app', models: { build: 'opus' } });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const readFileText = () => readFile(join(root, '.ralph/config.json'), 'utf8');

  test('get returns a set value, a default and a whole object', async () => {
    expect(await getConfigValue(root, 'models.build')).toBe('opus');
    expect(await getConfigValue(root, 'smallDiffLines')).toBe(150);
    expect(await getConfigValue(root, 'merge')).toEqual({ method: 'squash', auto: true });
  });

  test('get of an unknown key fails', async () => {
    await expect(getConfigValue(root, 'models.nope')).rejects.toThrow('no value at models.nope');
    await expect(getConfigValue(root, 'repo.x')).rejects.toThrow('no value at repo.x');
  });

  test('set parses JSON values and keeps strings as strings', async () => {
    await setConfigValue(root, 'models.escalation', 'false');
    await setConfigValue(root, 'smallDiffLines', '80');
    await setConfigValue(root, 'commands.diffExclude', '["pnpm-lock.yaml"]');
    await setConfigValue(root, 'subagents.reviewer.type', 'general-purpose');
    await setConfigValue(root, 'labels.pickLabel', '');
    expect(JSON.parse(await readFileText())).toEqual({
      repo: 'acme/app',
      models: { build: 'opus', escalation: false },
      smallDiffLines: 80,
      commands: { diffExclude: ['pnpm-lock.yaml'] },
      subagents: { reviewer: { type: 'general-purpose' } },
      labels: { pickLabel: '' },
    });
  });

  test('set rejects an invalid value and leaves the file unchanged', async () => {
    const before = await readFileText();
    await expect(setConfigValue(root, 'smallDiffLines', 'many')).rejects.toThrow(
      /smallDiffLines: /,
    );
    await expect(setConfigValue(root, 'models.biuld', 'opus')).rejects.toThrow(/biuld/);
    expect(await readFileText()).toBe(before);
  });

  test('saved config points $schema at the written JSON schema', async () => {
    await setConfigValue(root, '$schema', './config.schema.json');
    const schema = JSON.parse(await readFile(join(root, '.ralph/config.schema.json'), 'utf8'));
    expect(schema).toEqual(configJsonSchema());
  });
});

describe('configJsonSchema', () => {
  test('describes nested keys and requires only repo', () => {
    const schema = configJsonSchema();
    expect(schema['required']).toEqual(['repo']);
    expect(JSON.stringify(schema['properties'])).toContain('"pickLabel"');
  });
});
