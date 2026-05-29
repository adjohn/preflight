# Local-Only Mode Design

**Date:** 2026-05-28
**Ship target:** 2026-06-23 (NR Labs launch window)
**Status:** Approved — ready for implementation plan

## Context

NR AI Observatory currently requires a New Relic license key and ships every event to NR. Leadership wants the tool to work for users uncomfortable shipping their AI-coding telemetry to a third-party SaaS. The driver is **personal preference and trust** (not compliance, not air-gap) — users want to verify nothing leaves their machine if they choose.

Most of the local plumbing already exists:

- `~/.nr-ai-observe/buffer.jsonl` — hook event buffer
- `~/.nr-ai-observe/sessions/` — full session summaries (one JSON per session)
- `~/.nr-ai-observe/weekly_summaries/` — cross-session aggregations
- 19 in-memory metric trackers in `src/metrics/` that already aggregate everything we need
- 27 MCP tools that already wrap those trackers
- 7 NR dashboard JSONs that already define the visualization shape

The gap is (a) a way to suppress NR transport, and (b) a local visualization layer.

## Goals

- A first-class **local mode** that ships zero data to New Relic
- A polished **embedded web dashboard** at `http://127.0.0.1:7777` showing four views: Today, Sessions, History, Audit
- Real-time updates as Claude works (sub-second hook → browser)
- Verifiable privacy guarantees (provable via tests, not just claims)
- Default behavior unchanged — existing cloud users see no impact

## Non-goals

- LAN / multi-user / phone access (loopback-only in v1)
- Authentication (single user, single machine)
- A standalone "review-mode" CLI when the MCP server isn't running
- Compliance-grade features (audit signing, immutable trails) — that's a different driver
- Light theme, mobile responsive, i18n, WCAG audit (v1.1+)

## §1 — Architecture overview

The dashboard runs **in-process** with the MCP server. Because every tracker already lives in memory, the dashboard gets direct access via `tracker.getMetrics()` — no database, no IPC, no message bus beyond a single in-process `EventEmitter`.

```
                 Claude Code (this user)
                  │              │
                  │ hooks        │ MCP stdio
                  ▼              ▼
              buffer.jsonl   NrMcpServer
                  │           │
                  └─reads─►  HookEventProcessor
                              │
                              ▼
                        ToolCallRecord
                              │
                ┌─────────────┼─────────────┐
                ▼             ▼             ▼
          SessionTracker  CostTracker  AntiPatternDetector  …  (19 trackers)
                              │
                              ▼
                        LiveEventBus  ◄── new EventEmitter
                              │
                              ▼ (mode = 'local' or 'both')
                        DashboardServer  ◄── new
                          • GET /             → SPA
                          • GET /api/*        → tracker JSON
                          • GET /sse          → live event stream
                              │
                              ▼ HTTP / SSE
                        browser at 127.0.0.1:7777
```

### What's new

- **`src/dashboard/`** — new module: `DashboardServer` (raw `http.createServer`), route handlers, SSE handler, `LiveEventBus` (`EventEmitter`).
- **`src/web/`** — new SPA source: React + Vite + Tailwind + Recharts, four views.
- **`dist/web/`** — Vite build output, served as static files by `DashboardServer`.

### What's reused

- All 19 metric trackers (`src/metrics/*`) — `getMetrics()` already returns the JSON the dashboard needs.
- `SessionStore`, `WeeklySummaryGenerator` — file-based persistence already in place.
- `HookEventProcessor` — already pairs pre/post hooks into `ToolCallRecord`s.
- Storage layout in `~/.nr-ai-observe/` — unchanged.

### Key insight

In-process means real-time is essentially free. Trackers feed a single `LiveEventBus`; the SSE handler subscribes; the browser reconnects automatically. Round-trip from `PostToolUse` hook to browser repaint targets ~1 second (most of which is the existing JSONL poll interval).

## §2 — The `mode` switch

A single new config field decides cloud vs local vs both.

### Config additions

```ts
// src/config.ts
interface McpServerConfig {
  // ... existing fields ...
  mode: 'cloud' | 'local' | 'both';   // default: 'cloud'
  dashboard: {
    port: number;                      // default: 7777
    host: string;                      // default: '127.0.0.1' — hardcoded in v1
    openOnStart: boolean;              // default: false
  };
}
```

Environment variable overrides follow existing patterns:

- `NR_AI_MODE=local`
- `NR_AI_DASHBOARD_PORT=7777`
- `NR_AI_DASHBOARD_OPEN=true`

### Behavior matrix

| `mode`              | `licenseKey`       | NR transport | Dashboard | Use case                       |
|---------------------|--------------------|--------------|-----------|--------------------------------|
| `'cloud'` (default) | required           | on           | off       | existing users, today          |
| `'local'`           | optional (ignored) | off          | on        | privacy-first users            |
| `'both'`            | required           | on           | on        | power users, transition aid    |

### Implementation notes

- **Validation logic** in `config.ts`: only require `licenseKey` when `mode !== 'local'`. The current unconditional `throw` (around `src/config.ts:319`) becomes a `mode`-gated check.
- **Transport gating** in `server.ts`: when `mode === 'local'`, do not construct `NrIngestManager` at all (cleaner than no-opping flushes). The privacy-proof test asserts this.
- **Dashboard startup** in `server.ts`: when `mode === 'local'` or `mode === 'both'`, construct `DashboardServer` after trackers, before MCP transport connects.
- **Logger output**: print the URL prominently to stderr on startup (`Dashboard ready at http://127.0.0.1:7777`) so it surfaces in Claude Code's MCP startup logs.

### Privacy posture (verifiable)

In `local` mode we guarantee:

- **No NR API calls.** `NrIngestManager` is never instantiated. Asserted by an integration test.
- **No outbound HTTP from the dashboard.** Strict CSP (`default-src 'self'`), no CDN fonts, no analytics, no remote source maps.
- **No telemetry on the dashboard itself.** No phone-home, no version check, no crash reporting.
- **Localhost-only binding.** `127.0.0.1` is hardcoded in v1. Custom `host` config values are warned and ignored until v1.1 ships proper auth.

## §3 — HTTP server + SSE

A thin Node `http.createServer` (no Express). Three responsibilities: serve the SPA, serve JSON, push live events.

### Module layout

```
src/dashboard/
├── dashboard-server.ts        # http.createServer + routing
├── dashboard-server.test.ts
├── routes/
│   ├── api-handler.ts         # GET /api/* → tracker.getMetrics()
│   ├── api-handler.test.ts
│   ├── sse-handler.ts         # GET /sse → live event stream
│   ├── sse-handler.test.ts
│   ├── static-handler.ts      # GET / → dist/web/index.html etc.
│   └── static-handler.test.ts
├── live-event-bus.ts          # EventEmitter, single in-process bus
└── live-event-bus.test.ts
```

### Routes

| Method · Path                | Returns                       | Source                              |
|------------------------------|-------------------------------|-------------------------------------|
| `GET /`                      | SPA index.html                | `dist/web/index.html`               |
| `GET /assets/*`              | JS, CSS, fonts (bundled)      | `dist/web/assets/`                  |
| `GET /api/session/current`   | SessionMetrics JSON           | `SessionTracker.getMetrics()`       |
| `GET /api/session/today`     | aggregate of today's sessions | `SessionStore` + trackers           |
| `GET /api/sessions?limit=50` | list of past sessions         | `SessionStore.list()`               |
| `GET /api/sessions/:id`      | full session detail           | `SessionStore.read(id)`             |
| `GET /api/cost`              | cost breakdown + forecast     | `CostTracker` + `CostForecast`      |
| `GET /api/anti-patterns`     | detected patterns             | `AntiPatternDetector`               |
| `GET /api/audit`             | audit trail records           | `AuditTrailManager`                 |
| `GET /api/weekly`            | weekly summaries              | `WeeklySummaryGenerator`            |
| `GET /sse`                   | text/event-stream             | `LiveEventBus`                      |
| `GET /api/health`            | `{ ok, uptime, version }`     | trivial                             |

### SSE event shape

```
event: tool-call
data: {"id":"…","tool":"Read","duration_ms":120,"cost":0.0034,"ts":1716923400}

event: anti-pattern
data: {"type":"thrashing","target":"auth.ts","count":4}

event: cost-update
data: {"session_total":3.42,"today_total":12.17,"forecast_eod":18.40}

event: heartbeat
data: {"ts":1716923430}
```

The heartbeat fires every 30 s to keep idle proxies / browser tabs from dropping the connection.

### Live event flow

```
PostToolUse hook
      │
      ▼
collector → buffer.jsonl
                 │
                 ▼  (existing poll interval)
           HookEventProcessor
                 │
                 ▼
           ToolCallRecord
                 │
        ┌────────┴────────┐
        ▼        ▼        ▼
  SessionTracker  CostTracker  AntiPatternDetector
        │        │        │
        └────────┴────────┘
                 │
                 ▼
         LiveEventBus.emit()
                 │
                 ▼  (SSE)
          connected browser
                 │
                 ▼
         dashboard re-renders
```

### Security headers

- `Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'`
- **Host validation:** reject any request whose `Host` header is not `localhost:<port>` or `127.0.0.1:<port>`. This is DNS-rebinding protection — without it a malicious page on the public internet could trick the browser into sending requests to the local dashboard.
- No CORS — same-origin only.
- No auth — loopback only, single user.

### Why no Express

`src/proxy/proxy-manager.ts` already uses raw `http.createServer` for similar work. Matching that pattern keeps dependencies minimal (this is a privacy-conscious project), avoids middleware complexity, and the routing surface (~12 routes) is small enough that a single switch statement is clearer than a router.

## §4 — The SPA — stack, layout, four views

### Visual direction

**Console.** Dark, dense, NR-native — the same family aesthetic as the cloud product so existing users feel at home and the migration story between modes is seamless.

### Stack

| Layer       | Choice                | Why                                                                 |
|-------------|-----------------------|---------------------------------------------------------------------|
| Framework   | `react@18`            | Familiar, great SSE/`useEffect` story, most contributors know it    |
| Build       | `vite@5`              | ESM-native (matches repo), fast HMR, zero config to start           |
| Routing     | `wouter`              | ~1 KB, no React Router complexity, hash-mode keeps server stupid    |
| Styling     | `tailwindcss@3`       | Dark theme out of the box, dense utilities match Console aesthetic  |
| Charts      | `recharts`            | Declarative; sparklines + time-series + bars all built-in           |
| Icons       | `lucide-react`        | Tree-shaken line-icons that match Console density                   |
| State       | React Query + Zustand | React Query for HTTP caches; Zustand for the SSE-fed live store     |
| Fonts       | Inter + JetBrains Mono| Self-hosted from `dist/web/assets/fonts/`. No Google Fonts.         |

### App shell

A persistent left sidebar with four nav items (Today / Sessions / History / Audit), a small live-connection indicator at the bottom (`● connected` / `● reconnecting`), and a content area on the right that renders the current view.

### The four views

**Today** — "what's happening right now."

- 4 KPI cards: spend · calls · efficiency · flags
- Tool latency timeline (last hour)
- Live recent calls table (SSE-fed, last 20)
- Active anti-pattern alerts
- Cost forecast for end-of-day

**Sessions** — "pick a session, see everything."

- Left: scrollable list of all sessions, newest first
- Right: timeline of every tool call (Gantt-ish)
- Tool detail panel on hover/click — pre+post hooks, latency, cost
- Session header: total cost, duration, outcome, anti-patterns

**History** — "how am I trending?"

- Weekly efficiency line chart (last 8 weeks)
- Spend bar chart (daily, last 30 days)
- Cost-per-outcome breakdown (bug fix vs feature vs refactor)
- Anti-pattern frequency over time
- "Personal coach" narrative card (uses existing `PersonalCoach` metric)

**Audit** — "what did Claude touch?"

- Filterable table from `AuditTrailManager`
- Categories: sensitive file reads · destructive commands · external network
- Per-row: timestamp, session, tool, target, classification
- Export to JSONL button (writes a local file, no upload)

### Live wiring

A single `useLiveEvents` hook owns the SSE subscription and pushes parsed events into a Zustand store. Every view subscribes only to the slices it needs:

```ts
// src/web/hooks/useLiveEvents.ts
function useLiveEvents() {
  const setLive = useLiveStore(s => s.update);
  useEffect(() => {
    const es = new EventSource('/sse');
    es.addEventListener('tool-call',    e => setLive('toolCall',    JSON.parse(e.data)));
    es.addEventListener('cost-update',  e => setLive('cost',        JSON.parse(e.data)));
    es.addEventListener('anti-pattern', e => setLive('antiPattern', JSON.parse(e.data)));
    return () => es.close();
  }, []);
}
```

Mounted once at `App.tsx`. Each view selects from the store via Zustand's `useStore(selector)`.

## §5 — Build, distribution, testing

### Repo layout (additions)

```
nr-ai-observatory/
├── src/
│   ├── dashboard/             NEW  — server-side: HTTP, SSE, routes
│   └── web/                   NEW  — SPA source
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── views/
│       │   ├── Today.tsx
│       │   ├── Sessions.tsx
│       │   ├── History.tsx
│       │   └── Audit.tsx
│       ├── components/        # shared widgets: Kpi, Sparkline, etc.
│       ├── hooks/
│       │   └── useLiveEvents.ts
│       ├── store/
│       │   └── liveStore.ts   # Zustand
│       └── api/
│           └── client.ts      # fetch wrappers, React Query keys
│
├── vite.config.ts             NEW
├── tailwind.config.js         NEW
├── postcss.config.js          NEW
├── tsconfig.web.json          NEW  — separate config so main tsc doesn't see SPA
└── dist/
    ├── index.js               # existing — MCP server
    ├── dashboard/             NEW  — compiled server-side dashboard code
    └── web/                   NEW  — Vite output, served as static files
        ├── index.html
        └── assets/
            ├── main-[hash].js
            ├── main-[hash].css
            └── fonts/
```

### npm scripts

```json
{
  "scripts": {
    "build:server": "tsc --build && chmod +x dist/index.js dist/hooks/collector-script.js",
    "build:web":    "vite build",
    "build":        "npm run build:server && npm run build:web",
    "dev:web":      "vite",
    "test":         "jest",
    "test:web":     "vitest run"
  }
}
```

The existing `chmod +x` dance in `build:server` is preserved — `tsc` strips execute bits, and the binaries lose MCP connectivity without it.

### Distribution

Per the NR Labs model (free GitHub asset, no SKU, no paywall):

- User clones the repo (or eventually `npm install -g nr-ai-mcp-server` if published).
- `npm install && npm run build` produces `dist/` with both server and SPA.
- User edits `~/.nr-ai-observe/config.json` with `{ "mode": "local" }` — no `licenseKey` needed.
- Setup wizard (`nr-ai-observe setup`) gains a new "Mode" branch with explainers for each value.
- On Claude Code startup, MCP boots and prints: `Dashboard ready at http://127.0.0.1:7777`.

### Testing strategy

| Layer              | Tool                       | Coverage                                                                                          |
|--------------------|----------------------------|---------------------------------------------------------------------------------------------------|
| Server unit        | Jest (existing)            | `DashboardServer` route handlers, `LiveEventBus` emit/subscribe, `mode` gating in `config.ts`     |
| Server integration | Jest + supertest           | End-to-end HTTP: hit `/api/session/current`, verify JSON shape; SSE handshake + heartbeat         |
| SPA component      | Vitest + Testing Library   | Each view renders correctly with mock data; Sparkline, Kpi, etc.                                  |
| Privacy proof      | Jest                       | In `mode: 'local'`: `NrIngestManager` is never instantiated; outbound HTTP mock catches no calls  |
| Manual smoke       | Checklist                  | Boot Claude Code, open dashboard, run a real prompt, watch live updates appear                    |

### Defensive details

- **Port-in-use** — if `7777` is taken, log a clear error and exit. Don't silently fall back to a random port (would surprise the user). Suggest `NR_AI_DASHBOARD_PORT` in the error message.
- **SSE backpressure** — single subscriber (the user's one browser); on connection drop, EventSource auto-reconnects. Server keeps a small ring buffer (~100 events) and replays on reconnect via `Last-Event-ID`.
- **SPA bundle ceiling** — CI check fails the build if `dist/web/assets/main-*.js` exceeds 400 KB gzipped. Keeps load time snappy and discourages dependency creep.
- **Lint posture** — same target as the rest of the repo: 0 errors, 0 warnings. ESLint plugin-react added; no `eslint-disable` shortcuts.

## §6 — Out of scope, risks, ship plan

### Explicitly out of scope (v1.1+)

**Networking & multi-user**
- LAN / non-loopback binding
- Authentication (no users, no tokens)
- Multi-user data separation
- Phone / tablet access

**Lifecycle**
- Standalone `nr-ai-observe ui` review-mode command
- Always-on daemon (decoupled from MCP)
- Cross-platform browser auto-open

**UX polish**
- Light theme / theme toggle (Console is dark-only)
- Mobile-responsive layouts
- WCAG AA accessibility audit
- i18n / localization
- Settings editor in the SPA (config stays file-based)

**Power features**
- Cross-session global search / filter
- PDF / image export
- Comparison view (this week vs last)
- Inline annotation / notes on sessions
- **Local alerts** — threshold rules (budget, anti-pattern frequency, latency) evaluated in-process, surfaced via OS notification or in-dashboard banner. Mirrors the cloud `alerts/` NRQL conditions but runs locally with no NR dependency.

### Risks & mitigations

| Risk                                                         | Likelihood | Mitigation                                                                                                                                                             |
|--------------------------------------------------------------|------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Scope creep** — 4 views in 4 weeks is tight                | High       | Build Today first end-to-end (weeks 1–2). If we slip, drop History to v1.1 first — Audit and Sessions matter more for trust.                                           |
| **Dual-build** (tsc + vite) — type-resolution friction       | Medium     | `src/web/` lives under its own `tsconfig.web.json`; main `tsconfig.json` excludes it. Vite handles its own type checking for the SPA.                                  |
| **SSE on idle browser** — connection silently drops          | Medium     | 30 s heartbeat + EventSource auto-reconnect + ring-buffer replay via `Last-Event-ID`. Visible "● connected / ● reconnecting" indicator in the sidebar.                |
| **Bundle size creep** — recharts is ~95 KB                   | Low        | CI ceiling at 400 KB gzipped. If recharts bites, fall back to `uplot` (~40 KB) for the heavy charts.                                                                   |
| **Existing tests break** from `mode` field default           | Low        | Default stays `'cloud'`. All existing tests run unchanged. New tests added for `local` and `both` modes.                                                               |

### 4-week ship plan to 2026-06-23

| Week | Dates           | Deliverable                                                                                                                                       |
|------|-----------------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| 1    | May 29 – Jun 4  | **Backend foundation.** `mode` field + config gating. `DashboardServer` + `LiveEventBus` + first 4 routes + SSE handshake. Privacy-proof test passes. |
| 2    | Jun 5 – Jun 11  | **SPA shell + Today + Audit.** Vite scaffold, Tailwind, sidebar, the Today view live (real SSE updates), Audit table. Demo-able to managers by Jun 11. |
| 3    | Jun 12 – Jun 18 | **Sessions + History.** Session list + drill-in timeline, History weekly trends. Component test coverage. Bundle-size CI check live.              |
| 4    | Jun 19 – Jun 23 | **Polish + docs.** Setup wizard "Mode" branch, README updates, ONBOARDING.md edits, smoke testing. PR open by Jun 21, merged by Jun 23 morning.     |

### Open questions (resolvable in plan or implementation)

- Should the Audit view export use plain JSONL or a signed, timestamped format? Probably plain — privacy-first, not compliance-first per the §1 driver.
- What does Claude Code's MCP startup-log surface look like for end users? Will the dashboard URL actually be visible to them, or do we need a louder signal? Worth a 30-min UX check during week 1.
- Do we add a "panic button" — a one-click "switch to cloud mode" link in the dashboard? Probably not (config is file-based for security), but worth thinking about.
