# Pre-Dogfood Code Review

**Date:** 2026-06-02
**Scope:** All of `src/` except `src/shared/` (read-only mirror, synced from `nr-ai-typescript-shared`)
**Goal:** Catch issues that would block a fresh internal tester from `git clone` → metrics-in-dashboard within ~10 minutes during the **Friday internal dogfooding event**.

## Severity Bar

This review intentionally **omits** nitpicks, post-launch concerns, and theoretical security improvements. A finding only made the list if it would:

| Severity | Meaning |
|---|---|
| **HIGH** | Crash, security/privacy leak, data loss, or a UX failure that would confuse or block a fresh tester |
| **MEDIUM** | Reliability or correctness issue likely to surface during the dogfood under realistic load |
| **LOW** | Worth fixing if cheap; would not block dogfood on its own |

Findings are appended one-at-a-time below in the format:

```
### [F-NNN] Title — Severity (CATEGORY)
**Location:** path/file.ts:LINE
**Issue:** ...
**Impact:** ...
**Implementation steps:** 1. ...
**Status:** Open
```

## Methodology

1. **Phase 1 — Multi-angle finder.** Six parallel `feature-dev:code-reviewer` agents covered non-overlapping surfaces (security/redaction, dashboard SPA, install/setup, ingest/transport, proxy/storage, metrics/hooks). Each angle returned independent candidate findings — no cross-suppression.
2. **Phase 2 — Verification.** Every candidate was traced end-to-end through the actual source (collector → buffer → event-processor → tool-parsers → nr-ingest → NR APIs; install scripts → package.json bin entries; SPA queries → API handler routes). Findings that turned out to be guarded elsewhere or factually wrong were dropped.
3. **Phase 3 — Severity filter.** Verified findings were filtered against the dogfood-readiness bar above. Anything that wouldn't block or confuse a fresh tester was cut.

Numbering restarts at **F-001**. (F-001..F-051 from the prior CODE_REVIEW cycle have all been merged and the file deleted.)

---

## Findings

### ✅ [F-001] Bash commands and other tool inputs flow unredacted into AiToolCall NR events — HIGH (SECURITY)

**Location:** `src/transport/nr-ingest.ts:151-156` (the catch-all field copy in `toolCallToNrEvent`); upstream sources at `src/hooks/tool-parsers.ts:87` (`fields.command = input.command`) and `src/hooks/collector-script.ts:308` (`meta.command = obj.command`).

**Issue:** `toolCallToNrEvent` copies any extra string/number/boolean field on `ToolCallRecord` directly into the outgoing `AiToolCall` NR event without applying `redact()` or `redactSensitive()`:

```ts
for (const [key, value] of Object.entries(record)) {
  if (STANDARD_KEYS.has(key)) continue;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    event[key] = value;            // ← raw command, file_path, pattern, etc.
  }
}
```

`STANDARD_KEYS` is the explicit allowlist of fields that get snake-case mapping (id, sessionId, toolName, …). `command`, `filePath`, `pattern`, `agentDescription` are **not** in that set, so they pass straight through. The collector and `parseToolSpecificFields` both attach `command` raw, so by the time it reaches this loop it has never been scrubbed. Compare to `auditRecordToNrEvent` (`src/security/audit-trail.ts:200-201`), which properly wraps both fields in `redactSensitive(...)` before emission — that path is correct; this one bypasses it.

**Impact:** Any developer running a Bash command containing a secret (`curl -H "Authorization: Bearer sk-…"`, `AWS_SECRET_ACCESS_KEY=… aws …`, `psql postgres://user:password@host/db …`) ships that secret to New Relic in plaintext as `AiToolCall.command`. Same for sensitive paths in `Read`/`Edit` calls. NR queries / dashboards / retention policies cannot rewrite the data after the fact. This is the single biggest blocker for an internal dogfood — the first tester who runs `gh auth login` or pastes a credential into a shell command leaks it to the org's NR account, and we will not be able to retract it.

**Implementation steps:**
1. In `src/transport/nr-ingest.ts`, import `redactSensitive` from `../config.js`.
2. Define a `REDACT_FIELD_KEYS` set covering string fields known to potentially contain secrets: `['command', 'filePath', 'file_path', 'pattern', 'agentDescription', 'agent_description', 'detail']`.
3. In the catch-all loop (lines 151-156), when the value is a string and the key is in `REDACT_FIELD_KEYS`, write `redactSensitive(value)` instead of `value`.
4. Add a unit test in `src/transport/nr-ingest.test.ts` (or new file) asserting that a `ToolCallRecord` with `command: 'curl -H "Authorization: Bearer sk-test-secret"'` produces an event whose `command` field does not contain `sk-test-secret`.
5. Manually verify with a real tool call in proxy mode that `AiToolCall` events in NRDB show `[REDACTED]` placeholders for known secret patterns.

**Status:** Done

### ✅ [F-002] Install instructions point to a non-existent npm package `nr-ai-observatory` — HIGH (SETUP)

**Location:** `src/install/cli.ts:85` and `src/install/setup-wizard.ts:316`.

**Issue:** When `nr-ai-observe` is not on PATH after install, both code paths print:

```
Fix: run `npm link` in the project directory, or install globally:
    npm install -g nr-ai-observatory
```

But the package is published as **`nr-ai-mcp-server`** (verified in `package.json` line 2), and it is the `nr-ai-mcp-server` package that exposes both binaries (`nr-ai-mcp-server` and `nr-ai-observe` — package.json lines 16-17). `nr-ai-observatory` does not exist on npm.

**Impact:** A fresh tester who follows the printed instruction runs `npm install -g nr-ai-observatory` and gets a 404 from npm. Within the dogfood's 10-minute window, this is enough friction to make the tester give up or pingfor help. The `npm link` alternative does work from a clone, but most testers paste the global-install line because it sounds canonical.

**Implementation steps:**
1. In `src/install/cli.ts:85`, change `'    npm install -g nr-ai-observatory'` to `'    npm install -g nr-ai-mcp-server'`.
2. In `src/install/setup-wizard.ts:316`, make the same substitution.
3. Grep the rest of `src/` and `docs/` for the literal `nr-ai-observatory` to catch any other stale references in user-facing strings (the repo dir is named `nr-ai-observatory` so most matches will be paths/comments — be careful to only fix npm-install instructions).

**Status:** Done

### ✅ [F-003] Audit log entries shipped to NR Logs API contain unredacted command, file_path, and message — HIGH (SECURITY)

**Location:** `src/transport/log-ingest.ts:40-63` (`auditRecordToLogEntry`); root cause at `src/security/audit-trail.ts:120-132` (`buildDetail`) and `:282-292` (`recordToolCall` stores raw `filePath`/`command` on `AuditRecord`).

**Issue:** `auditRecordToLogEntry` writes the raw `record.filePath` and `record.command` into NR Log attributes, and the raw `record.detail` into the log message:

```ts
attributes[...] = record.filePath  // ← raw, line 50
attributes[...] = record.command   // ← raw, line 51
return { ..., message: record.detail, attributes };  // ← raw, line 60
```

`record.detail` is built by `buildDetail()`, which directly concatenates the raw command/path: ``` `${tool}: ${command}` ``. The sibling event path (`auditRecordToNrEvent`, audit-trail.ts:200-201) does redact via `redactSensitive(...)`; the Logs API path simply does not.

**Impact:** Every audit record (file accesses, every Bash call, MCP tool calls) lands in NR Logs with the full command string. Same data-leak class as F-001, but on a second egress channel — even if F-001 is fixed, secrets still ship to NR via the Logs API. Log entries also persist to disk via `LocalStore.appendAuditLog` (audit-trail.ts:383-390), so the leak exists on the local filesystem too.

**Implementation steps:**
1. In `src/transport/log-ingest.ts`, import `redactSensitive` from `../config.js`.
2. In `auditRecordToLogEntry`, wrap the three leaky fields:
   - `attributes['audit.file_path'] = redactSensitive(record.filePath);`
   - `attributes['audit.command'] = redactSensitive(record.command);`
   - `message: redactSensitive(record.detail),`
3. Either also redact at the source (`buildDetail` in audit-trail.ts) so persisted-to-disk audit records and the in-memory audit log don't carry raw secrets — preferred — **or** add a comment explaining that callers must redact at every egress.
4. Add a unit test in `src/transport/log-ingest.test.ts` covering an `AuditRecord` with `command: 'curl -H "Authorization: Bearer sk-…"'` and asserting both the message and `audit.command` attribute are scrubbed.

**Status:** Done

### ✅ [F-004] Dashboard SPA has no React error boundary — any unhandled child render error white-screens the whole UI — HIGH (UX)

**Location:** `src/web/App.tsx:1-37` (no `<ErrorBoundary>` wrapper anywhere); affects every routed view (`Today`, `History`, `Replay`, `Audit`, etc.).

**Issue:** `App` directly renders `<Sidebar>` + `<Switch>` of routes with no error boundary in the tree. React 18+ unmounts the entire root subtree when any component throws during render, leaving a blank `<div id="root">`. The dashboard ships several views that depend on shape-fragile API responses (e.g. `Today.tsx`'s duplicate `qk.sessionCurrent` query and undefined `CurrentSessionResponse` type — see F-005), and `useLiveEvents` SSE handlers can throw on malformed events. There is no fallback UI and no way for the tester to recover except a manual page reload.

**Impact:** During the dogfood, the first tester whose API returns an unexpected null/shape (very likely on a fresh install with empty session history, before any sessions exist) sees a completely blank dashboard and assumes the product is broken. They have no console open, no obvious recovery path, and no error message. The 10-minute window is wasted on a Slack ping for help. This is the highest-impact UX failure mode in the SPA because it converts ANY runtime React error — including ones we'd otherwise consider minor — into a total dashboard outage.

**Implementation steps:**
1. Create `src/web/components/ErrorBoundary.tsx` — a class component implementing `componentDidCatch(error, info)` and `getDerivedStateFromError(error)`. On error, render a centered card with: the error message, a "Reload" button (`window.location.reload()`), and a small `<pre>` block with `error.stack` (collapsible). Log via `console.error` so dev tooling still surfaces it.
2. In `src/web/App.tsx`, wrap the `<main>` content (or the entire return) in `<ErrorBoundary>` so a thrown view error keeps the sidebar / nav usable.
3. Add a second, narrower `<ErrorBoundary>` inside the `<Switch>` per route (or wrap each route component) so navigating away resets the error state — otherwise a sticky error survives across routes.
4. Add a smoke test in `src/web/components/ErrorBoundary.test.tsx` rendering a child that throws and asserting the fallback UI is shown.
5. Manually verify by temporarily throwing inside `Today` and confirming the rest of the app remains navigable.

**Status:** Done

### ✅ [F-005] Today.tsx has duplicate `qk.sessionCurrent` query, references undefined type `CurrentSessionResponse`, and shadows imported `formatNumber` — MEDIUM (CORRECTNESS)

**Location:** `src/web/views/Today.tsx` — duplicate `useQuery({ queryKey: qk.sessionCurrent ... })` at lines 108-111 and 120-124; second query types its result as `CurrentSessionResponse` (a name not exported anywhere in `src/web/`); local `function formatNumber(n: number): string` at line 618 collides with `import { formatNumber } from '../lib/format'` at line 18.

**Issue:** Three independent defects in the same file:

1. **Duplicate query, same key.** Two `useQuery` calls hit `qk.sessionCurrent` back-to-back. React Query dedups by key, so the second call returns the same cached entry — but at a different TS type. Whichever query mounts first wins; the second's `refetchInterval: 10_000` may or may not be honored depending on the order React Query applies overlapping observers. The unused first binding (`sessionCurrent`) signals the file was edited mid-refactor and the dead code was never cleaned up.
2. **Undefined type.** `CurrentSessionResponse` is referenced as the generic for the second query but is not declared or imported in this file or anywhere in `src/web/`. Under a working TS pipeline this is a TS2304 hard error.
3. **Shadowed import.** Line 18 imports `formatNumber` from `../lib/format`; line 618 declares a local `function formatNumber`. TS2440 (Import declaration conflicts with local declaration). Two functions with potentially different formatting behavior — the call site at line 587 binds to whichever wins under the bundler.

These would be caught by `tsc -p tsconfig.web.json --noEmit` (which currently emits 40 errors total — most from the unrelated `JSX` namespace issue, but TS2304 + TS2440 in Today.tsx are real). However, `npm run build` uses `vite build` (esbuild) which silently strips types and emits a working bundle, so the dogfood-time symptom is **runtime confusion**: `Today` renders with whichever `formatNumber` esbuild last saw, and the SSR/refetch behavior on the duplicate query is non-deterministic.

**Impact:** Dogfood testers will see one of: (a) numbers formatted differently on `Today` vs other views, (b) the live counter not refreshing on its expected 10-second cadence, or (c) a runtime `TypeError` if the cached query result doesn't match the type the second consumer expects to access. None of these crash the page (assuming F-004 is fixed), but all of them undermine confidence in the metrics the dogfood is designed to validate.

**Implementation steps:**
1. In `src/web/views/Today.tsx`, delete the unused first query block (lines 108-111). Keep only one `useQuery({ queryKey: qk.sessionCurrent, ... })` call.
2. Replace the undefined `CurrentSessionResponse` generic on the surviving query with the existing `SessionCurrentApiResponse` type (already imported at line ~5-15 of the file).
3. Delete the local `function formatNumber(n: number): string` declaration at line 618 — the import from `../lib/format` already covers all call sites.
4. Verify the call site at line 587 still type-checks against the imported `formatNumber` signature (`(n: number) => string`).
5. Run `npx tsc -p tsconfig.web.json --noEmit` and confirm the TS2304/TS2440/TS2304 errors specific to Today.tsx are gone (the 38-ish JSX namespace errors are unrelated and tracked separately — out of scope for the dogfood per the severity bar).
6. Manually load `/` (the Today view) in the dashboard and verify numbers render and the live indicator refreshes on the expected cadence.

**Status:** Done

### ✅ [F-006] Setup wizard prints a misleading "Start the MCP server with" instruction — MEDIUM (UX/SETUP)

**Location:** `src/install/setup-wizard.ts:336` — final printed instruction reads `print('  nr-ai-mcp-server --stdio\n');` after a `Start the MCP server with:` header.

**Issue:** The setup wizard's last step tells the tester to run `nr-ai-mcp-server --stdio` themselves. But Claude Code launches the MCP server automatically based on the `.mcp.json` entry the wizard just wrote — there is no manual start step required. A tester who follows the printed instruction will:

- Open a new terminal, run `nr-ai-mcp-server --stdio`, and watch the process sit silently waiting for stdio input that never comes.
- After ~30 seconds, assume something is broken and either kill it (correct outcome by accident) or open Claude Code in a *different* terminal where the auto-launched server is now competing for the buffer file lock.
- In the second case, both processes write to `~/.nr-ai-observe/buffer.jsonl` and the tester sees doubled or interleaved metrics, which they will report as a bug.

The instruction is a holdover from when manual stdio launch was a valid path; it is no longer correct under the Claude Code hook integration the wizard just configured.

**Impact:** Pure dogfood friction. A fresh tester who completes the wizard literally cannot understand why a manually-launched stdio server "doesn't do anything," and the cleanest case (kill it and open Claude Code) still wastes 1-2 minutes of the 10-minute window. The bad case (two processes) produces metrics that contradict what the dashboard shows and will be reported as a P1 bug during dogfood.

**Implementation steps:**
1. In `src/install/setup-wizard.ts:336`, replace the misleading instruction with the actual next step. Suggested text:
   ```
   Open Claude Code in a project — the MCP server will start automatically.
   You should see metrics appear in the dashboard at http://localhost:<port>
   within ~30 seconds of your first tool call.
   ```
2. Grep `src/install/` for any other place that prints `nr-ai-mcp-server --stdio` as a user-facing instruction (the binary itself can still accept the flag — just don't tell testers to run it).
3. Verify by re-running the wizard against a clean `~/.nr-ai-observe/` directory and confirming the final printed block is correct.

**Status:** Done

### ✅ [F-007] `/api/alerts/recent` 500 response leaks raw `String(err)` to the dashboard — LOW (SECURITY/POLISH)

**Location:** `src/dashboard/routes/api-handler.ts:296-299`:

```ts
} catch (err) {
  res.writeHead(500, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'internal', detail: String(err) }));
}
```

**Issue:** When `alertLog.readRecent(50)` throws, the handler stringifies the raw `Error` (which serializes as `"Error: <message>\n at <stack frame>..."` for typical Node errors) and ships it back as the `detail` field of the JSON response. If the error message includes a file path, an env var name, or a database connection string fragment, that information is now visible to anyone who can hit the dashboard. The dashboard binds to localhost-only by default, which is why this is LOW — but the pattern is inconsistent with the other handlers in this file, which return `{ error: 'unavailable', what }` or `{ error: 'not_found' }` and never echo internal state.

**Impact:** Low. The dashboard is localhost-only and the alerts endpoint specifically only fires when `alertLog` is configured (cloud mode + alerts enabled). The realistic dogfood scenario is a contributor running the dashboard on their own machine. The reason this still belongs on the list: if a tester pings us a screenshot of an alert error during the dogfood, the screenshot may contain a stack trace pointing at internal file paths or NR account IDs we'd rather not screenshot-share to a Slack channel.

**Implementation steps:**
1. In `src/dashboard/routes/api-handler.ts:296-299`, change the catch body to log the error server-side and return a generic message:
   ```ts
   } catch (err) {
     // Log full error details server-side, never echo to client.
     console.error('alertLog.readRecent failed', err);
     res.writeHead(500, { 'content-type': 'application/json' });
     res.end(JSON.stringify({ error: 'internal' }));
   }
   ```
2. Grep the rest of `src/dashboard/routes/` and `src/dashboard/` for `String(err)` or `err.message` being included in HTTP response bodies; apply the same pattern.
3. Optional: add a request id header so the server log entry can be correlated to a specific failed request without exposing details to the client.

**Status:** Done

