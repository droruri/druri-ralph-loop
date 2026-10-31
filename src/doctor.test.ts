import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import { saveConfig } from './config.ts';
import { doctor } from './doctor.ts';

const FAKES = resolve(import.meta.dirname, '../test/fakes');

let base = '';
let root = '';
let home = '';
let bin = '';
const output: string[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ralph-doctor-'));
  root = join(base, 'project');
  home = join(base, 'home');
  bin = join(base, 'bin');
  await Promise.all([mkdir(root), mkdir(home), mkdir(bin)]);
  output.length = 0;
});
afterEach(() => rm(base, { recursive: true, force: true }));

/** Puts the named fake binaries, and nothing else, on PATH. */
async function onPath(...names: string[]): Promise<void> {
  await Promise.all(names.map((name) => symlink(join(FAKES, name), join(bin, name))));
}

const run = (env: Record<string, string> = {}) =>
  doctor({ root, home, env: { PATH: bin, ...env }, log: (line) => output.push(line) });

const line = (check: string) => output.find((l) => l.slice(2).startsWith(`${check} `)) ?? '';

async function writeFileIn(dir: string, path: string, text: string): Promise<void> {
  await mkdir(join(dir, path, '..'), { recursive: true });
  await writeFile(join(dir, path), text);
}

describe('doctor', () => {
  test('passes every check on a ready project, one line per check', async () => {
    await saveConfig(root, { repo: 'acme/app' });
    await onPath('gh', 'claude');
    expect(await run()).toBe(true);
    expect(output).toHaveLength(4);
    expect(output.every((l) => l.startsWith('✓ '))).toBe(true);
    expect(line('claude')).toContain('9.9.9');
  });

  test('fails an invalid config, naming the key', async () => {
    await writeFileIn(root, '.ralph/config.json', '{"repo":"acme/app","smallDiffLines":"x"}');
    await onPath('gh', 'claude');
    expect(await run()).toBe(false);
    expect(line('config')).toMatch(/^✗ config .*smallDiffLines: /);
  });

  test('fails a missing config', async () => {
    await onPath('gh', 'claude');
    expect(await run()).toBe(false);
    expect(line('config')).toContain('ralph init');
  });

  test('fails when gh is not authenticated or missing', async () => {
    await saveConfig(root, { repo: 'acme/app' });
    await onPath('gh', 'claude');
    expect(await run({ FAKE_GH_AUTH: 'fail' })).toBe(false);
    expect(line('gh')).toMatch(/^✗ gh .*gh auth login/);

    output.length = 0;
    await rm(join(bin, 'gh'));
    expect(await run()).toBe(false);
    expect(line('gh')).toMatch(/^✗ gh .*not found on PATH/);
  });

  test('fails when claude is not on PATH', async () => {
    await saveConfig(root, { repo: 'acme/app' });
    await onPath('gh');
    expect(await run()).toBe(false);
    expect(line('claude')).toMatch(/^✗ claude .*not found on PATH/);
  });

  test('resolves agent types from built-ins, agent files and enabled plugins', async () => {
    await onPath('gh', 'claude');
    await writeFileIn(root, '.claude/agents/e2e.md', '');
    await writeFileIn(home, '.claude/agents/mine.md', '');
    const plugin = join(base, 'plugins/crew');
    const off = join(base, 'plugins/off');
    await writeFileIn(plugin, 'agents/reviewer.md', '');
    await writeFileIn(off, 'agents/helper.md', '');
    await writeFileIn(
      home,
      '.claude/plugins/installed_plugins.json',
      JSON.stringify({
        plugins: {
          'crew@market': [{ installPath: plugin }],
          'off@market': [{ installPath: off }],
        },
      }),
    );
    await writeFileIn(
      home,
      '.claude/settings.json',
      JSON.stringify({ enabledPlugins: { 'crew@market': true, 'off@market': false } }),
    );
    const subagents = {
      investigator: 'Explore',
      planner: 'mine',
      reviewer: { type: 'crew:reviewer' },
      browserCheck: 'e2e',
    };
    await saveConfig(root, { repo: 'acme/app', subagents });
    expect(await run()).toBe(true);
    expect(line('agents')).toMatch(/^✓ agents /);

    output.length = 0;
    await saveConfig(root, {
      repo: 'acme/app',
      subagents: { ...subagents, planner: 'off:helper', browserCheck: 'nope' },
    });
    expect(await run()).toBe(false);
    expect(line('agents')).toBe('✗ agents  not found: off:helper, nope');
  });
});
