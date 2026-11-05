10. **Wait for CI, then Merge**:
    - Prefer `ralph merge {{issue}}`: it waits for CI, merges ({{mergeMethod}}), closes the issue and
      unblocks dependents (all REST). Exit 0 → set `step: done`.
    - If CI is red: read the failing log (`gh api repos/{{repo}}/actions/runs/<RUN_ID>/jobs`,
      then `.../actions/jobs/<JOB_ID>/logs | tail -80`), fix, push, and run it again.
    - Merge by hand only if `ralph merge` cannot: `gh api -X PUT repos/{{repo}}/pulls/<PR>/merge -f merge_method={{mergeMethod}}`
      once CI is green.

11. **Unblock Dependent Tasks**:
    - `ralph merge` does this. By hand: list open issues labeled `{{labelBlocked}}`
      (`gh api "repos/{{repo}}/issues?state=open&labels={{labelBlocked}}"`) whose body mentions
      `#{{issue}}`, and remove the `{{labelBlocked}}` label only if **every** issue under its
      `## Blocked by` is now closed.
