---
name: ralph-issue
description: Run one GitHub issue through the ralph loop inside this Claude session. Each phase (build, review, merge) runs as its own fresh subagent on the prompt `ralph prompt` prints, and the agents those prompts call for are spawned too. Use when the user types /ralph-issue N or asks to "ralph issue N".
argument-hint: <issue-number> [interactive] [build|review|merge] [--model <model>]
disable-model-invocation: true
---

# Ralph loop for one issue: `$ARGUMENTS`

You are the orchestrator. You do the job `ralph run <N>` does for a single issue, and nothing else.
You don't read code or diffs and you don't do the steps yourself. Every phase runs in a fresh
subagent, the way `ralph run` starts a fresh `claude` process for each phase. The progress file
`logs/issue-N.progress.md` in the issue's worktree is the only hand-off between phases.

Settings come from `.ralph/config.json` at run time, through `ralph config get <key>`. Never
assume a model, label, repository or agent type: read it. The phase prompts come from
`ralph prompt <phase> <N>` and already hold the project's rules; don't restate or change them.

## 1. Arguments

- First token: the issue number (`N` below). Missing or not a number → stop and ask for one.
- A phase name (`build`, `review` or `merge`) → run only that phase. Otherwise run the phases
  `ralph config get phases` lists, in order.
- `--model <model>` → use it for the build phase instead of `models.build` (like `ralph run --model`).
- `interactive` → phase agents bring decisions to the user (see step 5). The default is the
  hands-off behavior of `ralph run`.

## 2. Pre-flight (one Bash call)

Read the settings: `ralph config get repo`, `labels.lock`, `labels.blocked`,
`labels.needsHuman`, `models.build`, `models.review`, `models.merge`, `phases`. Below, `<repo>`,
`<lock>` and so on are those values.

- Use REST only (`gh api repos/<repo>/...`): cloud sessions block GraphQL, so no
  `gh issue|pr <subcommand>`. Run `gh api repos/<repo>/issues/N` (`.state`, `.title`,
  `.labels[].name`):
  - closed → report and stop;
  - labeled `<needsHuman>` or `<blocked>` → report and stop;
  - labeled `<lock>` → another ralph run holds it: report and stop;
  - otherwise it's open.
- Lock it: `gh api repos/<repo>/issues/N/labels -f 'labels[]=<lock>'`. From here on, every stop
  (a failure, a stuck phase, a closed issue) goes through step 7, which removes the lock.
- `WT=$(ralph worktree create N)` and note the path `WT`. If it exits non-zero or prints nothing,
  go to step 7 and report the error. All work happens there; your own checkout is never
  switched, so uncommitted changes in it don't matter.
- `cd "$WT" && ralph progress pull N`.

## 3. Run each phase as a subagent

For each phase, run `ralph prompt <phase> N` (from your own checkout) and keep its output verbatim as
`<PROMPT>`. Then spawn **one** `general-purpose` Agent with `model` set to the phase's model
(build: `--model` or `<models.build>`; review: `<models.review>`; merge: `<models.merge>`) and
`description: "ralph #N <phase>"`. The Agent tool takes model aliases; if it rejects the configured
value, leave `model` unset and say so in the report. Use this prompt:

````
<PROMPT>

## Running as a subagent

Your working directory is this issue's worktree, <WT>. Work only inside it: start every Bash
command with `cd <WT> &&` and give Read/Edit absolute paths under <WT>. You run under the
`/ralph-issue` orchestrator, not `ralph run`: where the instructions say `ralph run` does
something (pull progress, wait for CI, merge), the orchestrator does it.

You cannot launch agents yourself. Wherever the instructions above (or a skill they tell you to
run) say to spawn an Agent, do this instead: write the progress file, then end your reply with
one block per agent to launch, and stop:

AGENT_REQUEST type=<subagent_type>
<the full prompt that agent should get>
END_AGENT_REQUEST

Put agents that should run in parallel (such as the standards and spec reviewers) in the same
reply. Their replies come back to you in a message, labeled by type. Continue the step from
exactly where you stopped.

<interactive only> Where the instructions say "If blocked", or where a real design choice comes
up that the issue doesn't settle, don't label the issue yet. End your reply with
`DECISION_NEEDED: <question with options>` and stop. The answer comes back in a message. Before
merging a PR, end with `DECISION_NEEDED: merge PR <url>? CI: <result>`.

When the phase is finished (or you stopped under "If blocked"), end with
`PHASE_DONE: <one line: outcome and the progress file's next: line>`.
````

## 4. Relay loop (inside one phase)

Read the phase agent's last reply:

- **`AGENT_REQUEST` blocks** → launch every requested agent **in one message**, so they run in
  parallel, with the requested `subagent_type` and prompt. Then load `SendMessage` (ToolSearch
  `select:SendMessage`) and send the combined replies to the **same** phase agent, one section
  per agent:

  ```
  ## <type> reply
  <reply>
  ```

  Don't read or judge the replies yourself; they're the phase agent's input.
- **`DECISION_NEEDED`** (interactive only) → ask the user with AskUserQuestion. Send the answer
  back with SendMessage.
- **`PHASE_DONE`** or anything else → the phase is over. Go to step 6.

Cap each phase at 8 relays. If a phase still isn't done after that, treat it as stuck: go to
step 7 and report.

## 5. Interactive vs default

- **Default:** the same as `ralph run`. Nothing is asked. "If blocked" means the phase agent
  adds `<needsHuman>`, posts a comment, and stops. The merge happens as soon as CI is green.
- **`interactive`:** the steps and the agents are the same. The only difference is that the
  `DECISION_NEEDED` points from step 3 go to the user.

## 6. Between phases (the same checks as `ralph run`)

Run `gh api repos/<repo>/issues/N --jq '{state, labels: [.labels[].name]}'`.

- **Closed** → go to step 7. The issue is done, or it was found all met on the main branch.
- **`<needsHuman>` or `<blocked>`** → go to step 7. Quote the comment that ralph posted.
- **Open** → pick the next phase:
  - `review`, and `$WT/logs/issue-N.progress.md` has a line starting `next: step 10`: the build
    already did the small review. Skip it.
  - Otherwise spawn the next phase's agent, fresh. Don't reuse the previous phase's agent.
  - No phase left → go to step 7. This is the "still open after all phases" case.

**Before any merge phase** (also when `merge` is the only phase asked for), unless `interactive`:
run `ralph merge N` in Bash with the longest timeout (600000 ms); it waits for CI, merges and
closes the issue. Exit 0 means merged: go to step 7. On any other exit (or a timeout), check the
issue as above first: closed → step 7; still open → spawn the merge agent. With `interactive`, the
merge agent asks before merging instead.

## 7. Clean up and report

- `gh api -X DELETE repos/<repo>/issues/N/labels/<lock>` (URL-encode `<lock>`, e.g. `:` → `%3A`).
- Issue closed → `ralph worktree remove N`. Otherwise keep the worktree and give its path.

Report:

- The issue state.
- The PR: `gh api "repos/<repo>/pulls?head=<owner>:feature/issue-N&state=all" --jq '.[] | {number, state, html_url}'`
  (`<owner>` is the part of `<repo>` before the `/`).
- Which phases ran, and each phase's `PHASE_DONE` line.

If the issue isn't closed, also include the progress file (`cat "$WT/logs/issue-N.progress.md"`)
and the command to resume: `/ralph-issue N [<phase>]`. Step 0 of each phase prompt resumes from
the progress file.
