import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import { parseConfig } from './config.ts';
import { render, renderPrompt } from './prompt.ts';

describe('render', () => {
  test('replaces variables', () => {
    expect(render('run {{check}} on #{{issue}}', { check: 'make check', issue: '7' })).toBe(
      'run make check on #7',
    );
  });

  test('if/else picks a branch on whether the key is set', () => {
    const t = '{{#if a}}set {{a}}{{else}}unset{{/if}}';
    expect(render(t, { a: 'x' })).toBe('set x');
    expect(render(t, { a: undefined })).toBe('unset');
    expect(render(t, { a: '' })).toBe('unset');
    expect(render('{{#if a}}only{{/if}}.', { a: undefined })).toBe('.');
  });

  test('nested blocks', () => {
    const t = '{{#if a}}A{{#if b}}B{{else}}b{{/if}}{{else}}-{{/if}}';
    expect(render(t, { a: '1', b: '1' })).toBe('AB');
    expect(render(t, { a: '1', b: undefined })).toBe('Ab');
    expect(render(t, { a: undefined, b: '1' })).toBe('-');
  });

  test('unknown variables and stray tags throw', () => {
    expect(() => render('{{nope}}', {})).toThrow('unknown prompt variable: nope');
    expect(() => render('{{#if nope}}x{{/if}}', {})).toThrow('unknown prompt variable: nope');
    expect(() => render('{{#if a}}x', { a: '1' })).toThrow(/unrendered/);
    expect(render('{{a}}', { a: '{{b}}' })).toBe('{{b}}');
  });
});

const issue = { number: 7, title: 'Add login', body: 'Body with {{braces}}\n- [ ] works' };
const config = (raw: object = {}) => {
  const result = parseConfig({ repo: 'acme/app', ...raw });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.config;
};

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ralph-prompt-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('renderPrompt', () => {
  test.each(['build', 'review', 'merge'] as const)(
    '%s with defaults has no notes-organizer names and no tags',
    async (phase) => {
      const text = await renderPrompt(phase, issue, config(), root);
      for (const name of ['pnpm', 'docs/plan.md', 'e2e', 'Supabase', 'druri-plan', 'RALPH_HOME']) {
        expect(text).not.toContain(name);
      }
      expect(text).not.toMatch(/\{\{(?!braces)/);
      expect(text).toMatch(
        /ISSUE TITLE: Add login\n\nISSUE DETAILS & CHECKLIST:\nBody with \{\{braces\}\}/,
      );
    },
  );

  test('build holds shared, build and review steps; review and merge only their own', async () => {
    const build = await renderPrompt('build', issue, config(), root);
    expect(build).toContain('Execute PHASE build');
    expect(build).toContain('5. **TDD Phase**');
    expect(build).toContain('8. **Code Review Phase**');
    expect(build).not.toContain('10. **Wait for CI');
    const review = await renderPrompt('review', issue, config(), root);
    expect(review).toContain('8. **Code Review Phase**');
    expect(review).not.toContain('5. **TDD Phase**');
    const merge = await renderPrompt('merge', issue, config(), root);
    expect(merge).toContain('ralph merge 7');
    expect(merge).not.toContain('8. **Code Review Phase**');
  });
});

const notesOrganizer = {
  specDoc: 'docs/plan.md',
  commands: { check: 'scripts/ralph-checks.sh', diffExclude: ['pnpm-lock.yaml'] },
  subagents: {
    investigator: 'caveman:cavecrew-investigator',
    planner: 'general-purpose',
    reviewer: { type: 'caveman:cavecrew-reviewer', parallel: 2 },
    browserCheck: 'e2e',
  },
  skills: { tdd: 'mattpocock-skills:tdd', plan: 'druri-plan' },
};

describe('roles and skills', () => {
  test('notes-organizer settings render today’s spawn instructions', async () => {
    const text = await renderPrompt('build', issue, config(notesOrganizer), root);
    expect(text).toContain(
      'delegate the search to one\n     `caveman:cavecrew-investigator` Agent',
    );
    expect(text).toContain(
      'Spawn one\n     `general-purpose` Agent with this prompt: *"Run the `/druri-plan` skill for Issue #7',
    );
    expect(text).toContain('Run the `/mattpocock-skills:tdd` skill');
    expect(text).toContain('run `scripts/ralph-checks.sh`');
    expect(text).toContain('2 `caveman:cavecrew-reviewer` Agents **in one message**');
    expect(text).toContain('spawn the `e2e` Agent with');
    expect(text).toContain('`ralph progress push 7`');
    expect(text).toContain('`ralph merge 7`');
    expect(text).toContain("`git diff main...HEAD -- . ':!pnpm-lock.yaml'`");
  });

  // [config, text when set, text when unset]
  test.each([
    [
      'investigator',
      { subagents: { investigator: 'finder' } },
      '`finder` Agent',
      'Locate the things the criteria name yourself',
    ],
    [
      'planner',
      { subagents: { planner: 'architect' } },
      'Spawn one\n     `architect` Agent',
      'Write the plan yourself',
    ],
    [
      'plan',
      { skills: { plan: 'plan-it' } },
      'Write the plan yourself with the `/plan-it` skill',
      'Write the plan yourself, scoped',
    ],
    [
      'reviewer',
      { subagents: { reviewer: { type: 'critic' } } },
      'one `critic` Agent covering both',
      'Review the diff yourself',
    ],
    [
      'browserCheck',
      { subagents: { browserCheck: 'clicker' } },
      'Hand them to one `clicker` Agent',
      'If your tools can drive a browser',
    ],
    [
      'tdd',
      { skills: { tdd: 'red-green' } },
      'Run the `/red-green` skill',
      'Test first: write failing tests',
    ],
  ])('%s: set spawns, unset runs inline', async (_, raw, setText, inlineText) => {
    const set = await renderPrompt('build', issue, config(raw), root);
    expect(set).toContain(setText);
    expect(set).not.toContain(inlineText);
    const unset = await renderPrompt('build', issue, config(), root);
    expect(unset).toContain(inlineText);
    expect(unset).not.toContain(setText);
    expect(unset).not.toMatch(/` Agent/);
  });

  test('reviewer.parallel 2 splits the axes across agents; 1 keeps one agent', async () => {
    const one = await renderPrompt(
      'review',
      issue,
      config({ subagents: { reviewer: { type: 'critic' } } }),
      root,
    );
    expect(one).toContain('the same, one `critic` Agent covering both axes');
    const two = await renderPrompt(
      'review',
      issue,
      config({ subagents: { reviewer: { type: 'critic', parallel: 2 } } }),
      root,
    );
    expect(two).toContain('2 `critic` Agents **in one message**');
  });
});

describe('project settings', () => {
  test('unset specDoc drops the spec-doc lines; set shows the path', async () => {
    const unset = await renderPrompt('build', issue, config(), root);
    expect(unset).not.toContain('sections the body names');
    expect(unset).not.toContain('Read only the sections of');
    const set = await renderPrompt('build', issue, config({ specDoc: 'SPEC.md' }), root);
    expect(set).toContain('Read only the `SPEC.md` sections the body names');
    expect(set).toContain('Read only the sections of `SPEC.md`');
  });

  test('an empty diffExclude drops the exclude pathspec', async () => {
    const none = await renderPrompt('review', issue, config(), root);
    expect(none).not.toContain(':!');
    expect(none).toContain('`git diff --shortstat main...HEAD`');
    const some = await renderPrompt(
      'review',
      issue,
      config({ commands: { diffExclude: ['a.lock', 'gen/'] } }),
      root,
    );
    expect(some).toContain("`git diff --shortstat main...HEAD -- . ':!a.lock' ':!gen/'`");
  });

  test('.extra.md is appended after the phase steps, before the issue', async () => {
    await mkdir(join(root, '.ralph/prompts'), { recursive: true });
    await writeFile(join(root, '.ralph/prompts/merge.extra.md'), 'Also ping {{nobody}}.\n');
    const merge = await renderPrompt('merge', issue, config(), root);
    expect(merge).toMatch(/11\. \*\*Unblock[\s\S]*Also ping \{\{nobody\}\}\.[\s\S]*ISSUE TITLE/);
    expect(await renderPrompt('build', issue, config(), root)).not.toContain('Also ping');
  });
});
