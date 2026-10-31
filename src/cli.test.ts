import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import { main } from './cli.ts';
import { saveConfig } from './config.ts';

let root = '';
const out: string[] = [];
const err: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ralph-cli-'));
  out.length = 0;
  err.length = 0;
});
afterEach(() => rm(root, { recursive: true, force: true }));

const ralph = (...argv: string[]) =>
  main(argv, { cwd: root, out: (l) => out.push(l), err: (l) => err.push(l) });

describe('ralph', () => {
  test('config get prints strings raw and other values as JSON', async () => {
    await saveConfig(root, { repo: 'acme/app' });
    expect(await ralph('config', 'get', 'models.build')).toBe(0);
    expect(await ralph('config', 'get', 'commands.diffExclude')).toBe(0);
    expect(out).toEqual(['sonnet', '[]']);
  });

  test('config set saves a valid value', async () => {
    await saveConfig(root, { repo: 'acme/app' });
    expect(await ralph('config', 'set', 'smallDiffLines', '90')).toBe(0);
    expect(await ralph('config', 'get', 'smallDiffLines')).toBe(0);
    expect(out).toEqual(['90']);
  });

  test('an invalid config exits 1 with an error naming the key', async () => {
    await mkdir(join(root, '.ralph'));
    await writeFile(join(root, '.ralph/config.json'), '{"repo":"acme/app","merge":{"auto":"yes"}}');
    expect(await ralph('config', 'get', 'repo')).toBe(1);
    expect(err.join('\n')).toMatch(/merge\.auto: /);
  });

  test('usage errors exit 2', async () => {
    expect(await ralph('nope')).toBe(2);
    expect(await ralph('config', 'set', 'repo')).toBe(2);
    expect(await ralph('init', '--bogus')).toBe(2);
    expect(err.join('\n')).toContain('Usage: ralph');
  });

  test('--help prints usage and exits 0', async () => {
    expect(await ralph('--help')).toBe(0);
    expect(out.join('\n')).toContain('ralph init [--yes]');
  });
});
