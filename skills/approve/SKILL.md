---
name: approve
description: Approve a GitHub epic and ready its eligible sub-issues using the configured risk policy. Never merges.
argument-hint: "#<epic>"
disable-model-invocation: true
---

# /devflow:approve

Arguments: $ARGUMENTS

## Approve the epic

1. Accept one positive issue number with an optional leading `#`. Read `.claude/devflow.json` and use `github.owner` and `github.repo`. Stop if the config is missing or cannot be read.
2. Use GitHub MCP for every GitHub call. Load its tools with ToolSearch, get the authenticated user, and read the epic with `issue_read`. Verify it is an issue and an epic. A `type:epic` label or confirmed native or body-linked children identifies an epic. Stop if the issue or epic cannot be confirmed.
3. Add `labels.epicApproved` (default `epic:approved`) if absent, keeping the existing labels. Use an add-only label operation if available. Otherwise re-read the issue immediately before updating and preserve all its labels. The command is the owner's approval. If the write fails, report the failure and stop.
4. Run the eligibility sweep once for this epic.

## Eligibility sweep

These instructions are also used by `/devflow:dispatch`. The sweep reads approval and can add a ready label to a sub-issue.

1. Read the epic and confirm it still carries `labels.epicApproved`. Enumerate all pages of native children with `issue_read` method `get_sub_issues` and GitHub MCP issue listings or search for children with a body line `Epic: #<epic>`. Verify the exact line on each body-linked match. Keep same-repository issues only and deduplicate by issue number. Include skipped children in the report.
2. For each child, use its current issue data. Classify it in this order:
   - If approval is absent, `spec.autoReady` is `off` or unset, or the value is outside `low` and `all`, use `manual` with the reason. For a closed child or one already labelled `labels.ready`, `labels.inProgress`, `labels.review`, `labels.blocked` or `labels.triage`, use `manual` with its existing state. Defaults are `agent:ready`, `agent:in-progress`, `agent:review`, `agent:blocked` and `needs-triage`.
   - Ignore HTML comments when checking the following body rules. A standalone `Ready: manual` line means `manual`. A non-empty `## Open questions` section whose content is other than `None` means `open questions`. Stop the section at the next heading of the same or a higher level.
   - In `low`, a child missing `labels.riskLow` (default `risk:low`) is `high risk` for this sweep. In `all`, risk does not affect eligibility.
   - Read every issue referenced by `Depends on #<n>` in the body using GitHub MCP. A dependency in this repository qualifies if it is closed, or if it is an open issue without `labels.blocked` and has an open PR whose head is at least one commit ahead of the base. Compare the PR's `base...head` using GitHub MCP and require `ahead_by` > 0. Parent risk does not matter. Report `waits for #n` for the first dependency that does not qualify. Use `(blocked)` for a blocked open parent, `(PR closed without merge)` for a closed unmerged PR when there is no qualifying open replacement, and `(no PR yet)` when there is no open PR with commits ahead of its base. An unreadable state counts as waiting. Include the read failure in the reason.
   - Otherwise the action is `ready`.
3. When applying `ready`, re-read approval and the child's state and labels before writing. If approval is gone, stop readying children. Keep all other labels and add only `labels.ready`. After the label is added, post the following comment if a comment with the marker does not already exist. On a write failure, report it and continue with the remaining children.

   ```text
   <!-- devflow-auto-ready -->
   Ready: epic #<epic> approved, all dependencies merged
   ```

4. In a preview, show `ready` as a proposed action and make no writes.

Print a table with sub-issue, action (`ready`, `waits for #n`, `manual`, `high risk`, or `open questions`) and reason. Report any failures. Removing the approval label stops future automatic readiness. Existing ready labels are kept.

Never merge a PR, close an issue, change a risk label, make a commit or push.
