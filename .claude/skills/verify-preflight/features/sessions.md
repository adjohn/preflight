# Sessions view

The Sessions page lists recent sessions with their tool counts and cost. A user can filter by time range, run source, and status, and select a session to see its detail and any workflow runs under it.

## Sub-features

- `sessions-list` shows each session by name with its tool calls.
- `sessions-range` filters by `Today`, `7 days`, `30 days`, and `All`.
- `sessions-filter` narrows the list through the `Run source filter` and `Status filter` groups.
- `sessions-select` shows the chosen session's detail.

## How to get to it (user POV)

- Choose `Sessions` in the dashboard sidebar.
- Open `/sessions` directly.

## Driving it with pf-verify

Preconditions:

- `$PF up` has run and `$PF doctor` passes.
- One session has three hooks and one `turn` (the `SKILL.md` Drive block), and 5s have passed.

- **List.** Run `$PF shot /sessions sessions-list --expect "Sessions" --expect "pf-verify-project"`. Both print `ok`.
- **Select.** Run `$PF shot /sessions sessions-select --click "pf-verify-project" --expect "Bash"`. The detail pane lists the session's tools.
- **Range filter.** Run `$PF shot /sessions sessions-range --click "30 days" --expect "pf-verify-project"`. The session stays listed.
- **Cross-check.** Run `$PF api /api/sessions`. The row for `<sid>` has `toolCallCount` 3.
- **Proof.** Keep the three PNG and text pairs plus the `/api/sessions` body.

## Gotchas

- The list page caps at 50 sessions server-side. A long-lived run dir can push a new session off the first page.
- `Status filter` values track workflow runs (`Running`, `Completed`, `Failed`, `Cancelled`), not plain sessions. A session with no workflow runs can disappear under a status filter.
- `--click` matches the first element containing the text. When a KPI or badge repeats the session name, add a more specific `--expect` to confirm the right element changed.
