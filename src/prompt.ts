// Builds the prompt for one phase of one issue from the shipped `prompts/*.md` and the config.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Config, Phase } from './config.ts';
import { isNotFound } from './fs.ts';
import { branchName, type Issue } from './github.ts';

// Same relative path from `src/` (tests) and `dist/` (the built package).
const PROMPTS = resolve(import.meta.dirname, '../prompts');

export type PromptVars = Record<string, string | undefined>;

// Innermost block: its body holds no further `{{#if`.
const BLOCK =
  /\{\{#if (\w+)\}\}((?:(?!\{\{#if )[\s\S])*?)(?:\{\{else\}\}((?:(?!\{\{#if )[\s\S])*?))?\{\{\/if\}\}/;

function lookup(vars: PromptVars, key: string): string | undefined {
  if (!Object.hasOwn(vars, key)) throw new Error(`unknown prompt variable: ${key}`);
  return vars[key];
}

/** `{{var}}` and `{{#if key}}…{{else}}…{{/if}}` (key set = defined and not ''). Nothing else. */
export function render(template: string, vars: PromptVars): string {
  let text = template;
  for (let match = BLOCK.exec(text); match !== null; match = BLOCK.exec(text)) {
    const [whole, key = '', then = '', otherwise = ''] = match;
    const value = lookup(vars, key);
    const chosen = value !== undefined && value !== '' ? then : otherwise;
    text = text.slice(0, match.index) + chosen + text.slice(match.index + whole.length);
  }
  // Checked before substitution, so a `{{` inside a config value is left alone.
  const stray = /\{\{(?!\w+\}\})/.exec(text);
  if (stray !== null)
    throw new Error(`unrendered prompt tag at: ${text.slice(stray.index, stray.index + 20)}`);
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => lookup(vars, key) ?? '');
}

/** The template variables for one phase of issue `n`; unset roles and skills stay undefined. */
export function promptVars(config: Config, phase: Phase, n: number): PromptVars {
  const { reviewer } = config.subagents;
  const parallel = reviewer?.parallel ?? 1;
  return {
    issue: String(n),
    branch: branchName(n),
    phase,
    repo: config.repo,
    specDoc: config.specDoc,
    check: config.commands.check,
    install: config.commands.install,
    diffExclude:
      config.commands.diffExclude.length === 0
        ? ''
        : ` -- .${config.commands.diffExclude.map((path) => ` ':!${path}'`).join('')}`,
    mergeMethod: config.merge.method,
    smallDiffLines: String(config.smallDiffLines),
    labelBlocked: config.labels.blocked,
    labelNeedsHuman: config.labels.needsHuman,
    investigator: config.subagents.investigator,
    planner: config.subagents.planner,
    reviewer: reviewer?.type,
    reviewerParallel: String(parallel),
    reviewerSplit: parallel >= 2 ? 'yes' : undefined,
    browserCheck: config.subagents.browserCheck,
    tdd: config.skills.tdd,
    plan: config.skills.plan,
  };
}

/**
 * The full prompt for one phase: shared + phase steps (build also gets the review steps), then the
 * project's `.ralph/prompts/<phase>.extra.md` and the issue, both appended as-is.
 */
export async function renderPrompt(
  phase: Phase,
  issue: Pick<Issue, 'number' | 'title' | 'body'>,
  config: Config,
  root: string,
): Promise<string> {
  const vars = promptVars(config, phase, issue.number);
  const parts = ['shared', phase, ...(phase === 'build' ? ['review'] : [])];
  const sections = await Promise.all(
    parts.map(async (part) => render(await readFile(join(PROMPTS, `${part}.md`), 'utf8'), vars)),
  );
  const extra = await readExtra(join(root, '.ralph/prompts', `${phase}.extra.md`));
  if (extra !== undefined) sections.push(extra);
  sections.push(`ISSUE TITLE: ${issue.title}\n\nISSUE DETAILS & CHECKLIST:\n${issue.body ?? ''}\n`);
  return sections.join('\n');
}

async function readExtra(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}
