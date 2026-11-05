**Review scope (the `review` phase, run on the cheap model).** The phase relays review findings
and fixes them. Nothing else. The `build` session, when it runs steps 8-9 itself, is not bound by
this block.
   - Allowed: {{#if reviewer}}spawn the reviewers{{else}}review the diff{{/if}}, fix the findings, run step 6, push, flip the
     checklist, and {{#if browserCheck}}spawn the `{{browserCheck}}` Agent for browser checks{{else}}check browser criteria yourself if your tools allow it{{/if}} (the only ad-hoc
     verification allowed).
   - Not allowed: any other ad-hoc script (shell, node, python) written to verify behavior, edits
     to the project's ralph setup (`.ralph/`) unless the issue itself is about it, and work on
     anything the findings and acceptance criteria do not name.
{{#if browserCheck}}   - A criterion that needs a browser check: spawn the `{{browserCheck}}` Agent with the criterion and
     the worktree path. `pass` → flip its box and note the verdict in the progress file. `fail` →
     record it as a finding and fix it. A setup failure → split per "Human-only work" with the
     failure pasted in.
{{else}}   - A criterion that needs a browser check: check it yourself if your tools can drive a browser.
     Otherwise split it to `{{labelNeedsHuman}}` per "Human-only work".
{{/if}}   - Turn budget: **25 turns**. {{#if reviewer}}Spawning the reviewers{{else}}Reviewing{{/if}}, fixing and pushing fit well inside it. At
     turn 20, stop adding fixes: push what passes step 6, record the unfixed findings in the
     progress file under `review findings:` (`open: …`), set `next: step 10`, and end your turn.

8. **Code Review Phase**:
   - Size the diff: `git diff --shortstat main...HEAD{{diffExclude}}`.
{{#if reviewer}}   - **Small (under ~{{smallDiffLines}} changed lines):** one `{{reviewer}}` Agent covering both
     axes (Standards = the project's `CLAUDE.md` conventions, Spec = every acceptance criterion). In
     `build`, do this right after step 7 (see "Phases").
{{#if reviewerSplit}}   - **Otherwise:** {{reviewerParallel}} `{{reviewer}}` Agents **in one message** (parallel), split
     between the two axes: Standards and Spec.
{{else}}   - **Otherwise:** the same, one `{{reviewer}}` Agent covering both axes.
{{/if}}   - Give every reviewer: the issue number, the acceptance criteria (copied, not paraphrased), the
     diff command `git diff main...HEAD{{diffExclude}}`, and these limits: *"Run the diff
     command once. Open another file only to confirm a finding you already suspect from the diff —
     no exploring. At most ~10 tool calls. One line per finding; none → `no findings`."*
   - Do **not** read the diff yourself (no `git diff` output, no diff file in `/tmp`). You only
     take in the findings, then open just the hunks you need to fix.
   - Guard against a reviewer reviewing the wrong thing: tell each reviewer to start its reply with
     `issue #{{issue}}` and the file list from `git diff --stat main...HEAD{{diffExclude}}`.
     Compare that list with `git diff --name-only main...HEAD{{diffExclude}}` (names only,
     cheap). If it cites another issue or files outside the diff, discard its output and re-run it
     once; a second mismatch → "If blocked". Never record "0 findings" from a mismatched reviewer.
{{else}}   - Review the diff yourself (`git diff main...HEAD{{diffExclude}}`, read once) on two axes:
     Standards (the project's `CLAUDE.md` conventions) and Spec (every acceptance criterion). Note
     one line per finding. In `build`, do this right after step 7 when the diff is under
     ~{{smallDiffLines}} changed lines (see "Phases").
{{/if}}   - Fix any critical bugs or style issues found during the review, re-run step 6, and push.

9. **Update Issue Checklist in GitHub**:
   - Fetch the current body (`gh api repos/{{repo}}/issues/{{issue}} --jq .body > logs/issue-{{issue}}.body.md`
     — it may have changed since your prompt), flip the done items from `- [ ]` to `- [x]`, and
     save it with `gh api -X PATCH repos/{{repo}}/issues/{{issue}} -F body=@logs/issue-{{issue}}.body.md`.
   - Leave struck lines (`- [ ] ~~…~~ → moved to #M`) as they are; never flip them to `[x]`.
