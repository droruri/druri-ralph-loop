1. **Blockers**:
   - For each `#N` under the body's `## Blocked by` heading, check `gh api repos/{{repo}}/issues/N --jq .state`.
   - If any is still open: add the `{{labelBlocked}}` label to this issue and end your turn.

2. **Audit against `main`** (is it already done?):
   - Audit `origin/main` (`ralph run` fetched it). If `git rev-list --count origin/main..HEAD` is 0,
     the worktree **is** `main`: grep and run tests there. Otherwise read `main` without switching:
     `git grep <pattern> origin/main`, `git show origin/main:<path>`. For each acceptance
     criterion in the body, look for evidence on `main`: grep for the route / table / component /
     file it names, and find the test that covers it. Run only those test files if you need proof
     (not the whole suite).
{{#if investigator}}   - If the criteria name more than ~3 things to locate, delegate the search to one
     `{{investigator}}` Agent (pass it the criteria list, ask for a `file:line`
     table per criterion, code and covering test). Its compressed answer replaces your own greps
     and file dumps. Afterwards, read only the files you will actually change.
{{else}}   - Locate the things the criteria name yourself, batching all the greps in one message.
     Afterwards, read only the files you will actually change.
{{/if}}   - A code criterion is **met** only if the code exists *and* a test covers it. A doc criterion
     (ADR, README, explainer) is met if the file has that content.
   - Write the verdict to the progress file, one line per criterion: `met: <file:line / test>` or
     `missing: <what's lacking>`.
   - **All met** → check every box (step 9), close the issue (comment
     "Already on main: <evidence per criterion>", then PATCH `state=closed`),
     unblock dependents (step 11), set `step: done`. Finished — no branch, no PR.
   - **Some met** → check those boxes now (step 9). The rest of the run covers only the
     `missing` criteria.
   - Browser checks: see "Human-only work → split out". A criterion that needs hosted config,
     secrets or product sign-off → apply that rule.
   - **Only struck items remain** (all other criteria met, rest already split out) → close the
     issue (comment "Done; human-only items moved to #M", then PATCH `state=closed`),
     unblock dependents (step 11), set `step: done`. No branch, no PR.

3. **Branch Setup**:
   - Done by `ralph run`. Confirm `git branch --show-current` prints `{{branch}}`;
     if not, go to "If blocked". Don't create or switch branches.

4. **Planning Phase**:
{{#if planner}}   - Don't plan in your own context (it would ride along on every later turn). Spawn one
     `{{planner}}` Agent with this prompt: *"{{#if plan}}Run the `/{{plan}}` skill for Issue #{{issue}}{{else}}Write an implementation plan for Issue #{{issue}}{{/if}}, scoped to these missing criteria: <list>. Conventions
     already known: <what you learned in step 2>. Write the plan to
     `logs/issue-{{issue}}.plan.md` (max ~40 lines: each file to create/touch, what changes
     in it, which tests cover it). Reply only `done`."* Then read that plan file and follow it.
{{else}}   - Write the plan yourself{{#if plan}} with the `/{{plan}}` skill{{/if}}, scoped to the missing criteria, to
     `logs/issue-{{issue}}.plan.md` (max ~40 lines: each file to create/touch, what changes in it,
     which tests cover it). Then follow it.
{{/if}}   - **Skip this step** if the missing criteria touch at most 2 files and need no new migration,
     route or shared schema. Note `plan: skipped (small)` in the progress file and go to step 5.

5. **TDD Phase**:
{{#if tdd}}   - Run the `/{{tdd}}` skill: write failing tests covering the missing criteria,
     then write the code until they pass (red → green → refactor).
{{else}}   - Test first: write failing tests covering the missing criteria, then write the code until
     they pass (red → green → refactor), one small slice at a time.
{{/if}}   - While coding, run the single test file you're working on (not the whole suite) — step 6
     runs the checks once. Cap the output (`2>&1 | tail -30`); only if that shows a failure you
     can't read, re-run that one file verbosely. Don't run the full typecheck after each edit;
     step 6 runs it once.
   - Work in batches: read all the files you need in one go, write the related test and code
     files together, then run the tests — not one file per turn.

6. **Local Checks**:
{{#if check}}   - From the repo root run `{{check}}` and fix everything until green.
{{else}}   - From the repo root run the project's lint, typecheck and the tests related to the files
     you changed, and fix everything until green.
{{/if}}
7. **PR Creation**:
   - Commit changes, push the branch to GitHub, and open a Pull Request targeting `main`.
{{#if browserCheck}}   - Browser checks: for a UI change or a browser criterion, spawn the `{{browserCheck}}` Agent with
     the criteria and the worktree path before opening the PR; its verdict lines and screenshot
     paths go in the PR body. On `fail`, fix the product bug and re-run it (at most 2 re-runs,
     then record the open failure in the progress file and go on); only a setup failure splits
     the check.
{{else}}   - Browser checks: for a UI change or a browser criterion, check it yourself before opening the
     PR if your tools can drive a browser, and put the verdict in the PR body; otherwise split the
     criterion to `{{labelNeedsHuman}}` (see "Human-only work → split out").
{{/if}}   - Set the PR body to include `Closes #{{issue}}`. If you split out human-only work, the
     body also names each follow-up issue (`Human-only items moved to #M`).
