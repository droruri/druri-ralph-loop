// Single source of the CLI's explanations: `ralph explain` (and `--help`), the repo's README.md
// (`pnpm run docs` regenerates it) and the `.ralph/README.md` that `ralph init` writes.
import { getIn, parseConfig } from './config.ts';

export interface CommandDoc {
  /** The command word `ralph` dispatches on. */
  name: string;
  usage: string;
  summary: string;
  /** Documented ahead of its ticket; drop the flag when cli.ts dispatches it. */
  planned?: true;
}

/** Every command, including the ones prompts and the skill call (`progress`, `merge`, `prompt`). */
export const COMMANDS: CommandDoc[] = [
  {
    name: 'init',
    usage: 'ralph init [--yes]',
    summary:
      'Write .ralph/config.json, .ralph/README.md, the /ralph-issue skill and the .gitignore lines; --yes takes every default',
  },
  {
    name: 'run',
    usage: 'ralph run [N] [--model <model>]',
    summary:
      'Run the loop: every ready issue in turn, or only issue N; --model (e.g. opus) overrides models.build for this run',
  },
  {
    name: 'config',
    usage: 'ralph config get <key>',
    summary: 'Print a setting, e.g. models.build',
  },
  {
    name: 'config',
    usage: 'ralph config set <key> <value>',
    summary: 'Change a setting; the value is checked before it is saved',
  },
  {
    name: 'doctor',
    usage: 'ralph doctor',
    summary: 'Check that this project is ready to run the loop',
  },
  {
    name: 'explain',
    usage: 'ralph explain',
    summary: 'Print this explanation (same as ralph --help)',
  },
  {
    name: 'report',
    usage: 'ralph report [--attach-log]',
    summary:
      'Open an issue about ralph in droruri/druri-ralph-loop; shows what is sent and asks first',
  },
  {
    name: 'upgrade',
    usage: 'ralph upgrade [--yes]',
    summary:
      'Rewrite the files ralph owns in this project (the /ralph-issue skill, .ralph/README.md) and print the old and new versions; asks before replacing a hand-edited skill (--yes replaces it)',
  },
  {
    name: 'progress',
    usage: 'ralph progress pull|push <N>',
    summary:
      "Sync logs/issue-<N>.progress.md with the issue's progress comment (used by the prompts)",
  },
  {
    name: 'worktree',
    usage: 'ralph worktree create|remove <N>',
    summary:
      "Create issue N's worktree under .ralph/wt/ (running commands.install) and print its path, or remove it (used by the skill)",
  },
  {
    name: 'merge',
    usage: 'ralph merge <N>',
    summary:
      "Wait for CI on issue N's PR, merge it, close the issue; exit 1 when the merge phase needs Claude",
  },
  {
    name: 'prompt',
    usage: 'ralph prompt build|review|merge <N>',
    summary: 'Print the prompt for one phase of issue N',
  },
];

export interface ConfigDoc {
  doc: string;
  /** Shown instead of the schema default, for keys whose default depends on another key. */
  default?: string;
}

const UNSET_ROLE = 'Unset: that step runs inline in the phase session.';

/** One entry per config key, in dotted form; a test checks this against the schema. */
export const CONFIG_DOCS: Record<string, ConfigDoc> = {
  repo: {
    doc: 'The GitHub repository the loop works on, as owner/name. Detected from the origin remote.',
  },
  'labels.pickLabel': { doc: 'Label of the issues the loop picks. "" picks any open issue.' },
  'labels.blocked': { doc: 'Label for an issue waiting on an open issue under its ## Blocked by.' },
  'labels.needsHuman': {
    doc: 'Label for an issue (or split-out part) only a person can finish; the loop skips it.',
  },
  'labels.lock': {
    doc: 'Label on the issue a run is working on, so two runs never take the same issue.',
  },
  'models.build': { doc: 'Claude model for the build phase.' },
  'models.review': { doc: 'Claude model for the review phase.' },
  'models.merge': { doc: 'Claude model for the merge phase.' },
  'models.escalation': {
    doc: 'One more pass on opus when an issue is still open after all phases (not when build already ran on opus).',
  },
  phases: { doc: 'The phases each issue runs, in order.' },
  smallDiffLines: {
    doc: 'A diff under this many changed lines gets one reviewer; a larger one gets the parallel reviewers.',
  },
  'commands.install': {
    doc: 'Runs in each new worktree, e.g. pnpm install --frozen-lockfile. Detected from the lockfile.',
  },
  'commands.check': { doc: 'Lint, typecheck and related tests, run before each push.' },
  'commands.diffExclude': {
    doc: 'Paths left out of the diff size, e.g. lockfiles. No quotes or newlines.',
  },
  specDoc: {
    doc: 'The project spec the prompts point to, e.g. docs/plan.md. Unset: the issue body is the only spec.',
  },
  'subagents.investigator': {
    doc: `Agent type that locates the code the acceptance criteria name. ${UNSET_ROLE}`,
  },
  'subagents.planner': { doc: `Agent type that writes the implementation plan. ${UNSET_ROLE}` },
  'subagents.reviewer.type': { doc: `Agent type that reviews the diff. ${UNSET_ROLE}` },
  'subagents.reviewer.parallel': {
    doc: 'How many reviewers a large diff gets, split between standards and spec.',
    default: 'default 1 when reviewer.type is set',
  },
  'subagents.browserCheck': {
    doc: 'Agent type that checks browser criteria. Unset: the phase checks them itself if its tools allow, else splits them to needs-human.',
  },
  'skills.tdd': {
    doc: 'Skill the build phase uses to write tests first. Unset: plain red, green, refactor.',
  },
  'skills.plan': { doc: 'Skill used to write the plan. Unset: a plain plan.' },
  plugins: {
    doc: 'Extra Claude Code plugins (name or name@marketplace); the plugins of plugin:name agent types and skills are added on top. A run enables only these.',
  },
  'merge.method': { doc: 'How the PR is merged: squash, merge or rebase.' },
  'merge.auto': {
    doc: 'Not read yet: `ralph run` always merges a green PR (false is reserved for stopping at a green PR).',
  },
};

interface Section {
  title: string;
  /** Lines shared by the plain-text and markdown output; `- ` starts a list item. */
  lines: string[];
}

const INTRO =
  'ralph runs the ralph issue loop in any GitHub project: it picks ready issues and runs Claude Code through build, review and merge for each one.';

const SECTIONS: Section[] = [
  {
    title: 'Install',
    lines: [
      'Needs Node 22.18+, 24.11+ or 26+, git, the GitHub CLI (gh, logged in) and Claude Code (claude, logged in).',
      '- Build a package: clone droruri/druri-ralph-loop, then `pnpm install && pnpm build && npm pack`.',
      '- Install it: `npm i -g ./druri-ralph-loop-<version>.tgz`.',
      '- In your project: `ralph init`, then `ralph doctor`.',
    ],
  },
  {
    title: 'Start the loop',
    lines: [
      '- `ralph run`: work through the whole queue, oldest ready issue first.',
      '- `ralph run <N>`: run only issue N.',
      '- `ralph run --model opus`: build on opus for this run (review and merge keep their models).',
      '- Ctrl-C stops the run and removes the lock label. An issue still open after all phases stops the run and keeps its worktree; logs and the cost ledger (ralph-costs.tsv) are in .ralph/logs/.',
      '- `/ralph-issue <N> [interactive] [build|review|merge] [--model <model>]` inside a Claude Code session: run issue N in that session, each phase as a subagent. `ralph init` writes the skill to .claude/skills/ralph-issue/ and `ralph upgrade` rewrites it; it reads models and labels from the config each time it runs.',
    ],
  },
  {
    title: 'Phases',
    lines: [
      'Each issue runs in its own worktree under .ralph/wt/, one Claude session per phase. Progress lives in a comment on the issue, so a stopped run resumes. Work only a person can do is split into a new issue labeled needs-human. An issue still open after all phases gets one more pass on opus (models.escalation).',
      '- build: checks blockers, audits main for criteria already met, plans, writes tests first, codes, runs the checks, opens the PR. A small diff is also reviewed here.',
      '- review: reviews the diff for standards and spec, fixes the findings, ticks the acceptance-criteria boxes. Skipped when build already reviewed.',
      '- merge: `ralph merge <N>` waits for CI, merges, closes the issue, deletes the branch and unblocks dependents. Checks that are also red on main do not block the merge; it opens a `main is red` issue for them instead. A Claude session runs only when CI is red or the merge needs a decision.',
    ],
  },
  {
    title: 'Labels',
    lines: [
      '- pick label (labels.pickLabel): the loop takes only issues with it.',
      '- blocked (labels.blocked): an issue under ## Blocked by is still open; `ralph merge` removes it once all are closed.',
      '- needs-human (labels.needsHuman): only a person can finish it; the loop skips it.',
      '- lock (labels.lock): a run is working on the issue; removed when the run ends.',
    ],
  },
  {
    title: 'Issue format',
    lines: [
      'The issue body is the spec and the scope.',
      '- An acceptance-criteria checklist (`- [ ] ...`): the loop ticks each box once code and a test cover it.',
      '- A `## Blocked by` heading with one `- #N` line per issue that must close first.',
    ],
  },
];

const CONFIG_INTRO =
  'Settings live in .ralph/config.json. Change them with `ralph config set <key> <value>`. Phase prompts can be extended with .ralph/prompts/<phase>.extra.md.';

// Schema defaults; `repo` has none, so a placeholder makes the config parse.
const DEFAULTS = parseConfig({ repo: 'owner/name' });

function defaultText(key: string, entry: ConfigDoc): string {
  if (entry.default !== undefined) return entry.default;
  if (key === 'repo') return 'required';
  const value = DEFAULTS.ok ? getIn(DEFAULTS.config, key) : undefined;
  return value === undefined ? 'unset' : `default ${JSON.stringify(value)}`;
}

const pad = (text: string, width: number) => text.padEnd(width);

function commandLines(): string[] {
  const width = Math.max(...COMMANDS.map((c) => c.usage.length)) + 2;
  return COMMANDS.map((c) => `  ${pad(c.usage, width)}${c.summary}`);
}

/** The command list `ralph` prints on a usage error. */
export function usage(): string {
  return ['Usage: ralph <command>', '', ...commandLines()].join('\n');
}

const plain = (line: string) => line.replaceAll('`', '');

/** `ralph explain` and `ralph --help`. */
export function renderExplain(): string {
  const keyWidth = Math.max(...Object.keys(CONFIG_DOCS).map((k) => k.length)) + 2;
  const out = [INTRO, ''];
  for (const section of SECTIONS) {
    out.push(section.title.toUpperCase(), ...section.lines.map((l) => `  ${plain(l)}`), '');
  }
  out.push('COMMANDS', ...commandLines(), '');
  out.push('CONFIG', `  ${plain(CONFIG_INTRO)}`);
  for (const [key, entry] of Object.entries(CONFIG_DOCS)) {
    out.push(`  ${pad(key, keyWidth)}${defaultText(key, entry)}`, `      ${entry.doc}`);
  }
  return out.join('\n');
}

/** The repo's README.md. */
export function renderReadme(): string {
  const out = [
    '# druri-ralph-loop',
    '',
    '<!-- Generated from src/docs.ts by `pnpm run docs`. Do not edit by hand. -->',
    '',
    INTRO,
    '',
  ];
  for (const section of SECTIONS) {
    out.push(`## ${section.title}`, '', ...section.lines, '');
  }
  out.push('## Commands', '', ...COMMANDS.map((c) => `- \`${c.usage}\`: ${c.summary}`), '');
  out.push('## Config', '', CONFIG_INTRO, '');
  for (const [key, entry] of Object.entries(CONFIG_DOCS)) {
    out.push(`- \`${key}\` (${defaultText(key, entry)}): ${entry.doc}`);
  }
  return `${out.join('\n')}\n`;
}

/** The short `.ralph/README.md` that `ralph init` writes into a project. */
export function renderProjectReadme(): string {
  return [
    '# .ralph',
    '',
    'Settings for the ralph issue loop (https://github.com/droruri/druri-ralph-loop).',
    '',
    '- config.json: the settings; change them with `ralph config set <key> <value>`.',
    '- prompts/<phase>.extra.md: optional text added to a phase prompt.',
    '- ../.claude/skills/ralph-issue/SKILL.md: the /ralph-issue skill; `ralph upgrade` rewrites it.',
    '- wt/ and logs/: worktrees and logs of runs (gitignored).',
    '',
    'Run `ralph explain` for the commands, phases, labels, issue format and every setting.',
    '',
  ].join('\n');
}
