# Today view

The Today page is the dashboard's landing route. With no activity it shows an empty state. Once a session has run today, it shows KPI cards for spend, sessions, efficiency, and flags, and a live tail of the active session.

## Sub-features

- `today-empty` shows `No activity yet today` and no KPI cards on a fresh store.
- `today-kpis` shows `spend today`, `sessions today`, and `avg cost / session` after activity.
- `today-live` marks an active session under `live`.
- `today-nav` makes the sidebar's `Today` entry the current page at `/`.

## How to get to it (user POV)

- Open the dashboard URL printed by `$PF up`. It lands on `/`.
- Choose `Today` in the sidebar from any other page.

## Driving it with pf-verify

Preconditions:

- `$PF up` has run on a fresh run dir and `$PF doctor` passes.

- **Empty state.** Before any hook, run `$PF shot / today-empty --expect "Today" --expect "No activity yet today"`. Both lines print `ok`.
- **Generate activity.** Run the Drive block from `SKILL.md`, with three hooks and one `turn` for one `SID`, then wait 5s.
- **KPIs.** Run `$PF shot / today-kpis --expect "spend today" --expect "sessions today" --expect "pf-verify-project"`. All three print `ok`. The PNG shows a nonzero spend.
- **Cross-check.** Run `$PF api /api/sessions/today/aggregate`. Its `sessionCount` and `totalCostUsd` match the numbers in `today-kpis.txt`.
- **Proof.** Keep `today-empty.png`, `today-kpis.png`, their `.txt` files, and the aggregate body.

## Gotchas

- The KPIs come from persisted sessions. A `shot` taken less than one persist interval after the last input can still show the empty state.
- The empty state disappears for the rest of the day once any session persists. Use a fresh `up` to re-prove `today-empty`.
- `npm run test:e2e` owns the pixel baseline for the empty state on port 7790. Do not compare `shot` PNGs against `e2e/today.spec.ts-snapshots`, which use a different viewport.
