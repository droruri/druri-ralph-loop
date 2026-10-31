import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import { init } from './init.ts';

let root = '';
const output: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ralph-init-'));
  output.length = 0;
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function gitRepo(): Promise<void> {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/app.git'], { cwd: root });
}

/** Prompter that answers by the question's first word and records each question. */
function answers(replies: Record<string, string> = {}) {
  const questions: string[] = [];
  return {
    questions,
    ask: async (question: string) => {
      questions.push(question);
      return replies[question.split(' ')[0] ?? ''] ?? '';
    },
  };
}

const run = (opts: { yes: boolean; ask?: (q: string) => Promise<string> }) =>
  init({ cwd: root, log: (line) => output.push(line), ask: answers().ask, ...opts });

const readText = (path: string) => readFile(join(root, path), 'utf8');

describe('init --yes', () => {
  test('writes the config with detected defaults and a working $schema', async () => {
    await gitRepo();
    await writeFile(join(root, 'pnpm-lock.yaml'), '');
    await run({ yes: true });
    const config = JSON.parse(await readText('.ralph/config.json'));
    expect(config).toEqual({
      $schema: './config.schema.json',
      repo: 'acme/app',
      commands: { install: 'pnpm install --frozen-lockfile' },
    });
    const schema = JSON.parse(await readText('.ralph/config.schema.json'));
    expect(schema.required).toEqual(['repo']);
  });

  test('appends the ralph lines to .gitignore once and keeps its content', async () => {
    await gitRepo();
    await writeFile(join(root, '.gitignore'), 'node_modules/');
    await run({ yes: true });
    await rm(join(root, '.ralph/config.json'));
    await run({ yes: true });
    expect(await readText('.gitignore')).toBe('node_modules/\n.ralph/wt/\n.ralph/logs/\n');
  });

  test('keeps an existing config', async () => {
    await gitRepo();
    await mkdir(join(root, '.ralph'));
    await writeFile(join(root, '.ralph/config.json'), '{"repo":"acme/kept"}');
    await run({ yes: true });
    expect(await readText('.ralph/config.json')).toBe('{"repo":"acme/kept"}');
  });

  test('fails outside a git repository', async () => {
    await expect(run({ yes: true })).rejects.toThrow('not a git repository');
  });

  test('fails naming repo when no GitHub remote is found', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    await expect(run({ yes: true })).rejects.toThrow(/repo: /);
  });
});

describe('init with prompts', () => {
  test('shows each detected default and saves the answers', async () => {
    await gitRepo();
    await writeFile(join(root, 'package-lock.json'), '{}');
    await mkdir(join(root, '.claude/agents'), { recursive: true });
    await writeFile(join(root, '.claude/agents/e2e.md'), '---\nname: e2e\n---\n');
    // Unanswered prompts take the default; `""` is an explicit empty string.
    const prompter = answers({
      'labels.pickLabel': '""',
      'models.build': 'opus',
      'commands.check': 'pnpm check',
      'subagents.browserCheck': 'e2e',
      smallDiffLines: '80',
      phases: '["build"]',
      'merge.auto': 'false',
    });
    await run({ yes: false, ask: prompter.ask });

    expect(prompter.questions).toContain('repo [acme/app]: ');
    expect(prompter.questions).toContain('commands.install [npm ci]: ');
    expect(prompter.questions).toContain('smallDiffLines [150]: ');
    expect(prompter.questions).toContain('labels.lock [ralph:running]: ');
    expect(prompter.questions).toContain('plugins [[]]: ');
    expect(output).toContain('Agent types in .claude/agents: e2e');
    const config = JSON.parse(await readText('.ralph/config.json'));
    expect(config).toEqual({
      $schema: './config.schema.json',
      repo: 'acme/app',
      labels: { pickLabel: '' },
      models: { build: 'opus' },
      commands: { install: 'npm ci', check: 'pnpm check' },
      subagents: { browserCheck: 'e2e' },
      smallDiffLines: 80,
      phases: ['build'],
      merge: { auto: false },
    });
  });

  test('asks before overwriting an existing config', async () => {
    await gitRepo();
    await mkdir(join(root, '.ralph'));
    await writeFile(join(root, '.ralph/config.json'), '{"repo":"acme/kept"}');
    const no = answers({ Overwrite: 'n' });
    await run({ yes: false, ask: no.ask });
    expect(no.questions).toEqual(['Overwrite .ralph/config.json? [y/N] ']);
    expect(await readText('.ralph/config.json')).toBe('{"repo":"acme/kept"}');

    await run({ yes: false, ask: answers({ Overwrite: 'y' }).ask });
    expect(JSON.parse(await readText('.ralph/config.json')).repo).toBe('acme/app');
  });
});
