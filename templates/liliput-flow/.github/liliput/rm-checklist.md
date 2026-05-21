# Release Manager Checklist

> The RM agent runs this list **in order**. Any unchecked item is a blocker.
> The RM does not make judgment calls — it only verifies. If a rule is ambiguous,
> escalate with `blocked:human` and stop.

## 0. Preconditions
- [ ] PR body contains a `Closes #<n>` reference.
- [ ] Linked issue exists, is open, and has label `dev:in-progress` (or `rm:changes-requested` on a retry).
- [ ] PR branch is up to date with `main`. If not → label `dev:rebase-needed`, comment, stop.

## 1. CI & build
- [ ] All required GitHub checks are green (no failed, no pending).
- [ ] Lint passes for every package that changed.
- [ ] Build passes for every package that changed.
- [ ] No new `test.skip`, `it.only`, `describe.only`, or commented-out test introduced by this PR.

## 2. Acceptance-criteria traceability
- [ ] Every AC in the issue is checked off in the PR body.
- [ ] Every AC checkbox points to a real test path that exists on this branch.
- [ ] At least one of those tests was added or modified by this PR (i.e. the AC is not just claimed against pre-existing tests with no diff).

## 3. Scope
- [ ] No file changed outside the scope declared in the issue's body / suggested approach.
- [ ] None of the items in the issue's **Out of scope** list were modified.
- [ ] No new runtime dependency added that is not justified in the PR body.

## 4. Coverage & quality (soft gates — warn, don't block, unless egregious)
- [ ] Coverage on files touched by this PR did not drop more than 2 percentage points.
- [ ] No new TODO/FIXME/XXX comments without a linked follow-up issue.

## 5. Decision
Exactly one of:

- **Approve + squash-merge.** Comment with `RM: ✅ merged. AC1..N verified by <test paths>.` Close the issue with `done` label.
- **Request changes.** Comment with a numbered list mapping each failed check to the exact AC/file/test. Apply `rm:changes-requested`, remove `rm:review`. Increment retry counter in the PR body.
- **Escalate.** Apply `blocked:human`, remove `rm:review`, comment with a precise question.

## Retry budget
- Default: **10** dev↔RM round-trips per PR.
- On retry N (where N = budget), RM does **not** request changes a further time. It applies `blocked:human` with a summary of all prior round-trips and stops.

## What RM never does
- Never edits the PR's code.
- Never re-interprets the AC. If AC are ambiguous → `blocked:human`, addressed to the PM agent.
- Never approves a PR whose `Closes #N` issue is closed or missing.
- Never merges without all required checks green.
