# druri-ralph-loop

<!-- Generated from src/docs.ts by `pnpm run docs`. Do not edit by hand. -->

ralph runs the ralph issue loop in any GitHub project: it picks ready issues and runs Claude Code through build, review and merge for each one.

## Install

Needs Node 22.18+, 24.11+ or 26+, git, the GitHub CLI (gh, logged in) and Claude Code (claude, logged in).
- Build a package: clone droruri/druri-ralph-loop, then `pnpm install && pnpm build && npm pack`.
- Install it: `npm i -g ./druri-ralph-loop-<version>.tgz`.
- In your project: `ralph init`, then `ralph doctor`.

## Start the loop

- `ralph run`: work through the whole queue, oldest ready issue first.
- `ralph run <N>`: run only issue N.
- `ralph run --model opus`: build on opus for this run (review and merge keep their models).
- Ctrl-C stops the run and removes the lock label. An issue still open after all phases stops the run and keeps its worktree; logs and the cost ledger (ralph-costs.tsv) are in .ralph/logs/.
- `/ralph-issue <N> [interactive] [build|review|merge] [--model <model>]` inside a Claude Code session: run issue N in that session, each phase as a subagent. `ralph init` writes the skill to .claude/skills/ralph-issue/ and `ralph upgrade` rewrites it; it reads models and labels from the config each time it runs.

## Phases

Each issue runs in its own worktree under .ralph/wt/, one Claude session per phase. Progress lives in a comment on the issue, so a stopped run resumes. Work only a person can do is split into a new issue labeled needs-human. An issue still open after all phases gets one more pass on opus (models.escalation).
- build: checks blockers, audits main for criteria already met, plans, writes tests first, codes, runs the checks, opens the PR. A small diff is also reviewed here.
- review: reviews the diff for standards and spec, fixes the findings, ticks the acceptance-criteria boxes. Skipped when build already reviewed.
- merge: `ralph merge <N>` waits for CI, merges, closes the issue, deletes the branch and unblocks dependents. Checks that are also red on main do not block the merge; it opens a `main is red` issue for them instead. A Claude session runs only when CI is red or the merge needs a decision.

## Labels

- pick label (labels.pickLabel): the loop takes only issues with it.
- blocked (labels.blocked): an issue under ## Blocked by is still open; `ralph merge` removes it once all are closed.
- needs-human (labels.needsHuman): only a person can finish it; the loop skips it.
- lock (labels.lock): a run is working on the issue; removed when the run ends.

## Issue format

The issue body is the spec and the scope.
- An acceptance-criteria checklist (`- [ ] ...`): the loop ticks each box once code and a test cover it.
- A `## Blocked by` heading with one `- #N` line per issue that must close first.

## Commands

- `ralph init [--yes]`: Write .ralph/config.json, .ralph/README.md, the /ralph-issue skill and the .gitignore lines; --yes takes every default
- `ralph run [N] [--model <model>]`: Run the loop: every ready issue in turn, or only issue N; --model (e.g. opus) overrides models.build for this run
- `ralph config get <key>`: Print a setting, e.g. models.build
- `ralph config set <key> <value>`: Change a setting; the value is checked before it is saved
- `ralph doctor`: Check that this project is ready to run the loop
- `ralph explain`: Print this explanation (same as ralph --help)
- `ralph report [--attach-log]`: Open an issue about ralph in droruri/druri-ralph-loop; shows what is sent and asks first
- `ralph upgrade [--yes]`: Rewrite the files ralph owns in this project (the /ralph-issue skill, .ralph/README.md) and print the old and new versions; asks before replacing a hand-edited skill (--yes replaces it)
- `ralph progress pull|push <N>`: Sync logs/issue-<N>.progress.md with the issue's progress comment (used by the prompts)
- `ralph worktree create|remove <N>`: Create issue N's worktree under .ralph/wt/ (running commands.install) and print its path, or remove it (used by the skill)
- `ralph merge <N>`: Wait for CI on issue N's PR, merge it, close the issue; exit 1 when the merge phase needs Claude
- `ralph prompt build|review|merge <N>`: Print the prompt for one phase of issue N

## Config

Settings live in .ralph/config.json. Change them with `ralph config set <key> <value>`. Phase prompts can be extended with .ralph/prompts/<phase>.extra.md.

- `repo` (required): The GitHub repository the loop works on, as owner/name. Detected from the origin remote.
- `labels.pickLabel` (default "ready-for-agent"): Label of the issues the loop picks. "" picks any open issue.
- `labels.blocked` (default "blocked"): Label for an issue waiting on an open issue under its ## Blocked by.
- `labels.needsHuman` (default "needs-human"): Label for an issue (or split-out part) only a person can finish; the loop skips it.
- `labels.lock` (default "ralph:running"): Label on the issue a run is working on, so two runs never take the same issue.
- `models.build` (default "sonnet"): Claude model for the build phase.
- `models.review` (default "haiku"): Claude model for the review phase.
- `models.merge` (default "haiku"): Claude model for the merge phase.
- `models.escalation` (default true): One more pass on opus when an issue is still open after all phases (not when build already ran on opus).
- `phases` (default ["build","review","merge"]): The phases each issue runs, in order.
- `smallDiffLines` (default 150): A diff under this many changed lines gets one reviewer; a larger one gets the parallel reviewers.
- `commands.install` (default ""): Runs in each new worktree, e.g. pnpm install --frozen-lockfile. Detected from the lockfile.
- `commands.check` (default ""): Lint, typecheck and related tests, run before each push.
- `commands.diffExclude` (default []): Paths left out of the diff size, e.g. lockfiles. No quotes or newlines.
- `specDoc` (unset): The project spec the prompts point to, e.g. docs/plan.md. Unset: the issue body is the only spec.
- `subagents.investigator` (unset): Agent type that locates the code the acceptance criteria name. Unset: that step runs inline in the phase session.
- `subagents.planner` (unset): Agent type that writes the implementation plan. Unset: that step runs inline in the phase session.
- `subagents.reviewer.type` (unset): Agent type that reviews the diff. Unset: that step runs inline in the phase session.
- `subagents.reviewer.parallel` (default 1 when reviewer.type is set): How many reviewers a large diff gets, split between standards and spec.
- `subagents.browserCheck` (unset): Agent type that checks browser criteria. Unset: the phase checks them itself if its tools allow, else splits them to needs-human.
- `skills.tdd` (unset): Skill the build phase uses to write tests first. Unset: plain red, green, refactor.
- `skills.plan` (unset): Skill used to write the plan. Unset: a plain plan.
- `plugins` (default []): Extra Claude Code plugins (name or name@marketplace); the plugins of plugin:name agent types and skills are added on top. A run enables only these.
- `merge.method` (default "squash"): How the PR is merged: squash, merge or rebase.
- `merge.auto` (default true): Not read yet: `ralph run` always merges a green PR (false is reserved for stopping at a green PR).
