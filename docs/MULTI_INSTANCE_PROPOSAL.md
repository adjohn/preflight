# Multi-Instance Architecture — Launch Proposal

**Status:** decision-ready, awaiting implementation review
**Audience:** the engineer picking this up
**Time to read:** 10 minutes

---

## TL;DR

Today the MCP server has a multi-instance bug stack that's fine with one Claude Code session and broken with two or more. The user-visible symptom is a "MCP server failed" badge in Claude Code; the silent symptoms are corrupted per-session metrics and a session identity that doesn't even correspond to Claude Code's real session ID.

We're shipping the fix as **Fix 1 + Fix 3 + remove daemon**, where:

- **Fix 1** (~10 lines): catch `EADDRINUSE` on the dashboard port and fall back to headless mode. First MCP wins the dashboard; others run in tool-only mode.
- **Fix 3** (~135 lines): partition `buffer.jsonl` into per-session files. Each MCP drains only its own session's events. Replace the MCP's randomly-generated `sessionTraceId` with the real Claude Code `session_id`, learned via a hook-written breadcrumb on disk.
- **Remove daemon** (~1180 lines deleted): the `nr-ai-observe start/stop/status` commands and LaunchAgent install were a workaround for the port collision — Fix 1 + 3 obsolete them. Keep `--local` standalone mode for browsing the dashboard between sessions.

Net delta: roughly **+305 / −1180**. Smaller codebase, correct multi-instance.

---

## The Problem, in three layers

### Layer 1 — Visible breakage

When two Claude Code sessions are open simultaneously, each spawns its own MCP process (`nr-ai-mcp-server --stdio`). Both try to bind dashboard port 7777 (`src/index.ts:619`). Whoever loses gets `EADDRINUSE`, throws a fatal error, exits. Claude Code's UI shows "✗ failed" for that session's MCP. This is exactly the screenshot users will hit at launch.

### Layer 2 — Silent data loss

`LocalStore.drainBuffer()` (`src/storage/local-store.ts:62-117`) is atomic for a _single_ drainer. With N MCPs all polling the same `buffer.jsonl` every 100ms, only one wins the rename per cycle; the others see an empty buffer. Each session's MCP gets a random subset of total events. The dashboard's view (which sees the union eventually) ends up with the right data; the in-chat tools per session do not.

### Layer 3 — Fictional session identity

The MCP generates its own `sessionTraceId = randomUUID()` at `src/index.ts:283` and uses it as the session identity for everything (saved session JSON files, NR events, internal tracker keys). This UUID has no relationship to Claude Code's real `session_id`.

**Hard proof:** five session UUIDs sampled from `~/.nr-ai-observe/sessions/*.json` were cross-referenced against Claude Code transcript files at `~/.claude/projects/<projectDir>/<sessionId>.jsonl` — **zero matches**. Today's "session" identity is a fiction with no external meaning.

This means even with Layers 1 and 2 fixed, in-chat tools that say "stats for _this_ session" can't actually identify "this" session; they conflate events from all sessions whose drained events happened to land in their tracker.

---

## The Design

### Fix 1 — graceful EADDRINUSE handoff

**File:** `src/index.ts:618-642`. Catch `EADDRINUSE` from `dashboardServer.start()`, log "Dashboard already owned by another nr-ai-mcp-server instance at http://127.0.0.1:7777," continue without binding. The first MCP to start owns the dashboard; subsequent MCPs run headless but still serve their stdio + in-chat tools.

OS-level port arbitration replaces any need for explicit coordination. No daemon required.

### Fix 3 — per-session buffer files + sessionId consolidation

Two parts, in one PR:

**Part A — partition the buffer file.** Hook collector writes to `~/.nr-ai-observe/buffer-<sessionId>.jsonl` instead of one shared `buffer.jsonl`. Each MCP drains _only_ its own session's file. No two MCPs ever touch the same file → no race possible → no lock needed (Fix 2's lock from earlier drafts becomes unnecessary). Dashboard owner reads all per-session buffer files in read-only mode for the aggregate view.

**Part B — converge identity on the real session_id.**

- Replace `let sessionTraceId = randomUUID()` at `src/index.ts:283` with the resolved Claude Code `session_id` (plumbing below).
- Remove the `?? randomUUID()` fallback at `SessionTracker` constructor (`src/metrics/session-tracker.ts:117`) and `reset()` (line 280).
- Delete the half-measure fallback patterns at:
  - `src/index.ts:854` — `sessionId: firstRecord?.sessionId ?? undefined`
  - `src/transport/nr-ingest.ts:351` — `attrs.sessionTraceId ?? firstRecord?.sessionId ?? null`
  - `src/transport/nr-ingest.ts:664` — `this.sessionTraceId ?? context.sessionId`

Side benefit: saved session JSON filenames will then contain the real Claude Code `session_id`, cross-referenceable with Claude transcripts at `~/.claude/projects/<projectDir>/<sessionId>.jsonl`. Free UX win.

### Remove daemon

`nr-ai-observe start/stop/status` (`src/install/cli.ts`) and the LaunchAgent install path (`src/install/daemon.ts`, ~557 lines) were a singleton-dashboard workaround for the port collision. Fix 1 + 3 make them dead weight and a footgun (the daemon races the per-session MCPs). Delete them.

**Keep `--local` standalone mode** in `src/index.ts`. Useful for browsing the dashboard when no Claude Code session is open. With Fix 1 in place, `--local` coexists gracefully with running per-session MCPs (whoever started first owns the port).

---

## SessionId plumbing — how the MCP learns its Claude Code session_id

### What we ruled out

**Option 1 — env var.** Confirmed by inspecting a live MCP process's environment. Claude Code passes `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_AGENT`, `CLAUDE_JOB_DIR`, `CLAUDE_CODE_SESSION_KIND=bg`, etc. — but no `CLAUDE_SESSION_ID` or equivalent. Interactive Claude Code (`claude agents`) doesn't even set `CLAUDE_JOB_DIR`. So this works only as an _optimization_ for background-job MCPs, not as the sole mechanism.

**Option 2 — MCP `initialize` protocol's `_meta` or `clientInfo`.** Ruled out by source-code inspection at `node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js:294-300`:

```js
method: 'initialize',
params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: this._capabilities,
    clientInfo: this._clientInfo,
}
```

Three hardcoded fields, no `_meta`, no extension hook. There's no code path in the standard SDK to attach session info to initialize. Source-code evidence is stronger than a live capture would be — a live capture finding "no `_meta`" is consistent with both "Anthropic doesn't send it" and "we missed something." Source proves the path doesn't exist.

(A spike instrumentation was added to `src/server.ts` and reverted cleanly. Side finding: the project logger auto-redacts payloads that look like secrets. Anyone adding debug logging that needs to faithfully capture user inputs needs to bypass the logger and write raw to a file.)

### What we're using

A **per-PPID breadcrumb pattern**. Every Claude Code session is a single OS process with a unique PID. When that session spawns its MCP and its hook collector scripts, they all become its children — they share the same PPID. Verified via process tree inspection.

The hook collector receives `session_id` in its stdin payload (`collector-script.ts:242`). On every hook fire, it writes (idempotent overwrite):

```
~/.nr-ai-observe/session-by-ppid/<claude_pid>.txt
  containing: <session_id>
```

The MCP at startup reads its own `process.ppid` (= Claude Code's PID) and looks up the breadcrumb. The `UserPromptSubmit` hook (already installed in `~/.claude/settings.json`) fires on every user message, including the first of a session — so the breadcrumb appears within seconds of session start.

**Optimization for background jobs:** if `process.env.CLAUDE_JOB_DIR` is set, read `<CLAUDE_JOB_DIR>/state.json` and parse the session UUID from its `linkScanPath` field. Instant resolution; no hook required.

**Hot-path overhead** in the collector: the breadcrumb write needs to stay under the documented `<5ms` budget per hook invocation. Cheap mitigation: gate the write with `existsSync + readFileSync === currentSessionId` — most hook fires after the first one are no-ops. ~3 extra lines.

### D2 — what happens when resolution fails

When `CLAUDE_JOB_DIR` isn't set and the breadcrumb hasn't appeared yet (or never does):

- MCP stays connected. Polls the breadcrumb at exponential backoff: 100ms, 200ms, 500ms, 1s, 2s, then steady at 2s.
- No hard timeout; retry forever.
- Single `WARN` log after 60s: "session_id unresolved after 60s — breadcrumb missing; check that hook collector is installed and writing." Diagnostic signal for users where hooks aren't firing.
- Tool handlers gate on resolution. If unresolved, return structured error: `{error: "session_id not yet resolved", hint: "Make any tool call (Bash, Read, etc.) to populate the session breadcrumb."}`.
- Once resolved, drain accumulated buffer in one batch then resume normal polling.

The dashboard owner reads all `buffer-*.jsonl` files in its cross-session aggregator regardless of any individual MCP's resolution state, so **data is never lost from the dashboard view** — only the in-chat tools for unresolved sessions are degraded.

---

## D3 — Today view UX with N concurrent sessions

The current Today view fetches `/api/session/current` and renders KPIs, sparkline, recent calls, anti-pattern alerts scoped to "the current session." With N sessions, "current" is meaningless from the dashboard's perspective (the dashboard is served by whichever MCP won the port race).

**Decision: hybrid.**

- **AGGREGATE** across all live sessions today: KPIs (calls, cost, anti-pattern count), sparkline, activity heatmap, concurrency indicator, anti-pattern alerts list (with a "Session: <name>" pill on each alert so users can tell which session triggered it).
- **PER-SESSION**, tied to the existing `activeId` from the selector list (already exists in `Today.tsx:558-590`):
  - Live tail (Gantt + list view)
  - Context bar (`<ContextBar sessionId={activeId} />` — already takes a `sessionId` prop, used today on Sessions view)

**Selector behavior:**

- The list is the existing left-column session cards. No new dropdown needed.
- Default selection: most-recently-active live session.
- When the selected session ends mid-view: keep showing its history with a "Session ended" badge. No auto-switch (jarring), no empty-out (loses context).

**Remove `/api/session/current`** — it's broken-by-design post-Fix-3.

### Live event schema additions

`src/dashboard/live-event-bus.ts` event types need `sessionId` for per-session filtering:

| Event                | Has sessionId today? | Action                                                                                                                                                                                                                                |
| -------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ToolCallEvent`      | No                   | Add `readonly sessionId: string`                                                                                                                                                                                                      |
| `AntiPatternEvent`   | No                   | Add `readonly sessionId: string` (powers session-pill rendering)                                                                                                                                                                      |
| `AlertEvent`         | No                   | Add `readonly sessionId?: string` (optional — system-level alerts have no session)                                                                                                                                                    |
| `CostUpdateEvent`    | Mixed                | Add `readonly sessionId: string`. Existing `sessionTotalUsd` field implicitly means "the MCP's session total"; with sessionId on the event, consumers filter by `activeId` for per-session views and sum across events for aggregate. |
| `ContextUpdateEvent` | Yes                  | None                                                                                                                                                                                                                                  |
| `HeartbeatEvent`     | No                   | None — global keepalive                                                                                                                                                                                                               |

### SSE + client filtering

- **Server:** `src/dashboard/routes/sse-handler.ts` adds a `?sessionId=` query parameter to filter at subscribe time. Saves bandwidth, keeps clients simple.
- **Client:** `src/web/store/liveStore.ts` clears or re-keys per-session event cache on `activeId` switch so a previous session's events don't pollute the new selection's view.

### New API endpoints

- `GET /api/sessions/today/aggregate` — aggregate KPIs across all live sessions today.
- `GET /api/sessions/live` — list of currently-live `sessionId`s. Reads from `LiveSessionRegistry.getLiveSessions()` (live-session-registry.ts:47).

### Reuse, not new code

- `ContextBar` already takes a `sessionId` prop. Drop into Today as `<ContextBar sessionId={activeId} />`.
- Selector list: zero new code — already exists.
- `LiveSessionRegistry` already tracks live sessions by Claude Code's session_id.
- `ContextTracker` (recently added) already keys by `record.sessionId` — no change needed.

---

## Task list with sequencing

| #   | Status  | Title                                                                | Size                           |
| --- | ------- | -------------------------------------------------------------------- | ------------------------------ |
| 6   | pending | Fix 1: graceful EADDRINUSE handoff                                   | small (~10 lines)              |
| 14  | pending | Fix 3: per-session buffer files + sessionId consolidation + D2       | medium (~135 lines)            |
| 17  | pending | Cross-session aggregation + Today view UX (D3)                       | medium (~90 lines)             |
| 18  | pending | Orphan buffer file GC                                                | small (~30 lines)              |
| 8   | pending | Remove daemon (start/stop/status + LaunchAgent)                      | medium (deletion: ~1180 lines) |
| 9   | pending | Fix README:337 footgun for `--local`                                 | tiny                           |
| 10  | pending | Verify global install (`npm install -g`) end-to-end                  | medium                         |
| 11  | pending | Add multi-instance integration test                                  | medium                         |
| 12  | pending | Backwards-compat audit (existing user data + buffer.jsonl migration) | small                          |
| 13  | pending | Dashboard ownership re-poll (post Fix 1) — _nice-to-have_            | small                          |
| 16  | done    | PREREQ spike: how MCP learns sessionId                               | —                              |
| 19  | done    | Spike: capture raw MCP initialize payload (option 2 ruled out)       | —                              |

**Suggested attack order:**

1. **Fix 1** first — small, independent, lands cleanly on its own, unblocks the visible breakage.
2. **Fix 3** + consolidation cleanup, in one PR (don't land Fix 3 without removing the now-dead fallback patterns at `index.ts:854` / `nr-ingest.ts:351,664`).
3. **#17** (cross-session aggregation + D3 UX) — depends on Fix 3 being functional.
4. **#18** (orphan GC) — small, lands after Fix 3.
5. **#11** (multi-instance integration test) — last, validates everything end-to-end.
6. **#8 / #9 / #10 / #12** are independent and can run in parallel with the architecture work above.

---

## Holes to push on

These are real concerns that need to be answered before merging.

1. **Hook collector hot-path budget.** Adding the breadcrumb write to every PostToolUse hook adds a `writeFileSync` to a hot path with a documented `<5ms` budget. The `existsSync + content-equality` short-circuit handles the common case (most fires are no-ops). Worth measuring on an actual run, not just trusting the budget.

2. **Subagent / Task tool handling.** Verified by code inspection: subagent tool calls fire hooks under the parent Claude Code session's `session_id`. They share the parent's session, not their own. So the plumbing works without subagent-specific code. Worth a confirmatory test.

3. **Other-platform adapters.** The breadcrumb pattern is Claude-Code-specific (relies on Claude Code's hook system writing `session_id`). Other platforms (Cursor, Windsurf, Copilot, Zed, Continue, Amazon Q, generic) either don't have hook infrastructure or have different session semantics. Decision for launch: v1 multi-instance correctness is **Claude Code only**. Other platforms still work via single-instance dashboard but multi-instance per-session in-chat tools may be polluted. Document and defer.

4. **`--local` mode in Fix 3 world.** Needs to drain _orphan_ buffer files (those whose owning MCP isn't running) and serve the dashboard. Different code path from per-session MCPs (which drain only their own file). ~30 extra lines beyond Fix 3's main estimate.

5. **Backwards compat for existing `buffer.jsonl`.** Users upgrading will have un-drained events in the old shared buffer file. New code looks at per-session files. Migration: on first startup, partition `buffer.jsonl` by `record.sessionId` into per-session files, then delete. ~15 lines. Belongs in task #12.

6. **Path traversal on `session_id`.** When using the resolved session*id as a filename, must validate against `/^[a-zA-Z0-9*-]{1,128}$/`(already used elsewhere in the codebase, e.g.`collector-script.ts:205,221`) to reject malicious values. Critical for any code path that uses `session_id` in a file path.

7. **`package.json:"files"`** ships only `dist/` and `examples/`. `alerts/` (rule definitions) and `dashboards/` (NR dashboard JSON) aren't included. Verify this is intentional or fix before publishing.

8. **`nr_observe_subscribe_digest` and similar config-writing tools.** With N MCPs, last writer wins on `~/.nr-ai-observe/config.json`. Not a corruption risk but worth documenting that "any session can change global config; latest write wins."

9. **Audit trail concurrency.** `appendFileSync` (`local-store.ts:173`) is POSIX-atomic for writes under `PIPE_BUF` (4096 bytes on macOS). Audit entries are well under that. Confirmed safe with N concurrent writers.

---

## Things verified to be NOT problems

- **Subagents** share parent session_id (no special plumbing needed).
- **LocalStore is not in `src/shared/`** — changes don't need upstreaming to `nr-ai-typescript-shared`.
- **Audit trail** is concurrency-safe via POSIX `PIPE_BUF` guarantee.
- **Health endpoint** (`/api/health`) is served only by the dashboard owner — exactly one process holds it under Fix 1.
- **Session JSON date naming** uses start-time, so cross-midnight sessions file under start date. Stable.

---

## What "done" looks like

A user can:

1. Open three Claude Code sessions in three different directories simultaneously.
2. All three connect to the MCP without "✗ failed" badges.
3. Open http://127.0.0.1:7777 in a browser.
4. See aggregate KPIs across all three sessions on the Today view.
5. Click any session in the left selector list and see its specific Live tail and Context bar in real time.
6. Get correct, non-polluted data when they ask any of the three Claude Code instances "show me my session stats."
7. Close one session — its data persists in the dashboard's history; the remaining two keep working.
8. Cross-reference the saved session JSON in `~/.nr-ai-observe/sessions/` with Claude Code's transcript at `~/.claude/projects/<projectDir>/<sessionId>.jsonl` and find them under matching IDs.

A regression test (task #11) automates points 1, 2, 5, 6.
