<!--
  Liliput PR template. The Release Manager agent reads this. Be precise.
  Do not delete sections — leave them empty if not applicable (write "N/A").
-->

## Closes
Closes #<!-- issue number — REQUIRED. RM rejects PRs without this. -->

## Summary
<!-- 2–4 sentences. What changed and why. -->

## Acceptance criteria check
<!--
  Copy the AC list from the linked issue verbatim, then tick each box
  and point to the test(s) that prove it.
-->
- [ ] **AC1:** <text> → covered by `path/to/test.spec.ts::test name`
- [ ] **AC2:** <text> → covered by `path/to/test.feature::scenario name`

## Test evidence
<!--
  How do we know this works?
  - Which tests were added / changed?
  - Paste a run summary (e.g. `vitest`, `cucumber-js`, or `playwright test` output).
  - For UI changes: include a screenshot or short clip.
-->

```
<paste test run summary here>
```

## Scope check
- [ ] No files changed outside the scope declared in the issue.
- [ ] No items from the issue's **Out of scope** list were touched.
- [ ] No new dependencies added (or: dependency changes are listed below with justification).

## Self-review notes
<!--
  Anything the reviewer should look at first?
  Trade-offs, edge cases considered, follow-ups deferred to other issues.
-->

## Liliput
<!-- Filled in by the dev agent. Leave as N/A if a human authored this PR. -->
- Liliput task id:
- Dev agent:
- Retry count (set by RM):
