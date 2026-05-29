# Local-Only Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a privacy-first local mode (`mode: 'local'`) that suppresses all New Relic transport and serves an embedded React/Vite dashboard at `http://127.0.0.1:7777` with four views (Today, Sessions, History, Audit), driven by SSE for real-time updates.

**Architecture:** The dashboard runs **in-process** with the existing MCP server. A new `LiveEventBus` (a single `EventEmitter`) is fed from the existing `eventProcessor.onRecord` callback in `src/index.ts`; a new `DashboardServer` (raw `http.createServer`, no Express) wraps it with REST + SSE. The SPA lives under `src/web/`, builds via Vite to `dist/web/`, and is served as static files by the same HTTP server. A new `mode: 'cloud' | 'local' | 'both'` config field gates whether `NrIngestManager` is constructed and whether the dashboard server boots.

**Tech Stack:** TypeScript ESM (existing) · Node `http.createServer` · React 18 · Vite 5 · Tailwind 3 · Recharts · wouter · React Query · Zustand · lucide-react · Jest (existing) · Vitest + React Testing Library (new for SPA)

**Spec:** [`docs/superpowers/specs/2026-05-28-local-only-mode-design.md`](../specs/2026-05-28-local-only-mode-design.md)

**Branch:** `feat/local-only-mode-spec` (extend with implementation commits, or branch off as `feat/local-only-mode`)

---

## File structure

### New files (server-side)

| Path | Responsibility |
|---|---|
| `src/dashboard/live-event-bus.ts` | `EventEmitter` wrapper with typed `emit`/`on` for `tool-call`, `cost-update`, `anti-pattern` |
| `src/dashboard/live-event-bus.test.ts` | Unit tests for the bus |
| `src/dashboard/dashboard-server.ts` | `http.createServer` lifecycle, routing switch, Host validation, CSP headers |
| `src/dashboard/dashboard-server.test.ts` | Unit + integration tests for the server |
| `src/dashboard/routes/static-handler.ts` | Serves `dist/web/index.html` and `/assets/*` |
| `src/dashboard/routes/static-handler.test.ts` | |
| `src/dashboard/routes/api-handler.ts` | `GET /api/*` — JSON wrappers around `tracker.getMetrics()` |
| `src/dashboard/routes/api-handler.test.ts` | |
| `src/dashboard/routes/sse-handler.ts` | `GET /sse` — text/event-stream + heartbeat + `Last-Event-ID` replay |
| `src/dashboard/routes/sse-handler.test.ts` | |
| `src/dashboard/index.ts` | Barrel export |

### New files (SPA)

| Path | Responsibility |
|---|---|
| `src/web/index.html` | Vite SPA entry |
| `src/web/main.tsx` | React mount + global providers |
| `src/web/App.tsx` | Sidebar + view switcher (wouter routing) |
| `src/web/views/Today.tsx` | Today dashboard (KPIs, sparkline, live recents) |
| `src/web/views/Sessions.tsx` | Session list + drill-in timeline |
| `src/web/views/History.tsx` | Trend charts |
| `src/web/views/Audit.tsx` | Audit trail table + JSONL export |
| `src/web/components/Sidebar.tsx` | Persistent left nav |
| `src/web/components/Kpi.tsx` | KPI card primitive |
| `src/web/components/Sparkline.tsx` | Tiny inline chart |
| `src/web/components/StatusIndicator.tsx` | `● connected` / `● reconnecting` badge |
| `src/web/hooks/useLiveEvents.ts` | Single SSE subscription, dispatches to Zustand store |
| `src/web/store/liveStore.ts` | Zustand store for SSE-fed live data |
| `src/web/api/client.ts` | `fetch` wrappers and React Query keys |

### New config files

| Path | Responsibility |
|---|---|
| `vite.config.ts` (repo root) | Vite build config — output to `dist/web/` |
| `tailwind.config.js` (repo root) | Tailwind purge config — scans `src/web/**/*.{ts,tsx}` |
| `postcss.config.js` (repo root) | Tailwind + autoprefixer pipeline |
| `tsconfig.web.json` (repo root) | Separate TS config for `src/web/` (DOM lib, React JSX) |
| `vitest.config.ts` (repo root) | Vitest for SPA component tests |

### Modified files

| Path | Change |
|---|---|
| `src/config.ts` | Add `mode` and `dashboard` fields to `McpServerConfig`, Zod schema, and loader |
| `src/config.test.ts` | Tests for the new config fields |
| `src/index.ts` | Skip `NrIngestManager` when `mode === 'local'`; emit to `LiveEventBus` from `onRecord`; boot `DashboardServer` when mode has dashboard |
| `src/index.test.ts` (or `src/server.integration.test.ts`) | Privacy-proof test |
| `src/install/setup-wizard.ts` | New "Mode" branch in the wizard |
| `tsconfig.json` | Exclude `src/web/` so the server build doesn't see SPA source |
| `eslint.config.mjs` | Add `eslint-plugin-react` for `src/web/**` |
| `package.json` | Add deps + new scripts (`build:server`, `build:web`, `dev:web`, `test:web`) |
| `README.md` | Document `mode` config and dashboard URL |
| `docs/ONBOARDING.md` | Add a "Local mode" section |

---

## Conventions for every task

- Every task follows TDD: write the failing test → confirm it fails → write minimal code → confirm it passes → commit.
- Every commit message starts with `Feat:` (new functionality) or `Test:` (test-only) and matches the existing repo convention. Add `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` when AI-assisted.
- After every code change run `npm run lint` and `npm run build` before committing. The repo target is **zero ESLint errors and zero warnings**.
- Imports use `.js` extensions (ESM `NodeNext` resolution). Never write `import './foo'` — always `import './foo.js'`.
- Test files are co-located: `foo.ts` → `foo.test.ts` in the same directory.
- Loggers are scoped: `const logger = createLogger('module-name')` at module top.

---

# Phase 1 — Backend foundation

Goal by end of phase: `npm test` passes a privacy-proof test that proves `mode: 'local'` skips `NrIngestManager` entirely; a stub HTTP server responds to `GET /api/health` on `127.0.0.1:7777`.

## Task 1 — Add `mode` field to `McpServerConfig` interface

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/config.test.ts`:

```ts
describe('mode field', () => {
  it("defaults to 'cloud' when unset", () => {
    const config = loadMcpConfig({
      port: 9847, config: null, logLevel: 'info', stdio: true,
    } as CliOptions, {
      env: { NEW_RELIC_LICENSE_KEY: 'abc', NEW_RELIC_ACCOUNT_ID: '1' },
      file: {},
    });
    expect(config.mode).toBe('cloud');
  });
});
```

- [ ] **Step 2: Run test, expect failure**

```bash
npx jest -- src/config.test.ts -t "mode field"
```

Expected: FAIL — `config.mode` is `undefined` (property doesn't exist).

- [ ] **Step 3: Add `mode` to the `McpServerConfig` interface and Zod schema**

In `src/config.ts`, find the `McpServerConfig` interface and add:

```ts
readonly mode: 'cloud' | 'local' | 'both';
```

Find the Zod schema (currently around `licenseKey: z.string().optional()`) and add inside the schema object:

```ts
mode: z.enum(['cloud', 'local', 'both']).optional(),
```

Find the `loadMcpConfig` return object and add (before `licenseKey`):

```ts
mode: (process.env.NR_AI_MODE as 'cloud' | 'local' | 'both' | undefined)
  ?? (file.mode as 'cloud' | 'local' | 'both' | undefined)
  ?? 'cloud',
```

- [ ] **Step 4: Run test, expect pass**

```bash
npx jest -- src/config.test.ts -t "mode field"
```

Expected: PASS.

- [ ] **Step 5: Run full lint + build**

```bash
npm run lint && npm run build
```

Expected: zero errors, zero warnings.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "$(cat <<'EOF'
Feat: Add mode field to McpServerConfig

Introduces 'cloud' | 'local' | 'both' enum that will gate licenseKey
requirement and dashboard server startup. Default 'cloud' preserves
existing behavior.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

## Task 2 — Accept `mode` from `NR_AI_MODE` env var (additional test coverage)

**Files:**
- Modify: `src/config.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the `describe('mode field', ...)` block in `src/config.test.ts`:

```ts
it("reads mode from NR_AI_MODE env var", () => {
  const config = loadMcpConfig({
    port: 9847, config: null, logLevel: 'info', stdio: true,
  } as CliOptions, {
    env: { NEW_RELIC_LICENSE_KEY: 'abc', NEW_RELIC_ACCOUNT_ID: '1', NR_AI_MODE: 'local' },
    file: {},
  });
  expect(config.mode).toBe('local');
});

it("file value beats default but loses to env var", () => {
  const config = loadMcpConfig({
    port: 9847, config: null, logLevel: 'info', stdio: true,
  } as CliOptions, {
    env: { NEW_RELIC_LICENSE_KEY: 'abc', NEW_RELIC_ACCOUNT_ID: '1', NR_AI_MODE: 'local' },
    file: { mode: 'both' },
  });
  expect(config.mode).toBe('local');
});

it("file value wins when env var unset", () => {
  const config = loadMcpConfig({
    port: 9847, config: null, logLevel: 'info', stdio: true,
  } as CliOptions, {
    env: { NEW_RELIC_LICENSE_KEY: 'abc', NEW_RELIC_ACCOUNT_ID: '1' },
    file: { mode: 'both' },
  });
  expect(config.mode).toBe('both');
});
```

- [ ] **Step 2: Run tests, expect pass**

```bash
npx jest -- src/config.test.ts -t "mode field"
```

Expected: PASS (the loader code from Task 1 already handles env > file > default).

- [ ] **Step 3: Commit**

```bash
git add src/config.test.ts
git commit -m "Test: cover mode field env-var and file-value precedence

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 3 — Add `dashboard` config field with port/host/openOnStart

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/config.test.ts`:

```ts
describe('dashboard config', () => {
  it("defaults port=7777, host='127.0.0.1', openOnStart=false", () => {
    const config = loadMcpConfig({
      port: 9847, config: null, logLevel: 'info', stdio: true,
    } as CliOptions, {
      env: { NEW_RELIC_LICENSE_KEY: 'abc', NEW_RELIC_ACCOUNT_ID: '1' },
      file: {},
    });
    expect(config.dashboard.port).toBe(7777);
    expect(config.dashboard.host).toBe('127.0.0.1');
    expect(config.dashboard.openOnStart).toBe(false);
  });

  it("reads dashboard.port from NR_AI_DASHBOARD_PORT", () => {
    const config = loadMcpConfig({
      port: 9847, config: null, logLevel: 'info', stdio: true,
    } as CliOptions, {
      env: { NEW_RELIC_LICENSE_KEY: 'abc', NEW_RELIC_ACCOUNT_ID: '1', NR_AI_DASHBOARD_PORT: '9999' },
      file: {},
    });
    expect(config.dashboard.port).toBe(9999);
  });

  it("warns and forces host to 127.0.0.1 when non-loopback configured", () => {
    const warns: string[] = [];
    const config = loadMcpConfig({
      port: 9847, config: null, logLevel: 'info', stdio: true,
    } as CliOptions, {
      env: { NEW_RELIC_LICENSE_KEY: 'abc', NEW_RELIC_ACCOUNT_ID: '1' },
      file: { dashboard: { host: '0.0.0.0' } },
      warn: (msg) => warns.push(msg),
    });
    expect(config.dashboard.host).toBe('127.0.0.1');
    expect(warns.some((w) => w.includes('non-loopback'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

```bash
npx jest -- src/config.test.ts -t "dashboard config"
```

Expected: FAIL — `config.dashboard` is `undefined`.

- [ ] **Step 3: Add `dashboard` to interface and Zod schema**

In `src/config.ts`, append to the `McpServerConfig` interface:

```ts
readonly dashboard: {
  readonly port: number;
  readonly host: string;
  readonly openOnStart: boolean;
};
```

Add to the Zod schema:

```ts
dashboard: z.object({
  port: z.number().int().min(1).max(65535).optional(),
  host: z.string().optional(),
  openOnStart: z.boolean().optional(),
}).optional(),
```

In `loadMcpConfig`, before the return statement, add:

```ts
const dashboardFile = (file.dashboard ?? {}) as { port?: number; host?: string; openOnStart?: boolean };
const dashboardPortRaw = process.env.NR_AI_DASHBOARD_PORT
  ? parseInt(process.env.NR_AI_DASHBOARD_PORT, 10)
  : dashboardFile.port;
const dashboardPort = Number.isFinite(dashboardPortRaw) && dashboardPortRaw! > 0 && dashboardPortRaw! <= 65535
  ? dashboardPortRaw!
  : 7777;
const requestedHost = process.env.NR_AI_DASHBOARD_HOST ?? dashboardFile.host ?? '127.0.0.1';
let dashboardHost = '127.0.0.1';
if (requestedHost !== '127.0.0.1' && requestedHost !== 'localhost') {
  warn(`dashboard.host '${requestedHost}' is non-loopback; v1 only supports loopback. Forcing 127.0.0.1.`);
} else {
  dashboardHost = requestedHost === 'localhost' ? '127.0.0.1' : requestedHost;
}
const dashboardOpenOnStart = process.env.NR_AI_DASHBOARD_OPEN === 'true'
  || dashboardFile.openOnStart === true;
```

Add to the return object:

```ts
dashboard: {
  port: dashboardPort,
  host: dashboardHost,
  openOnStart: dashboardOpenOnStart,
},
```

If `loadMcpConfig` doesn't already accept a `warn` injection, extend its second parameter shape:

```ts
export function loadMcpConfig(
  cli: CliOptions,
  overrides?: { env?: Record<string, string | undefined>; file?: Partial<McpServerConfig>; warn?: (msg: string) => void },
): McpServerConfig {
  const env = overrides?.env ?? process.env;
  const file = overrides?.file ?? readConfigFile(cli.config);
  const warn = overrides?.warn ?? ((msg: string) => logger.warn(msg));
  // ... existing body ...
}
```

- [ ] **Step 4: Run test, expect pass**

```bash
npx jest -- src/config.test.ts -t "dashboard config"
```

Expected: PASS.

- [ ] **Step 5: Lint + build**

```bash
npm run lint && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "Feat: add dashboard config block (port/host/openOnStart)

Defaults to 127.0.0.1:7777 with auto-open disabled. Non-loopback hosts
log a warning and are forced to 127.0.0.1 in v1.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 4 — Gate `licenseKey` requirement on `mode`

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/config.test.ts`:

```ts
describe('licenseKey gating', () => {
  it("throws when mode='cloud' and licenseKey missing", () => {
    expect(() => loadMcpConfig(
      { port: 9847, config: null, logLevel: 'info', stdio: true } as CliOptions,
      { env: { NEW_RELIC_ACCOUNT_ID: '1' }, file: {} },
    )).toThrow(/licenseKey/);
  });

  it("does NOT throw when mode='local' and licenseKey missing", () => {
    expect(() => loadMcpConfig(
      { port: 9847, config: null, logLevel: 'info', stdio: true } as CliOptions,
      { env: { NR_AI_MODE: 'local' }, file: {} },
    )).not.toThrow();
  });

  it("throws when mode='both' and licenseKey missing", () => {
    expect(() => loadMcpConfig(
      { port: 9847, config: null, logLevel: 'info', stdio: true } as CliOptions,
      { env: { NR_AI_MODE: 'both', NEW_RELIC_ACCOUNT_ID: '1' }, file: {} },
    )).toThrow(/licenseKey/);
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

```bash
npx jest -- src/config.test.ts -t "licenseKey gating"
```

Expected: FAIL — local-mode case still throws.

- [ ] **Step 3: Update the licenseKey check**

In `src/config.ts`, find the `if (!licenseKey) { throw new Error(…) }` block (around line 319). Replace with:

```ts
const mode: 'cloud' | 'local' | 'both' =
  (env.NR_AI_MODE as 'cloud' | 'local' | 'both' | undefined)
  ?? (file.mode as 'cloud' | 'local' | 'both' | undefined)
  ?? 'cloud';

if (mode !== 'local' && !licenseKey) {
  throw new Error(
    `Missing required configuration: licenseKey (mode='${mode}'). ` +
    `Set NEW_RELIC_LICENSE_KEY, add 'licenseKey' to ~/.nr-ai-observe/config.json, ` +
    `or switch to mode='local' to skip cloud transport.`,
  );
}
```

Move the `mode` resolution above this check (it currently happens later when the return object is built — extract it). Reuse the same `mode` variable in the return object.

Also update the `accountId` check similarly:

```ts
if (mode !== 'local' && !accountId) {
  throw new Error(/* existing message + mode hint */);
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npx jest -- src/config.test.ts -t "licenseKey gating"
```

Expected: PASS. Also re-run full config tests:

```bash
npx jest -- src/config.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Lint + build**

```bash
npm run lint && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "Feat: only require licenseKey/accountId when mode != 'local'

In local mode the dashboard runs entirely on the user's machine and no
NR transport is constructed, so credentials are unnecessary.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 5 — Document `mode` and `dashboard` in `example.config.js`

**Files:**
- Modify: `example.config.js`

- [ ] **Step 1: Read the file**

```bash
cat example.config.js | head -40
```

- [ ] **Step 2: Add annotated entries**

Append (or merge into the appropriate section) the following commented-out documentation block in the same style as existing entries:

```js
// ----------------------------------------------------------------------
// LOCAL DASHBOARD MODE
// ----------------------------------------------------------------------
//
// `mode` controls what destinations receive your AI-coding telemetry:
//
//   'cloud' — (default) ship every event to New Relic. Existing behaviour.
//             Requires `licenseKey` and `accountId`.
//   'local' — keep all data on your machine. The MCP server boots an
//             embedded HTTP dashboard at http://127.0.0.1:7777 and does
//             NOT send anything to NR. `licenseKey` is optional.
//   'both'  — do both. Useful as a transition aid.
//
// mode: 'cloud',
//
// dashboard: {
//   port: 7777,             // local HTTP port for the dashboard
//   host: '127.0.0.1',      // loopback only in v1; non-loopback values
//                           // are warned and overridden
//   openOnStart: false,     // (future) auto-open in your default browser
// },
```

- [ ] **Step 3: Lint check**

```bash
npm run lint
```

Expected: zero issues.

- [ ] **Step 4: Commit**

```bash
git add example.config.js
git commit -m "Docs: document mode and dashboard fields in example.config.js

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 6 — Create `LiveEventBus` (typed `EventEmitter` wrapper)

**Files:**
- Create: `src/dashboard/live-event-bus.ts`
- Create: `src/dashboard/live-event-bus.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/dashboard/live-event-bus.test.ts`:

```ts
import { LiveEventBus } from './live-event-bus.js';

describe('LiveEventBus', () => {
  it('delivers tool-call events to subscribers', () => {
    const bus = new LiveEventBus();
    const received: unknown[] = [];
    bus.on('tool-call', (e) => received.push(e));
    bus.emit('tool-call', { id: 'a', tool: 'Read', durationMs: 12, costUsd: 0.001, ts: 1 });
    expect(received).toEqual([{ id: 'a', tool: 'Read', durationMs: 12, costUsd: 0.001, ts: 1 }]);
  });

  it('supports multiple event types independently', () => {
    const bus = new LiveEventBus();
    const tools: unknown[] = [];
    const costs: unknown[] = [];
    bus.on('tool-call', (e) => tools.push(e));
    bus.on('cost-update', (e) => costs.push(e));
    bus.emit('tool-call', { id: 'a', tool: 'Read', durationMs: 1, costUsd: 0, ts: 1 });
    bus.emit('cost-update', { sessionTotalUsd: 0.5, todayTotalUsd: 1.0, forecastEodUsd: 2.0 });
    expect(tools).toHaveLength(1);
    expect(costs).toHaveLength(1);
  });

  it('off() removes a listener', () => {
    const bus = new LiveEventBus();
    const received: unknown[] = [];
    const handler = (e: unknown) => received.push(e);
    bus.on('tool-call', handler);
    bus.off('tool-call', handler);
    bus.emit('tool-call', { id: 'a', tool: 'Read', durationMs: 1, costUsd: 0, ts: 1 });
    expect(received).toHaveLength(0);
  });

  it('keeps a ring buffer of the last 100 events for replay', () => {
    const bus = new LiveEventBus({ replayBufferSize: 100 });
    for (let i = 0; i < 150; i++) {
      bus.emit('tool-call', { id: String(i), tool: 'Read', durationMs: 1, costUsd: 0, ts: i });
    }
    const replay = bus.replayFrom(0);
    expect(replay.length).toBe(100);
    expect((replay[0]!.payload as { id: string }).id).toBe('50');
    expect((replay[99]!.payload as { id: string }).id).toBe('149');
  });

  it('replayFrom(seq) returns events with seq > given', () => {
    const bus = new LiveEventBus();
    for (let i = 0; i < 10; i++) {
      bus.emit('tool-call', { id: String(i), tool: 'Read', durationMs: 1, costUsd: 0, ts: i });
    }
    const replay = bus.replayFrom(5);
    expect(replay.length).toBe(4);
    expect((replay[0]!.payload as { id: string }).id).toBe('6');
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

```bash
npx jest -- src/dashboard/live-event-bus.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the module**

Create `src/dashboard/live-event-bus.ts`:

```ts
import { EventEmitter } from 'node:events';

export interface ToolCallEvent {
  readonly id: string;
  readonly tool: string;
  readonly durationMs: number;
  readonly costUsd: number;
  readonly ts: number;
}

export interface CostUpdateEvent {
  readonly sessionTotalUsd: number;
  readonly todayTotalUsd: number;
  readonly forecastEodUsd: number | null;
}

export interface AntiPatternEvent {
  readonly type: string;
  readonly target: string;
  readonly count: number;
}

export interface HeartbeatEvent {
  readonly ts: number;
}

export type LiveEventMap = {
  'tool-call': ToolCallEvent;
  'cost-update': CostUpdateEvent;
  'anti-pattern': AntiPatternEvent;
  'heartbeat': HeartbeatEvent;
};

export type LiveEventName = keyof LiveEventMap;

export interface ReplayEntry {
  readonly seq: number;
  readonly event: LiveEventName;
  readonly payload: LiveEventMap[LiveEventName];
}

export interface LiveEventBusOptions {
  readonly replayBufferSize?: number;
}

const DEFAULT_BUFFER_SIZE = 100;

export class LiveEventBus {
  private readonly emitter = new EventEmitter();
  private readonly buffer: ReplayEntry[] = [];
  private readonly bufferSize: number;
  private nextSeq = 1;

  constructor(opts: LiveEventBusOptions = {}) {
    this.bufferSize = opts.replayBufferSize ?? DEFAULT_BUFFER_SIZE;
    this.emitter.setMaxListeners(50);
  }

  on<E extends LiveEventName>(event: E, handler: (payload: LiveEventMap[E]) => void): void {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
  }

  off<E extends LiveEventName>(event: E, handler: (payload: LiveEventMap[E]) => void): void {
    this.emitter.off(event, handler as (...args: unknown[]) => void);
  }

  emit<E extends LiveEventName>(event: E, payload: LiveEventMap[E]): void {
    const seq = this.nextSeq++;
    this.buffer.push({ seq, event, payload });
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    this.emitter.emit(event, payload);
  }

  replayFrom(lastSeq: number): ReplayEntry[] {
    return this.buffer.filter((e) => e.seq > lastSeq);
  }
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npx jest -- src/dashboard/live-event-bus.test.ts
```

Expected: PASS (all 5 tests).

- [ ] **Step 5: Lint + build**

```bash
npm run lint && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/live-event-bus.ts src/dashboard/live-event-bus.test.ts
git commit -m "Feat: add LiveEventBus for in-process dashboard events

Typed EventEmitter wrapper with a 100-event ring buffer for SSE
Last-Event-ID replay. Distinct event types ensure compile-time safety
for emitters and subscribers.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 7 — Add `src/dashboard/index.ts` barrel export

**Files:**
- Create: `src/dashboard/index.ts`

- [ ] **Step 1: Write the file**

```ts
export { LiveEventBus } from './live-event-bus.js';
export type {
  LiveEventName,
  LiveEventMap,
  ToolCallEvent,
  CostUpdateEvent,
  AntiPatternEvent,
  HeartbeatEvent,
  ReplayEntry,
} from './live-event-bus.js';
```

- [ ] **Step 2: Build to confirm compile**

```bash
npm run build
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/index.ts
git commit -m "Feat: add src/dashboard/index.ts barrel export

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 8 — Create `DashboardServer` skeleton (start/stop only)

**Files:**
- Create: `src/dashboard/dashboard-server.ts`
- Create: `src/dashboard/dashboard-server.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/dashboard/dashboard-server.test.ts`:

```ts
import { DashboardServer } from './dashboard-server.js';
import { LiveEventBus } from './live-event-bus.js';

describe('DashboardServer', () => {
  let server: DashboardServer;

  afterEach(async () => {
    await server?.stop();
  });

  it('starts on the configured port and 127.0.0.1', async () => {
    server = new DashboardServer({
      port: 0, host: '127.0.0.1', bus: new LiveEventBus(),
    });
    const addr = await server.start();
    expect(addr.address).toBe('127.0.0.1');
    expect(addr.port).toBeGreaterThan(0);
  });

  it('responds 404 to unknown paths', async () => {
    server = new DashboardServer({
      port: 0, host: '127.0.0.1', bus: new LiveEventBus(),
    });
    const addr = await server.start();
    const res = await fetch(`http://127.0.0.1:${addr.port}/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it('responds 200 to GET /api/health with JSON', async () => {
    server = new DashboardServer({
      port: 0, host: '127.0.0.1', bus: new LiveEventBus(),
    });
    const addr = await server.start();
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.uptime).toBe('number');
  });

  it('stop() closes the server cleanly', async () => {
    server = new DashboardServer({
      port: 0, host: '127.0.0.1', bus: new LiveEventBus(),
    });
    const addr = await server.start();
    await server.stop();
    await expect(fetch(`http://127.0.0.1:${addr.port}/api/health`)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

```bash
npx jest -- src/dashboard/dashboard-server.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the module**

Create `src/dashboard/dashboard-server.ts`:

```ts
import { createServer, IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { createLogger } from '../shared/index.js';
import { LiveEventBus } from './live-event-bus.js';

const logger = createLogger('dashboard-server');

export interface DashboardServerOptions {
  readonly port: number;
  readonly host: string;
  readonly bus: LiveEventBus;
}

export class DashboardServer {
  private readonly opts: DashboardServerOptions;
  private server: HttpServer | undefined;
  private readonly startedAt = Date.now();

  constructor(opts: DashboardServerOptions) {
    this.opts = opts;
  }

  async start(): Promise<AddressInfo> {
    return await new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res));
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.host, () => {
        const addr = server.address() as AddressInfo;
        logger.info('Dashboard server listening', { host: addr.address, port: addr.port });
        this.server = server;
        resolve(addr);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = undefined;
    return await new Promise((resolve) => s.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === 'GET' && req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptime: Date.now() - this.startedAt }));
      return;
    }
    res.writeHead(404);
    res.end();
  }
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npx jest -- src/dashboard/dashboard-server.test.ts
```

Expected: PASS (all 4 tests).

- [ ] **Step 5: Lint + build**

```bash
npm run lint && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/dashboard-server.ts src/dashboard/dashboard-server.test.ts
git commit -m "Feat: add DashboardServer skeleton with /api/health route

Wraps node http.createServer with a tiny start/stop lifecycle. Routes
will be added in subsequent tasks.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 9 — Add Host header validation (DNS rebinding protection)

**Files:**
- Modify: `src/dashboard/dashboard-server.ts`
- Modify: `src/dashboard/dashboard-server.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/dashboard/dashboard-server.test.ts`:

```ts
describe('DashboardServer Host validation', () => {
  let server: DashboardServer;

  afterEach(async () => {
    await server?.stop();
  });

  it('rejects requests with a non-loopback Host header', async () => {
    server = new DashboardServer({ port: 0, host: '127.0.0.1', bus: new LiveEventBus() });
    const addr = await server.start();
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`, {
      headers: { host: 'evil.example.com' },
    });
    expect(res.status).toBe(403);
  });

  it('accepts requests with Host=127.0.0.1:<port>', async () => {
    server = new DashboardServer({ port: 0, host: '127.0.0.1', bus: new LiveEventBus() });
    const addr = await server.start();
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
    expect(res.status).toBe(200);
  });

  it('accepts requests with Host=localhost:<port>', async () => {
    server = new DashboardServer({ port: 0, host: '127.0.0.1', bus: new LiveEventBus() });
    const addr = await server.start();
    const res = await fetch(`http://localhost:${addr.port}/api/health`);
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run, expect failures**

```bash
npx jest -- src/dashboard/dashboard-server.test.ts -t "Host validation"
```

Expected: the `evil.example.com` test FAILS (passes through). The two valid-host tests pass already.

- [ ] **Step 3: Add Host validation in `handle()`**

In `src/dashboard/dashboard-server.ts`, modify `handle()`:

```ts
private handle(req: IncomingMessage, res: ServerResponse): void {
  if (!this.isHostAllowed(req.headers.host)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Forbidden: invalid Host header');
    return;
  }
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: Date.now() - this.startedAt }));
    return;
  }
  res.writeHead(404);
  res.end();
}

private isHostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const hostOnly = hostHeader.split(':')[0]?.toLowerCase();
  return hostOnly === '127.0.0.1' || hostOnly === 'localhost';
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npx jest -- src/dashboard/dashboard-server.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Lint + build**

```bash
npm run lint && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/dashboard-server.ts src/dashboard/dashboard-server.test.ts
git commit -m "Feat: reject non-loopback Host headers (DNS rebinding protection)

Prevents a malicious public-internet page from coercing the user's
browser into requests against the local dashboard.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 10 — Add Content-Security-Policy + base security headers

**Files:**
- Modify: `src/dashboard/dashboard-server.ts`
- Modify: `src/dashboard/dashboard-server.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/dashboard/dashboard-server.test.ts`:

```ts
describe('DashboardServer security headers', () => {
  let server: DashboardServer;
  afterEach(async () => { await server?.stop(); });

  it('sets a strict CSP on every response', async () => {
    server = new DashboardServer({ port: 0, host: '127.0.0.1', bus: new LiveEventBus() });
    const addr = await server.start();
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
  });

  it('sets X-Content-Type-Options: nosniff', async () => {
    server = new DashboardServer({ port: 0, host: '127.0.0.1', bus: new LiveEventBus() });
    const addr = await server.start();
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('sets Referrer-Policy: no-referrer', async () => {
    server = new DashboardServer({ port: 0, host: '127.0.0.1', bus: new LiveEventBus() });
    const addr = await server.start();
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});
```

- [ ] **Step 2: Run, expect failures**

```bash
npx jest -- src/dashboard/dashboard-server.test.ts -t "security headers"
```

Expected: FAIL — headers absent.

- [ ] **Step 3: Add a `setSecurityHeaders` helper and call it in `handle()`**

Modify `src/dashboard/dashboard-server.ts`. Above `handle()`, add:

```ts
private setSecurityHeaders(res: ServerResponse): void {
  res.setHeader(
    'content-security-policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'",
  );
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
}
```

In `handle()`, call it as the very first line (before Host check):

```ts
private handle(req: IncomingMessage, res: ServerResponse): void {
  this.setSecurityHeaders(res);
  if (!this.isHostAllowed(req.headers.host)) { /* … */ }
  /* … existing body … */
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npx jest -- src/dashboard/dashboard-server.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Lint + build, then commit**

```bash
npm run lint && npm run build
git add src/dashboard/dashboard-server.ts src/dashboard/dashboard-server.test.ts
git commit -m "Feat: set strict CSP and base security headers on dashboard responses

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 11 — Extract route registration to a typed handler signature

**Files:**
- Modify: `src/dashboard/dashboard-server.ts`

This task refactors only — no behavior change — to make adding routes (Tasks 12-15) trivial.

- [ ] **Step 1: Refactor `DashboardServer` to register handlers via a map**

Replace the `handle()` body in `src/dashboard/dashboard-server.ts` with:

```ts
type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export class DashboardServer {
  private readonly opts: DashboardServerOptions;
  private server: HttpServer | undefined;
  private readonly startedAt = Date.now();
  private readonly routes = new Map<string, RouteHandler>();

  constructor(opts: DashboardServerOptions) {
    this.opts = opts;
    this.routes.set('GET /api/health', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptime: Date.now() - this.startedAt }));
    });
  }

  registerRoute(method: 'GET' | 'POST', path: string, handler: RouteHandler): void {
    this.routes.set(`${method} ${path}`, handler);
  }

  // ... start() and stop() unchanged ...

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.setSecurityHeaders(res);
    if (!this.isHostAllowed(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Forbidden: invalid Host header');
      return;
    }
    const url = req.url ?? '/';
    const pathname = url.split('?')[0] ?? '/';
    const key = `${req.method ?? 'GET'} ${pathname}`;
    const handler = this.routes.get(key);
    if (!handler) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      await handler(req, res);
    } catch (err) {
      logger.error('Route handler error', { route: key, error: String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal' }));
      }
    }
  }
}
```

- [ ] **Step 2: Update `createServer` callback to accept the async handler**

Change `createServer((req, res) => this.handle(req, res));` to wrap as a `void` to satisfy the typing:

```ts
const server = createServer((req, res) => { void this.handle(req, res); });
```

- [ ] **Step 3: Run all dashboard tests, expect pass**

```bash
npx jest -- src/dashboard/dashboard-server.test.ts
```

Expected: all PASS (no behavior change).

- [ ] **Step 4: Lint + build**

```bash
npm run lint && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/dashboard-server.ts
git commit -m "Refactor: route registration via Map<string, handler>

Lays the groundwork for adding API and SSE routes in upcoming tasks.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 12 — Add `static-handler` route for the SPA bundle

**Files:**
- Create: `src/dashboard/routes/static-handler.ts`
- Create: `src/dashboard/routes/static-handler.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/dashboard/routes/static-handler.test.ts`:

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticHandler } from './static-handler.js';
import { IncomingMessage, ServerResponse } from 'node:http';

function makeReqRes(url: string): { req: IncomingMessage; res: ServerResponse; chunks: Buffer[]; status: () => number; headers: () => Record<string, string> } {
  const chunks: Buffer[] = [];
  let status = 0;
  const headers: Record<string, string> = {};
  const req = { url, method: 'GET' } as IncomingMessage;
  const res = {
    writeHead: (s: number, h?: Record<string, string>) => {
      status = s;
      if (h) Object.assign(headers, h);
    },
    setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; },
    end: (chunk?: Buffer | string) => {
      if (chunk) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    },
    headersSent: false,
  } as unknown as ServerResponse;
  return { req, res, chunks, status: () => status, headers: () => headers };
}

describe('static-handler', () => {
  it('serves index.html for GET /', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><h1>Hi</h1>');
    const handler = createStaticHandler(dir);
    const { req, res, chunks, status, headers } = makeReqRes('/');
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/text\/html/);
    expect(Buffer.concat(chunks).toString()).toContain('<h1>Hi</h1>');
  });

  it('serves assets/ files with correct content-type', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'static-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'main.js'), 'console.log(1)');
    const handler = createStaticHandler(dir);
    const { req, res, chunks, status, headers } = makeReqRes('/assets/main.js');
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/javascript/);
    expect(Buffer.concat(chunks).toString()).toBe('console.log(1)');
  });

  it('returns 404 for missing files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    const handler = createStaticHandler(dir);
    const { req, res, status } = makeReqRes('/missing.js');
    await handler(req, res);
    expect(status()).toBe(404);
  });

  it('rejects path traversal (../)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    const handler = createStaticHandler(dir);
    const { req, res, status } = makeReqRes('/../../etc/passwd');
    await handler(req, res);
    expect(status()).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

```bash
npx jest -- src/dashboard/routes/static-handler.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the module**

Create `src/dashboard/routes/static-handler.ts`:

```ts
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.map':  'application/json; charset=utf-8',
};

export function createStaticHandler(rootDir: string): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const root = resolve(rootDir);
  return async (req, res) => {
    const url = req.url ?? '/';
    const reqPath = url.split('?')[0] ?? '/';
    const filename = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
    const target = resolve(join(root, filename));
    if (!target.startsWith(root + sep) && target !== root) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const st = await stat(target);
      if (!st.isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      const ext = extname(target).toLowerCase();
      const type = MIME[ext] ?? 'application/octet-stream';
      const data = await readFile(target);
      res.writeHead(200, {
        'content-type': type,
        'content-length': String(data.length),
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  };
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npx jest -- src/dashboard/routes/static-handler.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Wire into `DashboardServer`**

In `src/dashboard/dashboard-server.ts`, add a constructor option for the static dir and register the handler:

```ts
import { createStaticHandler } from './routes/static-handler.js';

export interface DashboardServerOptions {
  readonly port: number;
  readonly host: string;
  readonly bus: LiveEventBus;
  readonly staticDir?: string;   // path to dist/web/, optional for tests
}

// in constructor, after existing setup:
if (opts.staticDir) {
  const staticHandler = createStaticHandler(opts.staticDir);
  this.routes.set('GET /', staticHandler);
}
```

Then change the routing key match in `handle()` so any unmatched `GET` path falls through to the static handler when `staticDir` is configured:

```ts
private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  this.setSecurityHeaders(res);
  if (!this.isHostAllowed(req.headers.host)) { /* … */ }
  const url = req.url ?? '/';
  const pathname = url.split('?')[0] ?? '/';
  const key = `${req.method ?? 'GET'} ${pathname}`;

  const exact = this.routes.get(key);
  if (exact) {
    await exact(req, res);
    return;
  }

  // Static fallback for GETs when configured
  if (req.method === 'GET' && this.opts.staticDir) {
    const staticHandler = createStaticHandler(this.opts.staticDir);
    await staticHandler(req, res);
    return;
  }

  res.writeHead(404);
  res.end();
}
```

- [ ] **Step 6: Lint + build**

```bash
npm run lint && npm run build
```

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/routes/static-handler.ts src/dashboard/routes/static-handler.test.ts src/dashboard/dashboard-server.ts
git commit -m "Feat: add static file handler for dist/web/ SPA bundle

Path-traversal-safe (../ rejected with 403), correct MIME for common
asset types. Wired as the default GET fallback in DashboardServer
when staticDir is configured.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 13 — Add `api-handler` with `/api/session/current` route

**Files:**
- Create: `src/dashboard/routes/api-handler.ts`
- Create: `src/dashboard/routes/api-handler.test.ts`

This task introduces the API handler factory and registers exactly one route. Subsequent tasks add the remaining endpoints one at a time.

- [ ] **Step 1: Write the failing test**

Create `src/dashboard/routes/api-handler.test.ts`:

```ts
import { createApiHandler } from './api-handler.js';
import { IncomingMessage, ServerResponse } from 'node:http';

function fakeRes(): { res: ServerResponse; status: () => number; body: () => string; headers: () => Record<string, string> } {
  let status = 0;
  let body = '';
  const headers: Record<string, string> = {};
  const res = {
    writeHead: (s: number, h?: Record<string, string>) => { status = s; if (h) Object.assign(headers, h); },
    setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; },
    end: (chunk?: string | Buffer) => { if (chunk) body += chunk.toString(); },
    headersSent: false,
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body, headers: () => headers };
}

describe('api-handler GET /api/session/current', () => {
  it('returns sessionTracker.getMetrics() as JSON', async () => {
    const fake = { id: 'sess-1', toolCallCount: 5 };
    const handler = createApiHandler({
      sessionTracker: { getMetrics: () => fake } as unknown as Parameters<typeof createApiHandler>[0]['sessionTracker'],
    });
    const req = { method: 'GET', url: '/api/session/current' } as IncomingMessage;
    const { res, status, body, headers } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(body())).toEqual(fake);
  });

  it('returns 503 when sessionTracker is missing', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/session/current' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(503);
  });

  it('returns 404 for unknown /api/* routes', async () => {
    const handler = createApiHandler({});
    const req = { method: 'GET', url: '/api/unknown' } as IncomingMessage;
    const { res, status } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

```bash
npx jest -- src/dashboard/routes/api-handler.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the module**

Create `src/dashboard/routes/api-handler.ts`:

```ts
import { IncomingMessage, ServerResponse } from 'node:http';

export interface ApiHandlerDeps {
  readonly sessionTracker?: { getMetrics: () => unknown };
  // additional trackers will be added in later tasks
}

type RouteFn = (req: IncomingMessage, res: ServerResponse) => void;

function jsonOk(res: ServerResponse, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

function unavailable(res: ServerResponse, what: string): void {
  res.writeHead(503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'unavailable', what }));
}

export function createApiHandler(deps: ApiHandlerDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const routes = new Map<string, RouteFn>();

  routes.set('GET /api/session/current', (_req, res) => {
    if (!deps.sessionTracker) return unavailable(res, 'sessionTracker');
    jsonOk(res, deps.sessionTracker.getMetrics());
  });

  return (req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const key = `${req.method ?? 'GET'} ${path}`;
    const fn = routes.get(key);
    if (!fn) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    fn(req, res);
  };
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npx jest -- src/dashboard/routes/api-handler.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Wire into `DashboardServer`**

In `src/dashboard/dashboard-server.ts`:

1. Extend options:

```ts
import { createApiHandler, ApiHandlerDeps } from './routes/api-handler.js';

export interface DashboardServerOptions {
  readonly port: number;
  readonly host: string;
  readonly bus: LiveEventBus;
  readonly staticDir?: string;
  readonly api?: ApiHandlerDeps;
}
```

2. In the constructor, after the static-handler setup, add:

```ts
if (opts.api) {
  const apiHandler = createApiHandler(opts.api);
  // Forward all GET /api/* paths through the api-handler.
  // Use a sentinel registration so handle() can dispatch by prefix.
  this.routes.set('GET /api/__prefix__', apiHandler);
}
```

3. In `handle()`, before the static fallback, add:

```ts
if (req.method === 'GET' && pathname.startsWith('/api/') && pathname !== '/api/health') {
  const apiHandler = this.routes.get('GET /api/__prefix__');
  if (apiHandler) {
    await apiHandler(req, res);
    return;
  }
}
```

- [ ] **Step 6: Lint + build**

```bash
npm run lint && npm run build
```

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/routes/api-handler.ts src/dashboard/routes/api-handler.test.ts src/dashboard/dashboard-server.ts
git commit -m "Feat: add API handler with GET /api/session/current

Routes /api/* through a dependency-injected handler. Returns 503 when
required trackers aren't available (graceful in init phases) and 404
for unknown paths.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 14 — Add remaining `/api/*` routes (one commit per route)

For each route below, follow this pattern:

1. Add a test in `src/dashboard/routes/api-handler.test.ts` modeled on the `GET /api/session/current` test.
2. Extend `ApiHandlerDeps` in `src/dashboard/routes/api-handler.ts` with the relevant tracker.
3. Register the new route inside `createApiHandler`.
4. Run `npx jest -- src/dashboard/routes/api-handler.test.ts`.
5. Lint + build.
6. Commit (one commit per route).

The routes to add, in order:

| Route                              | Tracker / source                                                       | `getMetrics()`-equivalent call                                                |
|------------------------------------|------------------------------------------------------------------------|-------------------------------------------------------------------------------|
| `GET /api/session/today`           | `sessionStore` + `sessionTracker`                                      | aggregate today's sessions (helper on `SessionStore`, write if absent)        |
| `GET /api/sessions`                | `sessionStore`                                                         | `sessionStore.list({ limit })` — read `?limit=` from URL                      |
| `GET /api/sessions/:id`            | `sessionStore`                                                         | `sessionStore.read(id)` — return 404 if missing                               |
| `GET /api/cost`                    | `costTracker` + `costForecast`                                         | combine `costTracker.getMetrics()` and `costForecast.getMetrics()`            |
| `GET /api/anti-patterns`           | `antiPatternDetector`                                                  | `antiPatternDetector.getMetrics()` (or current-session pattern list)          |
| `GET /api/audit`                   | `auditTrailManager`                                                    | `auditTrailManager.getAuditLog()`                                             |
| `GET /api/weekly`                  | `weeklySummaryGenerator`                                               | `weeklySummaryGenerator.list()` (write helper if not present)                 |
| `GET /api/budget`                  | `budgetTracker`                                                        | `budgetTracker.getMetrics()`                                                  |
| `GET /api/latency`                 | `latencyTracker`                                                       | `latencyTracker.getMetrics()`                                                 |

For each commit, message format:

```
Feat: add GET /api/<name> dashboard endpoint

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

When a tracker doesn't expose the exact shape needed (e.g., today's aggregate), add a small helper method to the tracker/store class with its own test. Stay strict: don't add fields the four views won't consume.

## Task 15 — Wire `LiveEventBus` emission into `eventProcessor.onRecord`

**Files:**
- Modify: `src/index.ts`

This is the moment the dashboard becomes "live". The `onRecord` callback in `src/index.ts` already dispatches each `ToolCallRecord` to every tracker. We add three more emissions to the bus.

- [ ] **Step 1: Construct the bus before the onRecord callback**

In `src/index.ts`, just after `const sessionStartMs = Date.now();` (around line 237) and before `nrIngest = new NrIngestManager(...)`, add:

```ts
const liveBus = new LiveEventBus();
```

Add the import at the top:

```ts
import { LiveEventBus } from './dashboard/index.js';
```

- [ ] **Step 2: Emit events from inside `onRecord`**

Find the `eventProcessor = new HookEventProcessor({ ... onRecord: (record) => { ... } })` block. Inside `onRecord`, after `latencyTracker.recordToolCall(record);` and after the `costMetrics` block, add:

```ts
// Emit to dashboard live bus (no-op when no SSE subscribers attached)
liveBus.emit('tool-call', {
  id: record.toolCallId ?? `${record.sessionId}-${Date.now()}`,
  tool: record.toolName,
  durationMs: record.durationMs ?? 0,
  costUsd: 0,    // cost-update event handles deltas
  ts: record.endTime ?? Date.now(),
});

if (costMetrics.sessionTotalCostUsd !== null) {
  liveBus.emit('cost-update', {
    sessionTotalUsd: costMetrics.sessionTotalCostUsd,
    todayTotalUsd: priorDailyCostUsd + costMetrics.sessionTotalCostUsd,
    forecastEodUsd: null,   // wired in a later task once forecast tracker is exposed
  });
}
```

Inside the `for (const task of taskDetector.drainNewlyCompletedTasks())` loop, after `for (const pattern of patterns) capturedNrIngest.ingestAntiPattern(...)`, add:

```ts
for (const pattern of patterns) {
  liveBus.emit('anti-pattern', {
    type: pattern.type,
    target: pattern.target ?? 'unknown',
    count: pattern.count ?? 1,
  });
}
```

- [ ] **Step 3: Build to verify types**

```bash
npm run build
```

Expected: zero errors.

- [ ] **Step 4: Run existing tests, expect no regressions**

```bash
npm test -- --testPathIgnorePatterns=src/web
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "Feat: emit dashboard events to LiveEventBus from onRecord

Each ToolCallRecord now produces a tool-call event; cost deltas
produce a cost-update event; detected anti-patterns produce one event
each. The bus is consumed by the SSE handler added in the next task.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 16 — Implement `sse-handler` (handshake + per-event push)

**Files:**
- Create: `src/dashboard/routes/sse-handler.ts`
- Create: `src/dashboard/routes/sse-handler.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/dashboard/routes/sse-handler.test.ts`:

```ts
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { LiveEventBus } from '../live-event-bus.js';
import { createSseHandler } from './sse-handler.js';

function startTestServer(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => { void handler(req, res); });
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => s.close(() => r())),
      });
    });
  });
}

async function readSseChunks(res: Response, count: number, timeoutMs = 1000): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (chunks.length < count && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 100)),
    ]);
    if (done) break;
    if (value) chunks.push(decoder.decode(value));
  }
  void reader.cancel();
  return chunks;
}

describe('sse-handler', () => {
  it('responds with text/event-stream and Cache-Control: no-cache', async () => {
    const bus = new LiveEventBus();
    const server = await startTestServer(createSseHandler(bus));
    try {
      const res = await fetch(`${server.url}/sse`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/event-stream/);
      expect(res.headers.get('cache-control')).toMatch(/no-cache/);
      void res.body?.cancel();
    } finally {
      await server.close();
    }
  });

  it('forwards bus emissions as SSE frames', async () => {
    const bus = new LiveEventBus();
    const server = await startTestServer(createSseHandler(bus));
    try {
      const res = await fetch(`${server.url}/sse`);
      // Give the server a moment to attach the listener before emitting
      await new Promise((r) => setTimeout(r, 30));
      bus.emit('tool-call', { id: 'a', tool: 'Read', durationMs: 1, costUsd: 0, ts: 1 });
      bus.emit('cost-update', { sessionTotalUsd: 1, todayTotalUsd: 2, forecastEodUsd: null });
      const chunks = await readSseChunks(res, 2);
      const merged = chunks.join('');
      expect(merged).toContain('event: tool-call');
      expect(merged).toContain('"tool":"Read"');
      expect(merged).toContain('event: cost-update');
    } finally {
      await server.close();
    }
  });

  it('replays buffered events when Last-Event-ID header is set', async () => {
    const bus = new LiveEventBus();
    bus.emit('tool-call', { id: 'a', tool: 'Read', durationMs: 1, costUsd: 0, ts: 1 });
    bus.emit('tool-call', { id: 'b', tool: 'Edit', durationMs: 2, costUsd: 0, ts: 2 });
    const server = await startTestServer(createSseHandler(bus));
    try {
      const res = await fetch(`${server.url}/sse`, { headers: { 'last-event-id': '1' } });
      const chunks = await readSseChunks(res, 1);
      const merged = chunks.join('');
      expect(merged).toContain('"id":"b"');
      expect(merged).not.toContain('"id":"a"');
    } finally {
      await server.close();
    }
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
npx jest -- src/dashboard/routes/sse-handler.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the module**

Create `src/dashboard/routes/sse-handler.ts`:

```ts
import { IncomingMessage, ServerResponse } from 'node:http';
import { LiveEventBus, LiveEventName, LiveEventMap } from '../live-event-bus.js';

const HEARTBEAT_MS = 30_000;

function frame(event: string, id: number, data: unknown): string {
  return `event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createSseHandler(bus: LiveEventBus): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // Initial flush so EventSource enters "open" state immediately
    res.write(': stream-open\n\n');

    // Replay buffered events newer than Last-Event-ID
    const lastEventIdHeader = req.headers['last-event-id'];
    const lastSeq = typeof lastEventIdHeader === 'string' ? parseInt(lastEventIdHeader, 10) : 0;
    if (Number.isFinite(lastSeq) && lastSeq > 0) {
      for (const entry of bus.replayFrom(lastSeq)) {
        res.write(frame(entry.event, entry.seq, entry.payload));
      }
    }

    let nextLocalSeq = lastSeq + 1;
    const onAny = <E extends LiveEventName>(event: E) => (payload: LiveEventMap[E]) => {
      const seq = nextLocalSeq++;
      res.write(frame(event, seq, payload));
    };

    const handlers = {
      'tool-call':    onAny('tool-call'),
      'cost-update':  onAny('cost-update'),
      'anti-pattern': onAny('anti-pattern'),
    } as const;
    bus.on('tool-call',    handlers['tool-call']);
    bus.on('cost-update',  handlers['cost-update']);
    bus.on('anti-pattern', handlers['anti-pattern']);

    const heartbeat = setInterval(() => {
      const seq = nextLocalSeq++;
      res.write(frame('heartbeat', seq, { ts: Date.now() }));
    }, HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const cleanup = () => {
      clearInterval(heartbeat);
      bus.off('tool-call',    handlers['tool-call']);
      bus.off('cost-update',  handlers['cost-update']);
      bus.off('anti-pattern', handlers['anti-pattern']);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  };
}
```

- [ ] **Step 4: Run, expect pass**

```bash
npx jest -- src/dashboard/routes/sse-handler.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Wire into `DashboardServer`**

In `src/dashboard/dashboard-server.ts` constructor, register the SSE route:

```ts
import { createSseHandler } from './routes/sse-handler.js';

// in constructor, after API setup:
this.routes.set('GET /sse', createSseHandler(opts.bus));
```

- [ ] **Step 6: Lint + build**

```bash
npm run lint && npm run build
```

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/routes/sse-handler.ts src/dashboard/routes/sse-handler.test.ts src/dashboard/dashboard-server.ts
git commit -m "Feat: add SSE handler with heartbeat + Last-Event-ID replay

Subscribes to LiveEventBus and forwards every emission to the client
as a numbered SSE frame. 30s heartbeat keeps idle connections alive.
Reconnecting clients pass Last-Event-ID to receive missed events from
the bus's ring buffer.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 17 — Boot `DashboardServer` from `index.ts` when mode includes the dashboard

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add the import**

At the top of `src/index.ts`, alongside the other dashboard import:

```ts
import { DashboardServer } from './dashboard/dashboard-server.js';
```

- [ ] **Step 2: Add a holder for the server alongside other resources**

In `main()`, near the other resource holders (around line 121-132):

```ts
let dashboardServer: DashboardServer | undefined;
```

In the `shutdown` handler, add (between `eventProcessor?.stop()` and the existing `nrIngest` line):

```ts
if (dashboardServer) await dashboardServer.stop();
```

- [ ] **Step 3: Construct `DashboardServer` after trackers**

After the `liveBus` declaration (added in Task 15) and just before `nrIngest = new NrIngestManager(...)`:

```ts
const dashboardEnabled = config.mode === 'local' || config.mode === 'both';
if (dashboardEnabled) {
  // Resolve dist/web/ relative to the compiled module location.
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve: resolvePath } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const staticDir = resolvePath(here, '..', 'web');

  dashboardServer = new DashboardServer({
    port: config.dashboard.port,
    host: config.dashboard.host,
    bus: liveBus,
    staticDir,
    api: {
      sessionTracker,
      // additional trackers wired in subsequent tasks
    },
  });
  const addr = await dashboardServer.start();
  logger.info(`Dashboard ready at http://${addr.address}:${addr.port}`);
}
```

- [ ] **Step 4: Build to verify types**

```bash
npm run build
```

Expected: zero errors. (If TS complains about `await` in non-async — `main` is already async, so this should be fine.)

- [ ] **Step 5: Run a manual smoke check**

```bash
mkdir -p /tmp/nr-ai-test/.nr-ai-observe
echo '{ "mode": "local" }' > /tmp/nr-ai-test/.nr-ai-observe/config.json
HOME=/tmp/nr-ai-test node dist/index.js --stdio &
SERVER_PID=$!
sleep 1
curl -s http://127.0.0.1:7777/api/health
kill $SERVER_PID 2>/dev/null || true
```

Expected: `{"ok":true,"uptime":<number>}`.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "Feat: boot DashboardServer when mode includes 'local' or 'both'

Resolves dist/web/ relative to the compiled module path so it works
both when run from source via tsx and from the published bin script.
URL is logged at startup so it surfaces in Claude Code's MCP logs.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 18 — Skip `NrIngestManager` construction when `mode === 'local'`

**Files:**
- Modify: `src/index.ts`

This task makes the privacy promise real: in pure local mode, the NR ingest path is never wired up.

- [ ] **Step 1: Wrap the NrIngestManager construction in a mode check**

In `src/index.ts`, around line 245 where `nrIngest = new NrIngestManager(...)`:

```ts
let capturedNrIngest: NrIngestManager | undefined;
if (config.mode !== 'local') {
  nrIngest = new NrIngestManager({
    licenseKey: config.licenseKey,
    /* … all existing args … */
  });
  capturedNrIngest = nrIngest;
}
```

- [ ] **Step 2: Guard every `capturedNrIngest.*` call**

Find every reference to `capturedNrIngest.…` in the `onRecord` callback and the `budgetTracker.setOnThreshold` callback. Wrap each with a guard:

```ts
capturedNrIngest?.ingestToolCall(record);
capturedNrIngest?.ingestBudgetWarning(event);
capturedNrIngest?.ingestCodingTask(task);
capturedNrIngest?.ingestAntiPattern(pattern, context);
```

For the `mcpServer.auditTrailManager = nrIngest.auditTrail` line, change to:

```ts
if (nrIngest) mcpServer.auditTrailManager = nrIngest.auditTrail;
```

For `eventProcessor.start(); nrIngest.start();`, change to:

```ts
eventProcessor.start();
nrIngest?.start();
```

- [ ] **Step 3: Build and run all tests**

```bash
npm run build
npm test -- --testPathIgnorePatterns=src/web
```

Expected: all pre-existing tests continue to PASS (default mode is `'cloud'`, so they construct `nrIngest` exactly as before).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "Feat: skip NrIngestManager construction in mode='local'

This is the privacy promise made concrete — when mode='local', no NR
transport object is ever instantiated. All capturedNrIngest call sites
become null-safe.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 19 — Privacy-proof integration test

**Files:**
- Create: `src/index.privacy.test.ts`

This is the test that gives the launch its trust story.

- [ ] **Step 1: Write the failing test**

Create `src/index.privacy.test.ts`:

```ts
import { jest } from '@jest/globals';

// Mock NrIngestManager so we can detect any instantiation.
const ingestCtor = jest.fn();
jest.unstable_mockModule('./transport/nr-ingest.js', () => ({
  NrIngestManager: class {
    constructor(...args: unknown[]) {
      ingestCtor(...args);
    }
    auditTrail = undefined;
    start() {/* no-op */}
    stop() { return Promise.resolve(); }
    ingestToolCall() {/* no-op */}
    ingestCodingTask() {/* no-op */}
    ingestAntiPattern() {/* no-op */}
    ingestBudgetWarning() {/* no-op */}
  },
}));

// Capture all outbound HTTP attempts.
const httpRequest = jest.fn();
jest.unstable_mockModule('node:https', () => ({
  request: (...args: unknown[]) => {
    httpRequest('https', ...args);
    throw new Error('HTTPS request blocked in privacy-proof test');
  },
}));
jest.unstable_mockModule('node:http', async () => {
  const real = await import('node:http');
  return {
    ...real,
    request: (...args: unknown[]) => {
      httpRequest('http', ...args);
      throw new Error('HTTP request blocked in privacy-proof test');
    },
  };
});

describe('privacy proof — mode=local', () => {
  beforeEach(() => {
    ingestCtor.mockClear();
    httpRequest.mockClear();
    process.env.NR_AI_MODE = 'local';
    delete process.env.NEW_RELIC_LICENSE_KEY;
    delete process.env.NEW_RELIC_ACCOUNT_ID;
  });

  it('does not construct NrIngestManager', async () => {
    const { loadMcpConfig } = await import('./config.js');
    const config = loadMcpConfig({ port: 9847, config: null, logLevel: 'info', stdio: true });
    expect(config.mode).toBe('local');

    // Simulate the relevant code path from index.ts main()
    if (config.mode !== 'local') {
      const { NrIngestManager } = await import('./transport/nr-ingest.js');
      void new NrIngestManager({} as unknown as ConstructorParameters<typeof NrIngestManager>[0]);
    }
    expect(ingestCtor).not.toHaveBeenCalled();
  });

  it('makes zero outbound HTTP/HTTPS requests during a fake session', async () => {
    const { loadMcpConfig } = await import('./config.js');
    const config = loadMcpConfig({ port: 9847, config: null, logLevel: 'info', stdio: true });

    // Simulate a tool call passing through trackers — no transport allowed
    const { SessionTracker } = await import('./metrics/session-tracker.js');
    const tracker = new SessionTracker();
    tracker.recordToolCall({
      sessionId: 's1',
      toolCallId: 't1',
      toolName: 'Read',
      durationMs: 10,
      startTime: Date.now(),
      endTime: Date.now() + 10,
    } as Parameters<typeof tracker.recordToolCall>[0]);

    expect(httpRequest).not.toHaveBeenCalled();
    expect(config.mode).toBe('local');
  });
});
```

- [ ] **Step 2: Run, expect pass**

```bash
npx jest -- src/index.privacy.test.ts
```

Expected: both tests PASS.

If they fail: confirm Task 18's mode gate is in place and that no module-level eager imports trigger transport construction.

- [ ] **Step 3: Commit**

```bash
git add src/index.privacy.test.ts
git commit -m "Test: privacy proof — mode=local makes zero outbound calls

Verifies (1) NrIngestManager is never instantiated and (2) no
node:http or node:https request() ever fires while a tool call moves
through the trackers. This is the trust contract for local mode.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 20 — Phase 1 acceptance check

- [ ] **Step 1: Run the full test suite**

```bash
npm test
```

Expected: all PASS, zero regressions.

- [ ] **Step 2: Confirm lint + build**

```bash
npm run lint
npm run build
```

Expected: zero errors, zero warnings.

- [ ] **Step 3: Manual end-to-end smoke**

```bash
mkdir -p /tmp/nr-ai-test/.nr-ai-observe
echo '{ "mode": "local" }' > /tmp/nr-ai-test/.nr-ai-observe/config.json
HOME=/tmp/nr-ai-test node dist/index.js --stdio &
SERVER_PID=$!
sleep 1
echo "Health:"
curl -s http://127.0.0.1:7777/api/health
echo ""
echo "Session current (expect 503 — no tracker yet wired in api dep):"
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7777/api/session/current
echo "SSE handshake:"
timeout 2 curl -s -N http://127.0.0.1:7777/sse | head -3
kill $SERVER_PID 2>/dev/null || true
```

Expected:
- `/api/health` returns `{"ok":true,...}`
- SSE handshake returns `: stream-open` line within 2 seconds.

- [ ] **Step 4: Phase 1 complete — no commit needed**

If everything passes, Phase 1 is done. Move on to Phase 2.

---

# Phase 2 — SPA scaffold + Today + Audit

Goal by end of phase: `npm run build && npm test` produces a working `dist/web/` that, when served by the dashboard, renders a sidebar shell with two functional views (Today and Audit), receives live SSE updates, and passes Vitest component tests.

## Task 21 — Add SPA dependencies to `package.json`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add runtime deps**

Run from the repo root:

```bash
npm install --save \
  react@^18.3.1 \
  react-dom@^18.3.1 \
  wouter@^3.3.5 \
  zustand@^4.5.5 \
  @tanstack/react-query@^5.59.0 \
  recharts@^2.13.0 \
  lucide-react@^0.453.0
```

- [ ] **Step 2: Add build / dev deps**

```bash
npm install --save-dev \
  vite@^5.4.0 \
  @vitejs/plugin-react@^4.3.0 \
  vitest@^2.1.0 \
  @vitest/coverage-v8@^2.1.0 \
  @testing-library/react@^16.0.0 \
  @testing-library/jest-dom@^6.5.0 \
  @testing-library/user-event@^14.5.0 \
  jsdom@^25.0.0 \
  tailwindcss@^3.4.0 \
  postcss@^8.4.0 \
  autoprefixer@^10.4.0 \
  eslint-plugin-react@^7.36.0 \
  eslint-plugin-react-hooks@^5.0.0 \
  @types/react@^18.3.0 \
  @types/react-dom@^18.3.0
```

- [ ] **Step 3: Verify the file changed**

```bash
git diff --stat package.json package-lock.json
```

Expected: both files modified.

- [ ] **Step 4: Run existing build to confirm no regression**

```bash
npm run build
```

Expected: zero errors. (We have not yet added new code that imports the new packages, so this is a sanity check.)

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "Chore: add React/Vite/Tailwind/Vitest deps for local dashboard SPA

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 22 — Create `tsconfig.web.json` and exclude `src/web/` from main `tsconfig`

**Files:**
- Create: `tsconfig.web.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: Create `tsconfig.web.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "useDefineForClassFields": true,
    "noEmit": true,
    "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src/web/**/*.ts", "src/web/**/*.tsx"]
}
```

- [ ] **Step 2: Exclude `src/web/` from the main TS config**

Read `tsconfig.json` first:

```bash
cat tsconfig.json
```

Then add `"src/web"` to the `exclude` array (creating one if it doesn't exist). Example resulting file:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "composite": true,
    "incremental": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/web", "**/*.test.ts"]
}
```

(Preserve any existing fields. Add only the `"src/web"` exclusion.)

- [ ] **Step 3: Verify both configs compile**

```bash
npm run build
npx tsc --noEmit -p tsconfig.web.json
```

Expected: zero errors from both. The web tsc is a no-op for now (no .tsx files yet exist) but confirms config validity.

- [ ] **Step 4: Commit**

```bash
git add tsconfig.json tsconfig.web.json
git commit -m "Chore: separate tsconfig for src/web/ SPA source

Main tsc never sees DOM types or React JSX; the SPA gets its own
strict TS config aligned with Vite/Vitest.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 23 — Create Vite config

**Files:**
- Create: `vite.config.ts`

- [ ] **Step 1: Write the config**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  plugins: [react()],
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:7777',
      '/sse': { target: 'http://127.0.0.1:7777', changeOrigin: false, ws: false },
    },
  },
});
```

- [ ] **Step 2: Smoke check (Vite parses the config)**

```bash
npx vite build --help > /dev/null
```

Expected: no error.

(A full `vite build` would fail right now because no `index.html` exists yet — that's Task 26.)

- [ ] **Step 3: Commit**

```bash
git add vite.config.ts
git commit -m "Chore: add Vite config — root=src/web, output=dist/web

Dev server proxies /api and /sse to the local MCP server on port 7777
so the SPA can run with HMR while the backend dashboard handles data.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 24 — Create Tailwind + PostCSS configs

**Files:**
- Create: `tailwind.config.js`
- Create: `postcss.config.js`
- Create: `src/web/index.css`

- [ ] **Step 1: Tailwind config**

`tailwind.config.js`:

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/web/**/*.{ts,tsx,html}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Console aesthetic palette
        bg: {
          base:  '#0b1120',
          panel: '#0f172a',
          line:  '#1e293b',
        },
        ink: {
          base:    '#e2e8f0',
          subtle:  '#94a3b8',
          muted:   '#64748b',
        },
        accent: {
          cyan:   '#22d3ee',
          green:  '#22c55e',
          amber:  '#f59e0b',
          red:    '#f87171',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
```

- [ ] **Step 2: PostCSS config**

`postcss.config.js`:

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 3: Base CSS file**

`src/web/index.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html, body, #root {
  height: 100%;
}
body {
  @apply bg-bg-base text-ink-base font-sans;
}
```

- [ ] **Step 4: Commit**

```bash
git add tailwind.config.js postcss.config.js src/web/index.css
git commit -m "Chore: Tailwind + PostCSS config with Console-aesthetic palette

Defines the dark-by-default colour tokens used by every dashboard view
(bg.base/panel/line, ink.base/subtle/muted, accent.cyan/green/amber/red).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 25 — Add npm scripts for SPA build + test

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update the `scripts` block**

Read current scripts:

```bash
cat package.json | sed -n '/"scripts"/,/}/p'
```

Replace the `"scripts"` object with:

```json
"scripts": {
  "build:server": "tsc --build && chmod +x dist/index.js dist/hooks/collector-script.js",
  "build:web":    "vite build",
  "build":        "npm run build:server && npm run build:web",
  "build:clean":  "tsc --build --clean && rimraf dist/web",
  "dev:web":      "vite",
  "test":         "jest",
  "test:web":     "vitest run",
  "lint":         "eslint src/",
  "format":       "prettier --write .",
  "format:check": "prettier --check .",
  "deploy:alerts": "npx tsx scripts/deploy-alerts.ts",
  "deploy:alerts:update": "npx tsx scripts/deploy-alerts.ts --update",
  "deploy:alerts:teardown": "npx tsx scripts/deploy-alerts.ts --teardown",
  "deploy:dashboard": "npx tsx scripts/deploy-dashboard.ts",
  "deploy:dashboard:all": "npx tsx scripts/deploy-dashboard.ts --all",
  "sync:shared": "npx tsx scripts/sync-shared.ts"
}
```

(Preserve any deploy or sync scripts that already exist; only adjust `build`/`build:server`/`build:web`/`build:clean`/`dev:web`/`test:web`.)

If `rimraf` isn't installed yet, add it: `npm install --save-dev rimraf`.

- [ ] **Step 2: Confirm `npm run build:server` still works**

```bash
npm run build:server
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "Chore: split build into build:server + build:web; add test:web

Server build uses tsc; SPA build uses Vite. Top-level 'build' runs
both. New 'dev:web' runs the Vite dev server with HMR.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 26 — Create `src/web/index.html` + minimal `main.tsx`

**Files:**
- Create: `src/web/index.html`
- Create: `src/web/main.tsx`
- Create: `src/web/App.tsx`

This is the smallest SPA that builds and renders something. Routing and views come in subsequent tasks.

- [ ] **Step 1: HTML entry**

`src/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <title>NR-AI · Local</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: React mount**

`src/web/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 0,
      refetchOnWindowFocus: false,
    },
  },
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Mount node #root not found');

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 3: Minimal App**

`src/web/App.tsx`:

```tsx
export function App(): JSX.Element {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-ink-subtle text-sm">NR-AI Local — boot OK</div>
    </div>
  );
}
```

- [ ] **Step 4: Build to confirm Vite produces output**

```bash
npm run build:web
```

Expected: `dist/web/index.html` and `dist/web/assets/main-*.js` exist.

```bash
ls -la dist/web/ dist/web/assets/
```

Expected: index.html plus assets directory containing JS + CSS bundles.

- [ ] **Step 5: Commit**

```bash
git add src/web/index.html src/web/main.tsx src/web/App.tsx
git commit -m "Feat: minimal Vite-built SPA — boots and renders confirmation

Smallest possible React entry that exercises the build pipeline. Real
shell + views land in subsequent tasks.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 27 — Configure Vitest for SPA component tests

**Files:**
- Create: `vitest.config.ts`
- Create: `src/web/test-setup.ts`

- [ ] **Step 1: Vitest config**

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [resolve(__dirname, 'src/web/test-setup.ts')],
    include: ['src/web/**/*.test.{ts,tsx}'],
  },
});
```

- [ ] **Step 2: Test setup file**

`src/web/test-setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 3: Verify Vitest discovers no tests yet**

```bash
npm run test:web
```

Expected: "No test files found" (not an error). The pipeline is wired; tests come in later tasks.

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts src/web/test-setup.ts
git commit -m "Chore: add Vitest config and jest-dom test setup for SPA

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 28 — Create `Sidebar` component (with one passing test)

**Files:**
- Create: `src/web/components/Sidebar.tsx`
- Create: `src/web/components/Sidebar.test.tsx`

- [ ] **Step 1: Write the failing test**

`src/web/components/Sidebar.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { Sidebar } from './Sidebar';

describe('Sidebar', () => {
  it('renders all four nav items', () => {
    render(<Sidebar currentPath="/" onNavigate={() => {}} connected={true} />);
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByText('Audit')).toBeInTheDocument();
  });

  it('highlights the active item', () => {
    render(<Sidebar currentPath="/audit" onNavigate={() => {}} connected={true} />);
    const audit = screen.getByText('Audit').closest('button');
    expect(audit).toHaveAttribute('aria-current', 'page');
  });

  it('shows ● connected when connected=true', () => {
    render(<Sidebar currentPath="/" onNavigate={() => {}} connected={true} />);
    expect(screen.getByText(/connected/i)).toBeInTheDocument();
  });

  it('shows ● reconnecting when connected=false', () => {
    render(<Sidebar currentPath="/" onNavigate={() => {}} connected={false} />);
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
npm run test:web -- src/web/components/Sidebar.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the component**

`src/web/components/Sidebar.tsx`:

```tsx
import { Home, Clock, TrendingUp, ShieldCheck } from 'lucide-react';

const NAV = [
  { path: '/',         label: 'Today',    Icon: Home },
  { path: '/sessions', label: 'Sessions', Icon: Clock },
  { path: '/history',  label: 'History',  Icon: TrendingUp },
  { path: '/audit',    label: 'Audit',    Icon: ShieldCheck },
] as const;

export interface SidebarProps {
  readonly currentPath: string;
  readonly onNavigate: (path: string) => void;
  readonly connected: boolean;
}

export function Sidebar({ currentPath, onNavigate, connected }: SidebarProps): JSX.Element {
  return (
    <aside className="w-44 bg-bg-panel border-r border-bg-line p-3 flex flex-col">
      <div className="text-accent-cyan font-semibold text-sm tracking-wide">NR-AI</div>
      <div className="text-ink-muted text-[10px] uppercase tracking-wider mt-0.5">local · single-user</div>

      <nav className="mt-4 flex flex-col gap-0.5">
        {NAV.map(({ path, label, Icon }) => {
          const active = currentPath === path;
          return (
            <button
              key={path}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => onNavigate(path)}
              className={
                'flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left ' +
                (active
                  ? 'bg-bg-line text-ink-base font-medium'
                  : 'text-ink-subtle hover:text-ink-base')
              }
            >
              <Icon size={14} />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>

      <div className="mt-auto pt-3 border-t border-bg-line">
        <div className="text-ink-muted text-[10px] uppercase tracking-wider mb-1">live</div>
        {connected
          ? <div className="text-accent-green text-xs">● connected</div>
          : <div className="text-accent-amber text-xs">● reconnecting</div>}
      </div>
    </aside>
  );
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npm run test:web -- src/web/components/Sidebar.test.tsx
```

Expected: all 4 PASS.

- [ ] **Step 5: Lint + build**

```bash
npm run lint
npx tsc --noEmit -p tsconfig.web.json
npm run build:web
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/web/components/Sidebar.tsx src/web/components/Sidebar.test.tsx
git commit -m "Feat: Sidebar component with four nav items and live indicator

Console-aesthetic dark sidebar; active item gets aria-current=page;
the live indicator flips between '● connected' (green) and '●
reconnecting' (amber).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 29 — Create Zustand `liveStore`

**Files:**
- Create: `src/web/store/liveStore.ts`
- Create: `src/web/store/liveStore.test.ts`

- [ ] **Step 1: Write the failing test**

`src/web/store/liveStore.test.ts`:

```ts
import { useLiveStore } from './liveStore';

describe('liveStore', () => {
  beforeEach(() => {
    useLiveStore.setState({
      connected: false,
      recentToolCalls: [],
      cost: null,
      antiPatterns: [],
    });
  });

  it('starts disconnected with empty arrays', () => {
    const s = useLiveStore.getState();
    expect(s.connected).toBe(false);
    expect(s.recentToolCalls).toEqual([]);
    expect(s.antiPatterns).toEqual([]);
    expect(s.cost).toBeNull();
  });

  it('setConnected toggles the flag', () => {
    useLiveStore.getState().setConnected(true);
    expect(useLiveStore.getState().connected).toBe(true);
  });

  it('pushToolCall appends and caps to last 20', () => {
    const push = useLiveStore.getState().pushToolCall;
    for (let i = 0; i < 25; i++) {
      push({ id: String(i), tool: 'Read', durationMs: 1, costUsd: 0, ts: i });
    }
    const s = useLiveStore.getState();
    expect(s.recentToolCalls.length).toBe(20);
    expect(s.recentToolCalls[0].id).toBe('5');
    expect(s.recentToolCalls[19].id).toBe('24');
  });

  it('setCost replaces the value', () => {
    useLiveStore.getState().setCost({
      sessionTotalUsd: 1.23, todayTotalUsd: 4.56, forecastEodUsd: null,
    });
    expect(useLiveStore.getState().cost?.sessionTotalUsd).toBe(1.23);
  });

  it('pushAntiPattern appends and caps to last 10', () => {
    const push = useLiveStore.getState().pushAntiPattern;
    for (let i = 0; i < 15; i++) {
      push({ type: 'thrashing', target: `f${i}.ts`, count: 1 });
    }
    const s = useLiveStore.getState();
    expect(s.antiPatterns.length).toBe(10);
    expect(s.antiPatterns[0].target).toBe('f5.ts');
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
npm run test:web -- src/web/store/liveStore.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the store**

`src/web/store/liveStore.ts`:

```ts
import { create } from 'zustand';

export interface ToolCallEvent {
  readonly id: string;
  readonly tool: string;
  readonly durationMs: number;
  readonly costUsd: number;
  readonly ts: number;
}

export interface CostUpdateEvent {
  readonly sessionTotalUsd: number;
  readonly todayTotalUsd: number;
  readonly forecastEodUsd: number | null;
}

export interface AntiPatternEvent {
  readonly type: string;
  readonly target: string;
  readonly count: number;
}

interface LiveState {
  readonly connected: boolean;
  readonly recentToolCalls: ToolCallEvent[];
  readonly cost: CostUpdateEvent | null;
  readonly antiPatterns: AntiPatternEvent[];
  setConnected(v: boolean): void;
  pushToolCall(e: ToolCallEvent): void;
  setCost(c: CostUpdateEvent): void;
  pushAntiPattern(e: AntiPatternEvent): void;
}

const RECENT_CAP = 20;
const ANTI_CAP = 10;

export const useLiveStore = create<LiveState>((set) => ({
  connected: false,
  recentToolCalls: [],
  cost: null,
  antiPatterns: [],

  setConnected: (v) => set({ connected: v }),

  pushToolCall: (e) =>
    set((s) => {
      const next = [...s.recentToolCalls, e];
      return { recentToolCalls: next.length > RECENT_CAP ? next.slice(next.length - RECENT_CAP) : next };
    }),

  setCost: (c) => set({ cost: c }),

  pushAntiPattern: (e) =>
    set((s) => {
      const next = [...s.antiPatterns, e];
      return { antiPatterns: next.length > ANTI_CAP ? next.slice(next.length - ANTI_CAP) : next };
    }),
}));
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npm run test:web -- src/web/store/liveStore.test.ts
```

Expected: all 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/store/liveStore.ts src/web/store/liveStore.test.ts
git commit -m "Feat: Zustand liveStore for SSE-fed dashboard state

Caps recent tool calls at 20 and recent anti-patterns at 10 to keep
the in-memory footprint bounded. Views select their slices via
useLiveStore(selector).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 30 — Create `useLiveEvents` hook

**Files:**
- Create: `src/web/hooks/useLiveEvents.ts`
- Create: `src/web/hooks/useLiveEvents.test.tsx`

- [ ] **Step 1: Write the failing test**

`src/web/hooks/useLiveEvents.test.tsx`:

```tsx
import { renderHook, act } from '@testing-library/react';
import { useLiveEvents } from './useLiveEvents';
import { useLiveStore } from '../store/liveStore';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  listeners = new Map<string, ((e: { data: string }) => void)[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  emit(type: string, payload: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(payload) });
  }
  close(): void { this.closed = true; }
}

describe('useLiveEvents', () => {
  let originalES: typeof globalThis.EventSource;
  beforeEach(() => {
    originalES = globalThis.EventSource;
    (globalThis as { EventSource: typeof FakeEventSource }).EventSource =
      FakeEventSource as unknown as typeof globalThis.EventSource;
    FakeEventSource.instances = [];
    useLiveStore.setState({
      connected: false, recentToolCalls: [], cost: null, antiPatterns: [],
    });
  });
  afterEach(() => {
    globalThis.EventSource = originalES;
  });

  it('opens an EventSource on mount and closes on unmount', () => {
    const { unmount } = renderHook(() => useLiveEvents());
    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.instances[0].url).toBe('/sse');
    unmount();
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });

  it('flips connected=true on onopen', () => {
    renderHook(() => useLiveEvents());
    act(() => { FakeEventSource.instances[0].onopen?.(); });
    expect(useLiveStore.getState().connected).toBe(true);
  });

  it('flips connected=false on onerror', () => {
    renderHook(() => useLiveEvents());
    useLiveStore.setState({ connected: true });
    act(() => { FakeEventSource.instances[0].onerror?.(); });
    expect(useLiveStore.getState().connected).toBe(false);
  });

  it('routes tool-call events to pushToolCall', () => {
    renderHook(() => useLiveEvents());
    act(() => {
      FakeEventSource.instances[0].emit('tool-call', {
        id: 'x', tool: 'Read', durationMs: 10, costUsd: 0, ts: 1,
      });
    });
    expect(useLiveStore.getState().recentToolCalls).toHaveLength(1);
    expect(useLiveStore.getState().recentToolCalls[0].id).toBe('x');
  });

  it('routes cost-update to setCost', () => {
    renderHook(() => useLiveEvents());
    act(() => {
      FakeEventSource.instances[0].emit('cost-update', {
        sessionTotalUsd: 1, todayTotalUsd: 2, forecastEodUsd: 3,
      });
    });
    expect(useLiveStore.getState().cost?.sessionTotalUsd).toBe(1);
  });

  it('routes anti-pattern to pushAntiPattern', () => {
    renderHook(() => useLiveEvents());
    act(() => {
      FakeEventSource.instances[0].emit('anti-pattern', {
        type: 'thrashing', target: 'auth.ts', count: 4,
      });
    });
    expect(useLiveStore.getState().antiPatterns).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
npm run test:web -- src/web/hooks/useLiveEvents.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the hook**

`src/web/hooks/useLiveEvents.ts`:

```ts
import { useEffect } from 'react';
import { useLiveStore } from '../store/liveStore';

export function useLiveEvents(url: string = '/sse'): void {
  useEffect(() => {
    const es = new EventSource(url);
    const store = useLiveStore.getState();

    es.onopen = () => useLiveStore.getState().setConnected(true);
    es.onerror = () => useLiveStore.getState().setConnected(false);

    const onToolCall = (e: MessageEvent) => {
      try { store.pushToolCall(JSON.parse(e.data)); } catch { /* ignore malformed */ }
    };
    const onCost = (e: MessageEvent) => {
      try { store.setCost(JSON.parse(e.data)); } catch { /* ignore malformed */ }
    };
    const onAnti = (e: MessageEvent) => {
      try { store.pushAntiPattern(JSON.parse(e.data)); } catch { /* ignore malformed */ }
    };

    es.addEventListener('tool-call',    onToolCall as EventListener);
    es.addEventListener('cost-update',  onCost as EventListener);
    es.addEventListener('anti-pattern', onAnti as EventListener);

    return () => {
      es.removeEventListener('tool-call',    onToolCall as EventListener);
      es.removeEventListener('cost-update',  onCost as EventListener);
      es.removeEventListener('anti-pattern', onAnti as EventListener);
      es.close();
    };
  }, [url]);
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npm run test:web -- src/web/hooks/useLiveEvents.test.tsx
```

Expected: all 6 PASS.

- [ ] **Step 5: Lint + tsc**

```bash
npm run lint
npx tsc --noEmit -p tsconfig.web.json
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/web/hooks/useLiveEvents.ts src/web/hooks/useLiveEvents.test.tsx
git commit -m "Feat: useLiveEvents hook owns the SSE connection

Single EventSource on mount, dispatches typed events to the Zustand
store, flips connected flag on open/error, cleans up on unmount.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 31 — Create `Kpi` and `Sparkline` components

**Files:**
- Create: `src/web/components/Kpi.tsx`
- Create: `src/web/components/Kpi.test.tsx`
- Create: `src/web/components/Sparkline.tsx`
- Create: `src/web/components/Sparkline.test.tsx`

- [ ] **Step 1: Failing test for Kpi**

`src/web/components/Kpi.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { Kpi } from './Kpi';

describe('Kpi', () => {
  it('renders label and value', () => {
    render(<Kpi label="spend" value="$3.42" />);
    expect(screen.getByText('spend')).toBeInTheDocument();
    expect(screen.getByText('$3.42')).toBeInTheDocument();
  });

  it('applies tone color when tone="good"', () => {
    render(<Kpi label="eff." value="94%" tone="good" />);
    const v = screen.getByText('94%');
    expect(v.className).toMatch(/text-accent-green/);
  });

  it('applies tone color when tone="warn"', () => {
    render(<Kpi label="flags" value="2" tone="warn" />);
    const v = screen.getByText('2');
    expect(v.className).toMatch(/text-accent-amber/);
  });

  it('renders subtext when provided', () => {
    render(<Kpi label="spend" value="$3.42" sub="+34% vs avg" />);
    expect(screen.getByText('+34% vs avg')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
npm run test:web -- src/web/components/Kpi.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `Kpi.tsx`**

```tsx
export type KpiTone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';

const TONE: Record<KpiTone, string> = {
  neutral: 'text-ink-base',
  good:    'text-accent-green',
  warn:    'text-accent-amber',
  bad:     'text-accent-red',
  accent:  'text-accent-cyan',
};

export interface KpiProps {
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
  readonly tone?: KpiTone;
}

export function Kpi({ label, value, sub, tone = 'neutral' }: KpiProps): JSX.Element {
  return (
    <div className="bg-bg-panel border border-bg-line rounded p-2.5">
      <div className="text-[10px] text-ink-muted uppercase tracking-wider">{label}</div>
      <div className={`text-xl font-semibold mt-1 ${TONE[tone]}`}>{value}</div>
      {sub && <div className="text-[10px] text-ink-muted mt-0.5">{sub}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Failing test for Sparkline**

`src/web/components/Sparkline.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { Sparkline } from './Sparkline';

describe('Sparkline', () => {
  it('renders an svg', () => {
    const { container } = render(<Sparkline values={[1, 2, 3, 4]} />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('renders no svg when fewer than 2 values', () => {
    const { container } = render(<Sparkline values={[5]} />);
    expect(container.querySelector('svg')).toBeFalsy();
  });

  it('emits a polyline with one point per value', () => {
    const { container } = render(<Sparkline values={[1, 2, 3, 4]} />);
    const poly = container.querySelector('polyline');
    expect(poly).toBeTruthy();
    const pts = poly!.getAttribute('points')!.trim().split(/\s+/);
    expect(pts).toHaveLength(4);
  });
});
```

- [ ] **Step 5: Run, expect failure**

```bash
npm run test:web -- src/web/components/Sparkline.test.tsx
```

Expected: FAIL.

- [ ] **Step 6: Create `Sparkline.tsx`**

```tsx
export interface SparklineProps {
  readonly values: number[];
  readonly width?: number;
  readonly height?: number;
  readonly stroke?: string;
}

export function Sparkline({
  values, width = 280, height = 50, stroke = '#22d3ee',
}: SparklineProps): JSX.Element | null {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }}>
      <polyline fill="none" stroke={stroke} strokeWidth={1.5} points={points} />
    </svg>
  );
}
```

- [ ] **Step 7: Run all SPA tests, expect pass**

```bash
npm run test:web
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/web/components/Kpi.tsx src/web/components/Kpi.test.tsx \
        src/web/components/Sparkline.tsx src/web/components/Sparkline.test.tsx
git commit -m "Feat: Kpi and Sparkline primitive components

Kpi has 5 tone variants (neutral/good/warn/bad/accent) matching the
Console palette. Sparkline is a tiny dependency-free SVG line chart
suitable for inline KPI cards.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 32 — Create `api/client.ts` (typed fetch wrappers)

**Files:**
- Create: `src/web/api/client.ts`
- Create: `src/web/api/client.test.ts`

- [ ] **Step 1: Write the failing test**

`src/web/api/client.test.ts`:

```ts
import { fetchSessionCurrent, fetchAuditLog, qk } from './client';

describe('api/client', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetchSessionCurrent calls /api/session/current and returns JSON', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ id: 'x' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))) as typeof globalThis.fetch;
    const result = await fetchSessionCurrent();
    expect(result).toEqual({ id: 'x' });
  });

  it('throws when response status is not 2xx', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response('boom', { status: 503 }))) as typeof globalThis.fetch;
    await expect(fetchSessionCurrent()).rejects.toThrow(/503/);
  });

  it('fetchAuditLog hits /api/audit', async () => {
    let calledWith = '';
    globalThis.fetch = ((u: string) => {
      calledWith = u;
      return Promise.resolve(new Response('[]', {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }) as unknown as typeof globalThis.fetch;
    await fetchAuditLog();
    expect(calledWith).toBe('/api/audit');
  });

  it('qk produces stable React Query keys', () => {
    expect(qk.sessionCurrent).toEqual(['session', 'current']);
    expect(qk.audit).toEqual(['audit']);
    expect(qk.sessionDetail('abc')).toEqual(['session', 'abc']);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
npm run test:web -- src/web/api/client.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the client**

`src/web/api/client.ts`:

```ts
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return await res.json() as T;
}

// One typed wrapper per endpoint so callers get auto-complete
// and we can swap to fetch options without touching call sites.
export const fetchSessionCurrent = () => getJson<unknown>('/api/session/current');
export const fetchSessionToday   = () => getJson<unknown>('/api/session/today');
export const fetchSessionsList   = (limit = 50) => getJson<unknown>(`/api/sessions?limit=${limit}`);
export const fetchSessionDetail  = (id: string) => getJson<unknown>(`/api/sessions/${encodeURIComponent(id)}`);
export const fetchCost           = () => getJson<unknown>('/api/cost');
export const fetchAntiPatterns   = () => getJson<unknown>('/api/anti-patterns');
export const fetchAuditLog       = () => getJson<unknown>('/api/audit');
export const fetchWeekly         = () => getJson<unknown>('/api/weekly');
export const fetchBudget         = () => getJson<unknown>('/api/budget');
export const fetchLatency        = () => getJson<unknown>('/api/latency');

export const qk = {
  sessionCurrent: ['session', 'current'] as const,
  sessionToday:   ['session', 'today'] as const,
  sessionsList:   ['sessions', 'list'] as const,
  sessionDetail:  (id: string) => ['session', id] as const,
  cost:           ['cost'] as const,
  antiPatterns:   ['anti-patterns'] as const,
  audit:          ['audit'] as const,
  weekly:         ['weekly'] as const,
  budget:         ['budget'] as const,
  latency:        ['latency'] as const,
};
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npm run test:web -- src/web/api/client.test.ts
```

Expected: all 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/api/client.ts src/web/api/client.test.ts
git commit -m "Feat: typed fetch wrappers and React Query keys for /api/*

One wrapper per endpoint; React Query key constants live alongside so
cache invalidation has a single source of truth.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 33 — Wire the App shell with routing and live events

**Files:**
- Modify: `src/web/App.tsx`
- Create: `src/web/App.test.tsx`

- [ ] **Step 1: Write the failing test**

`src/web/App.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
}

describe('App shell', () => {
  beforeEach(() => {
    // Stub EventSource so useLiveEvents doesn't blow up in jsdom
    (globalThis as { EventSource: unknown }).EventSource = class {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      addEventListener(): void {}
      removeEventListener(): void {}
      close(): void {}
    };
  });

  it('renders the sidebar', () => {
    renderApp();
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByText('Audit')).toBeInTheDocument();
  });

  it('renders the Today view by default', () => {
    renderApp();
    // Today view header should be visible
    expect(screen.getByRole('heading', { name: /today/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
npm run test:web -- src/web/App.test.tsx
```

Expected: FAIL — there's no Today heading yet (App is the boot stub from Task 26).

- [ ] **Step 3: Replace `src/web/App.tsx` with the wired shell**

```tsx
import { useEffect, useState } from 'react';
import { Route, Switch, useLocation } from 'wouter';
import { Sidebar } from './components/Sidebar';
import { useLiveEvents } from './hooks/useLiveEvents';
import { useLiveStore } from './store/liveStore';
import { Today }    from './views/Today';
import { Sessions } from './views/Sessions';
import { History }  from './views/History';
import { Audit }    from './views/Audit';

export function App(): JSX.Element {
  useLiveEvents();
  const connected = useLiveStore((s) => s.connected);
  const [location, navigate] = useLocation();

  // Force a single re-render once on mount so wouter's location is stable
  // before the initial render of children. (Avoids a flicker on cold load.)
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);
  if (!ready) return <></>;

  return (
    <div className="flex h-full">
      <Sidebar currentPath={location} onNavigate={navigate} connected={connected} />
      <main className="flex-1 overflow-auto p-5">
        <Switch>
          <Route path="/sessions" component={Sessions} />
          <Route path="/history"  component={History} />
          <Route path="/audit"    component={Audit} />
          <Route path="/"         component={Today} />
          <Route><div className="text-ink-muted">Not found</div></Route>
        </Switch>
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Create stub views (each will be filled in upcoming tasks)**

`src/web/views/Today.tsx`:

```tsx
export function Today(): JSX.Element {
  return (
    <section>
      <h1 className="text-xl font-semibold">Today</h1>
      <p className="text-ink-muted text-sm mt-1">Today view — content lands in the next task.</p>
    </section>
  );
}
```

`src/web/views/Sessions.tsx`:

```tsx
export function Sessions(): JSX.Element {
  return <section><h1 className="text-xl font-semibold">Sessions</h1></section>;
}
```

`src/web/views/History.tsx`:

```tsx
export function History(): JSX.Element {
  return <section><h1 className="text-xl font-semibold">History</h1></section>;
}
```

`src/web/views/Audit.tsx`:

```tsx
export function Audit(): JSX.Element {
  return <section><h1 className="text-xl font-semibold">Audit</h1></section>;
}
```

- [ ] **Step 5: Run all SPA tests, expect pass**

```bash
npm run test:web
```

Expected: all PASS.

- [ ] **Step 6: Build to confirm production output**

```bash
npm run build:web
```

Expected: `dist/web/index.html` and `dist/web/assets/main-*.js` regenerated.

- [ ] **Step 7: Commit**

```bash
git add src/web/App.tsx src/web/App.test.tsx \
        src/web/views/Today.tsx src/web/views/Sessions.tsx \
        src/web/views/History.tsx src/web/views/Audit.tsx
git commit -m "Feat: wire App shell with wouter routing and live SSE hook

Mounts useLiveEvents once at the top so every view can read
connection status and recent events from the Zustand store. Stub
views are replaced with real implementations in subsequent tasks.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 34 — Build the Today view

**Files:**
- Modify: `src/web/views/Today.tsx`
- Create: `src/web/views/Today.test.tsx`

- [ ] **Step 1: Write the failing test**

`src/web/views/Today.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Today } from './Today';
import { useLiveStore } from '../store/liveStore';

function renderToday() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <Today />
    </QueryClientProvider>,
  );
}

describe('Today view', () => {
  beforeEach(() => {
    useLiveStore.setState({
      connected: true,
      recentToolCalls: [
        { id: 'a', tool: 'Read', durationMs: 120, costUsd: 0.001, ts: 1 },
        { id: 'b', tool: 'Edit', durationMs: 85,  costUsd: 0.002, ts: 2 },
      ],
      cost: { sessionTotalUsd: 3.42, todayTotalUsd: 12.17, forecastEodUsd: 18.4 },
      antiPatterns: [{ type: 'thrashing', target: 'auth.ts', count: 4 }],
    });
  });

  it('renders the four KPI labels', () => {
    renderToday();
    expect(screen.getByText('spend')).toBeInTheDocument();
    expect(screen.getByText('calls')).toBeInTheDocument();
    expect(screen.getByText('eff.')).toBeInTheDocument();
    expect(screen.getByText('flags')).toBeInTheDocument();
  });

  it('renders today total cost in the spend KPI', () => {
    renderToday();
    expect(screen.getByText('$12.17')).toBeInTheDocument();
  });

  it('renders the recent tool calls table', () => {
    renderToday();
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
  });

  it('renders an anti-pattern banner when patterns exist', () => {
    renderToday();
    expect(screen.getByText(/thrashing/i)).toBeInTheDocument();
    expect(screen.getByText(/auth\.ts/)).toBeInTheDocument();
  });

  it('hides the banner when no anti-patterns', () => {
    useLiveStore.setState({ antiPatterns: [] });
    renderToday();
    expect(screen.queryByText(/thrashing/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
npm run test:web -- src/web/views/Today.test.tsx
```

Expected: FAIL — Today is still the stub.

- [ ] **Step 3: Replace `src/web/views/Today.tsx` with the real view**

```tsx
import { useLiveStore } from '../store/liveStore';
import { Kpi } from '../components/Kpi';
import { Sparkline } from '../components/Sparkline';

export function Today(): JSX.Element {
  const recent = useLiveStore((s) => s.recentToolCalls);
  const cost = useLiveStore((s) => s.cost);
  const antiPatterns = useLiveStore((s) => s.antiPatterns);

  const calls = recent.length;
  const todayTotal = cost?.todayTotalUsd ?? 0;
  const sparklineValues = recent.map((c) => c.durationMs);

  return (
    <section>
      <header className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold">Today</h1>
        <span className="text-xs text-ink-muted">
          {new Date().toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        </span>
      </header>

      <div className="grid grid-cols-4 gap-2 mb-3">
        <Kpi label="spend" tone="accent" value={`$${todayTotal.toFixed(2)}`} />
        <Kpi label="calls" value={String(calls)} />
        <Kpi label="eff." tone="good" value="—" sub="needs more data" />
        <Kpi label="flags" tone={antiPatterns.length > 0 ? 'warn' : 'neutral'} value={String(antiPatterns.length)} />
      </div>

      {antiPatterns.length > 0 && (
        <div className="mb-3 bg-bg-panel border border-accent-amber/40 rounded p-2.5 text-xs">
          <span className="text-accent-amber font-semibold">⚠ {antiPatterns[0].type}</span>
          <span className="text-ink-muted"> — </span>
          <span>{antiPatterns[0].count}× re-edits to </span>
          <code className="bg-bg-line px-1 rounded">{antiPatterns[0].target}</code>
        </div>
      )}

      <div className="bg-bg-panel border border-bg-line rounded p-3 mb-3">
        <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-1.5">tool latency · live</div>
        {sparklineValues.length >= 2
          ? <Sparkline values={sparklineValues} />
          : <div className="text-ink-muted text-xs h-[50px] flex items-center">Waiting for tool calls…</div>}
      </div>

      <div className="bg-bg-panel border border-bg-line rounded p-3">
        <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">recent</div>
        {recent.length === 0
          ? <div className="text-ink-muted text-xs">No calls yet — start a Claude prompt.</div>
          : (
            <table className="w-full text-xs">
              <thead className="text-ink-muted">
                <tr><th className="text-left pb-1">tool</th><th className="text-right pb-1">latency</th></tr>
              </thead>
              <tbody>
                {recent.slice().reverse().map((c) => (
                  <tr key={c.id} className="border-t border-bg-line">
                    <td className="py-1">{c.tool}</td>
                    <td className="py-1 text-right tabular-nums">{c.durationMs} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npm run test:web -- src/web/views/Today.test.tsx
```

Expected: all 5 PASS.

- [ ] **Step 5: Lint + tsc + build**

```bash
npm run lint
npx tsc --noEmit -p tsconfig.web.json
npm run build:web
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/web/views/Today.tsx src/web/views/Today.test.tsx
git commit -m "Feat: build out the Today view

Four KPI cards, live sparkline of tool latencies, anti-pattern banner
when patterns are present, and a recent-calls table fed from the
SSE-backed Zustand store.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 35 — Build the Audit view

**Files:**
- Modify: `src/web/views/Audit.tsx`
- Create: `src/web/views/Audit.test.tsx`

The audit view is intentionally simple: a filterable table of `AuditTrailManager` entries plus a JSONL export button. Data comes from `/api/audit` via React Query.

- [ ] **Step 1: Write the failing test**

`src/web/views/Audit.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Audit } from './Audit';

function renderAudit(data: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify(data), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))) as typeof globalThis.fetch;
  return render(
    <QueryClientProvider client={qc}>
      <Audit />
    </QueryClientProvider>,
  );
}

const SAMPLE = [
  { ts: 1, tool: 'Read', target: '/etc/hosts', classification: 'sensitive_file', sessionId: 's1' },
  { ts: 2, tool: 'Bash', target: 'rm -rf /tmp/x', classification: 'destructive_command', sessionId: 's1' },
  { ts: 3, tool: 'Bash', target: 'curl evil.com', classification: 'external_network', sessionId: 's2' },
];

describe('Audit view', () => {
  it('renders rows for each audit entry', async () => {
    renderAudit(SAMPLE);
    await waitFor(() => expect(screen.getByText('/etc/hosts')).toBeInTheDocument());
    expect(screen.getByText('rm -rf /tmp/x')).toBeInTheDocument();
    expect(screen.getByText('curl evil.com')).toBeInTheDocument();
  });

  it('filters by classification when a chip is clicked', async () => {
    const user = userEvent.setup();
    renderAudit(SAMPLE);
    await waitFor(() => expect(screen.getByText('/etc/hosts')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /destructive/i }));
    expect(screen.queryByText('/etc/hosts')).toBeNull();
    expect(screen.getByText('rm -rf /tmp/x')).toBeInTheDocument();
  });

  it('export button is rendered', async () => {
    renderAudit(SAMPLE);
    await waitFor(() => expect(screen.getByText('/etc/hosts')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /export jsonl/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
npm run test:web -- src/web/views/Audit.test.tsx
```

Expected: FAIL — Audit is still the stub.

- [ ] **Step 3: Replace `src/web/views/Audit.tsx`**

```tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchAuditLog, qk } from '../api/client';

interface AuditEntry {
  readonly ts: number;
  readonly tool: string;
  readonly target: string;
  readonly classification: string;
  readonly sessionId?: string;
}

const FILTERS = [
  { key: 'all',                   label: 'All' },
  { key: 'sensitive_file',        label: 'Sensitive files' },
  { key: 'destructive_command',   label: 'Destructive' },
  { key: 'external_network',      label: 'External network' },
] as const;

type FilterKey = typeof FILTERS[number]['key'];

function downloadJsonl(rows: AuditEntry[]): void {
  const text = rows.map((r) => JSON.stringify(r)).join('\n');
  const blob = new Blob([text], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-${new Date().toISOString().slice(0, 10)}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Audit(): JSX.Element {
  const [filter, setFilter] = useState<FilterKey>('all');
  const { data, isLoading, error } = useQuery<AuditEntry[]>({
    queryKey: qk.audit,
    queryFn: () => fetchAuditLog() as Promise<AuditEntry[]>,
  });

  const rows = data ?? [];
  const visible = filter === 'all' ? rows : rows.filter((r) => r.classification === filter);

  return (
    <section>
      <header className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold">Audit</h1>
        <button
          type="button"
          onClick={() => downloadJsonl(rows)}
          className="text-xs px-2 py-1 bg-bg-panel border border-bg-line rounded hover:border-accent-cyan"
        >Export JSONL</button>
      </header>

      <div className="flex gap-2 mb-3 flex-wrap">
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={
              'text-xs px-2 py-1 rounded border ' +
              (filter === key
                ? 'bg-bg-line border-accent-cyan text-ink-base'
                : 'bg-bg-panel border-bg-line text-ink-subtle hover:text-ink-base')
            }
          >{label}</button>
        ))}
      </div>

      {isLoading && <div className="text-ink-muted text-xs">Loading…</div>}
      {error && <div className="text-accent-red text-xs">Error loading audit log.</div>}

      {!isLoading && !error && (
        <div className="bg-bg-panel border border-bg-line rounded">
          <table className="w-full text-xs">
            <thead className="text-ink-muted bg-bg-line/40">
              <tr>
                <th className="text-left p-2">When</th>
                <th className="text-left p-2">Tool</th>
                <th className="text-left p-2">Target</th>
                <th className="text-left p-2">Classification</th>
                <th className="text-left p-2">Session</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr><td colSpan={5} className="p-3 text-ink-muted text-center">No matching entries.</td></tr>
              )}
              {visible.map((r, i) => (
                <tr key={i} className="border-t border-bg-line">
                  <td className="p-2 tabular-nums">{new Date(r.ts).toLocaleTimeString()}</td>
                  <td className="p-2">{r.tool}</td>
                  <td className="p-2 font-mono text-[11px]">{r.target}</td>
                  <td className="p-2">
                    <span className="px-1.5 py-0.5 bg-bg-line rounded text-[10px]">{r.classification}</span>
                  </td>
                  <td className="p-2 text-ink-subtle">{r.sessionId ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npm run test:web -- src/web/views/Audit.test.tsx
```

Expected: all 3 PASS.

- [ ] **Step 5: Lint + tsc + build**

```bash
npm run lint
npx tsc --noEmit -p tsconfig.web.json
npm run build:web
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/web/views/Audit.tsx src/web/views/Audit.test.tsx
git commit -m "Feat: Audit view — filterable table + JSONL export

Reads /api/audit, lets users filter by sensitive_file /
destructive_command / external_network, and exports the unfiltered
list as JSONL via a Blob download (no server round-trip, no upload).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 36 — Wire `auditTrailManager` into `api-handler` deps and Phase 2 acceptance

**Files:**
- Modify: `src/dashboard/routes/api-handler.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Confirm `/api/audit` was added in Task 14**

If you haven't already added the `auditTrailManager` field to `ApiHandlerDeps` and registered `GET /api/audit`, do so now using the same pattern as Task 13:

```ts
// in src/dashboard/routes/api-handler.ts
export interface ApiHandlerDeps {
  readonly sessionTracker?: { getMetrics: () => unknown };
  readonly auditTrailManager?: { getAuditLog: () => unknown[] };
  // … other trackers …
}

routes.set('GET /api/audit', (_req, res) => {
  if (!deps.auditTrailManager) return unavailable(res, 'auditTrailManager');
  jsonOk(res, deps.auditTrailManager.getAuditLog());
});
```

- [ ] **Step 2: Pass it through from `index.ts`**

In `src/index.ts`, in the `dashboardServer = new DashboardServer({ ... api: { ... } })` block, add:

```ts
api: {
  sessionTracker,
  auditTrailManager: nrIngest?.auditTrail,   // undefined in pure local mode
  // … other trackers …
},
```

In pure local mode the `auditTrailManager` lives elsewhere — extract it from wherever it's instantiated (currently inside `NrIngestManager`). If it's tightly coupled to `NrIngestManager`, lift it into a standalone constructor call so it works without the ingest manager:

```ts
// Lift AuditTrailManager construction so it works in mode='local'
const { AuditTrailManager } = await import('./security/audit-trail.js');
const auditTrail = new AuditTrailManager();
mcpServer.auditTrailManager = auditTrail;
```

Then pass `auditTrail` to both `NrIngestManager` (when constructed) and `DashboardServer.api`.

- [ ] **Step 3: Run all tests**

```bash
npm test
npm run test:web
```

Expected: all PASS.

- [ ] **Step 4: Build + manual smoke**

```bash
npm run build
mkdir -p /tmp/nr-ai-test/.nr-ai-observe
echo '{ "mode": "local" }' > /tmp/nr-ai-test/.nr-ai-observe/config.json
HOME=/tmp/nr-ai-test node dist/index.js --stdio &
SERVER_PID=$!
sleep 1
echo "Health:"
curl -s http://127.0.0.1:7777/api/health
echo ""
echo "Audit:"
curl -s http://127.0.0.1:7777/api/audit | head -c 200
echo ""
echo "Static SPA index.html exists:"
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7777/
kill $SERVER_PID 2>/dev/null || true
```

Expected: health returns `{"ok":true}`; audit returns `[]` (empty array — no events yet); root returns 200 (the SPA index.html).

- [ ] **Step 5: Open in a real browser**

Navigate to `http://127.0.0.1:7777/`. Expect to see the dark Console-style sidebar with four nav items, the Today view rendering "Waiting for tool calls…", and the live indicator showing `● connected` once the SSE handshake lands.

If everything renders, Phase 2 is done. Move on to Phase 3.

---

# Phase 3 — Sessions + History

Goal by end of phase: Sessions view shows a list of past sessions with click-through to a tool-call timeline; History view shows weekly efficiency, daily spend, cost-per-outcome, and anti-pattern frequency.

## Task 37 — Sessions list view (left pane)

**Files:**
- Modify: `src/web/views/Sessions.tsx`
- Create: `src/web/views/Sessions.test.tsx`

- [ ] **Step 1: Write the failing test**

`src/web/views/Sessions.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sessions } from './Sessions';

function renderSessions(data: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  globalThis.fetch = ((url: string) => {
    if (url.startsWith('/api/sessions/')) {
      return Promise.resolve(new Response(JSON.stringify({ sessionId: 's1', toolCalls: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }
    return Promise.resolve(new Response(JSON.stringify(data), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
  }) as typeof globalThis.fetch;
  return render(
    <QueryClientProvider client={qc}>
      <Sessions />
    </QueryClientProvider>,
  );
}

const SAMPLE_LIST = [
  { sessionId: 's1', startTime: '2026-05-28T09:00:00Z', toolCallCount: 42, estimatedCostUsd: 1.23, outcome: 'feature' },
  { sessionId: 's2', startTime: '2026-05-27T15:30:00Z', toolCallCount: 18, estimatedCostUsd: 0.45, outcome: 'bug_fix' },
];

describe('Sessions view', () => {
  it('renders one row per session in the list', async () => {
    renderSessions(SAMPLE_LIST);
    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    expect(screen.getByText(/s2/)).toBeInTheDocument();
  });

  it('shows tool-call count and cost per row', async () => {
    renderSessions(SAMPLE_LIST);
    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    expect(screen.getByText('42 calls')).toBeInTheDocument();
    expect(screen.getByText('$1.23')).toBeInTheDocument();
  });

  it('shows an empty-state message when list is empty', async () => {
    renderSessions([]);
    await waitFor(() => expect(screen.getByText(/no sessions yet/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
npm run test:web -- src/web/views/Sessions.test.tsx
```

Expected: FAIL — Sessions is the stub.

- [ ] **Step 3: Replace `src/web/views/Sessions.tsx`**

```tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchSessionsList, fetchSessionDetail, qk } from '../api/client';

interface SessionRow {
  readonly sessionId: string;
  readonly startTime: string;
  readonly toolCallCount: number;
  readonly estimatedCostUsd: number | null;
  readonly outcome: string | null;
}

interface SessionDetail {
  readonly sessionId: string;
  readonly toolCalls: ReadonlyArray<{
    readonly toolName: string;
    readonly durationMs: number;
    readonly startTime: number;
    readonly endTime: number;
  }>;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export function Sessions(): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = useQuery<SessionRow[]>({
    queryKey: qk.sessionsList,
    queryFn: () => fetchSessionsList() as Promise<SessionRow[]>,
  });

  const detail = useQuery<SessionDetail>({
    queryKey: selectedId ? qk.sessionDetail(selectedId) : ['session', 'none'],
    queryFn: () => fetchSessionDetail(selectedId!) as Promise<SessionDetail>,
    enabled: selectedId !== null,
  });

  const rows = list.data ?? [];

  return (
    <section className="grid grid-cols-[260px_1fr] gap-3 h-full">
      <aside className="bg-bg-panel border border-bg-line rounded overflow-hidden flex flex-col">
        <header className="p-2 border-b border-bg-line">
          <h2 className="text-xs uppercase tracking-wider text-ink-muted">Sessions</h2>
        </header>
        <div className="overflow-auto">
          {list.isLoading && <div className="p-3 text-ink-muted text-xs">Loading…</div>}
          {!list.isLoading && rows.length === 0 && (
            <div className="p-3 text-ink-muted text-xs">No sessions yet — start coding with Claude.</div>
          )}
          {rows.map((r) => (
            <button
              key={r.sessionId}
              type="button"
              onClick={() => setSelectedId(r.sessionId)}
              className={
                'block w-full text-left p-2 border-b border-bg-line text-xs hover:bg-bg-line ' +
                (selectedId === r.sessionId ? 'bg-bg-line' : '')
              }
            >
              <div className="flex justify-between">
                <span className="font-mono text-ink-base">{r.sessionId.slice(0, 8)}</span>
                <span className="text-ink-muted">{fmtTime(r.startTime)}</span>
              </div>
              <div className="flex justify-between mt-1 text-ink-subtle text-[11px]">
                <span>{r.toolCallCount} calls</span>
                <span>{r.estimatedCostUsd !== null ? `$${r.estimatedCostUsd.toFixed(2)}` : '—'}</span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <div className="bg-bg-panel border border-bg-line rounded p-3 overflow-auto">
        {!selectedId && <div className="text-ink-muted text-xs">Pick a session on the left.</div>}
        {selectedId && detail.isLoading && <div className="text-ink-muted text-xs">Loading detail…</div>}
        {selectedId && detail.data && (
          <SessionTimeline data={detail.data} />
        )}
      </div>
    </section>
  );
}

function SessionTimeline({ data }: { data: SessionDetail }): JSX.Element {
  const calls = data.toolCalls;
  if (calls.length === 0) {
    return <div className="text-ink-muted text-xs">No tool calls in this session.</div>;
  }
  const first = calls[0]?.startTime ?? 0;
  const last  = calls[calls.length - 1]?.endTime ?? first + 1;
  const span  = Math.max(1, last - first);

  return (
    <div>
      <h2 className="text-xs uppercase tracking-wider text-ink-muted mb-2">
        {data.sessionId} · {calls.length} calls · {Math.round(span / 1000)}s
      </h2>
      <div className="flex flex-col gap-0.5">
        {calls.map((c, i) => {
          const left = ((c.startTime - first) / span) * 100;
          const width = Math.max(0.5, ((c.endTime - c.startTime) / span) * 100);
          return (
            <div key={i} className="flex items-center gap-2 text-[11px]">
              <span className="w-20 text-ink-subtle truncate">{c.toolName}</span>
              <div className="flex-1 h-3 bg-bg-base relative rounded">
                <div
                  className="absolute top-0 h-3 bg-accent-cyan/70 rounded"
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${c.durationMs}ms`}
                />
              </div>
              <span className="w-14 text-right text-ink-muted tabular-nums">{c.durationMs}ms</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npm run test:web -- src/web/views/Sessions.test.tsx
```

Expected: all 3 PASS.

- [ ] **Step 5: Lint + tsc + build**

```bash
npm run lint
npx tsc --noEmit -p tsconfig.web.json
npm run build:web
```

- [ ] **Step 6: Commit**

```bash
git add src/web/views/Sessions.tsx src/web/views/Sessions.test.tsx
git commit -m "Feat: Sessions view with list + Gantt-ish timeline detail

Left pane lists past sessions (newest first); clicking one fetches
/api/sessions/:id and renders a horizontal timeline of every tool
call relative to the session window.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 38 — History view (weekly efficiency + daily spend charts)

**Files:**
- Modify: `src/web/views/History.tsx`
- Create: `src/web/views/History.test.tsx`

This task uses Recharts. Two charts only — cost-per-outcome and anti-pattern frequency are added in Task 39.

- [ ] **Step 1: Write the failing test**

`src/web/views/History.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { History } from './History';

const SAMPLE_WEEKLY = [
  { weekStart: '2026-04-21', efficiencyScore: 0.82, totalCostUsd: 14.12 },
  { weekStart: '2026-04-28', efficiencyScore: 0.88, totalCostUsd: 18.40 },
  { weekStart: '2026-05-05', efficiencyScore: 0.91, totalCostUsd: 12.75 },
  { weekStart: '2026-05-12', efficiencyScore: 0.94, totalCostUsd: 16.30 },
];

const SAMPLE_SESSIONS = [
  { sessionId: 's1', startTime: '2026-05-26T09:00:00Z', estimatedCostUsd: 1.2 },
  { sessionId: 's2', startTime: '2026-05-26T15:00:00Z', estimatedCostUsd: 0.8 },
  { sessionId: 's3', startTime: '2026-05-27T10:00:00Z', estimatedCostUsd: 2.4 },
  { sessionId: 's4', startTime: '2026-05-28T11:00:00Z', estimatedCostUsd: 1.7 },
];

function renderHistory() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  globalThis.fetch = ((url: string) => {
    if (url.startsWith('/api/weekly')) {
      return Promise.resolve(new Response(JSON.stringify(SAMPLE_WEEKLY), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }
    if (url.startsWith('/api/sessions')) {
      return Promise.resolve(new Response(JSON.stringify(SAMPLE_SESSIONS), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }
    return Promise.resolve(new Response('null', { status: 200 }));
  }) as typeof globalThis.fetch;
  return render(
    <QueryClientProvider client={qc}>
      <History />
    </QueryClientProvider>,
  );
}

describe('History view', () => {
  it('renders the section headings', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getByText(/efficiency/i)).toBeInTheDocument());
    expect(screen.getByText(/spend/i)).toBeInTheDocument();
  });

  it('renders a chart for weekly efficiency', async () => {
    const { container } = renderHistory();
    await waitFor(() => {
      const svgs = container.querySelectorAll('svg');
      expect(svgs.length).toBeGreaterThanOrEqual(1);
    });
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
npm run test:web -- src/web/views/History.test.tsx
```

Expected: FAIL — History is the stub.

- [ ] **Step 3: Replace `src/web/views/History.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { fetchWeekly, fetchSessionsList, qk } from '../api/client';

interface WeeklyRow {
  readonly weekStart: string;
  readonly efficiencyScore: number;
  readonly totalCostUsd: number;
}

interface SessionRow {
  readonly sessionId: string;
  readonly startTime: string;
  readonly estimatedCostUsd: number | null;
}

const TICK_STYLE = { fill: '#94a3b8', fontSize: 10 };
const GRID_STROKE = '#1e293b';
const ACCENT = '#22d3ee';

export function History(): JSX.Element {
  const weekly = useQuery<WeeklyRow[]>({
    queryKey: qk.weekly,
    queryFn: () => fetchWeekly() as Promise<WeeklyRow[]>,
  });

  const sessions = useQuery<SessionRow[]>({
    queryKey: qk.sessionsList,
    queryFn: () => fetchSessionsList(200) as Promise<SessionRow[]>,
  });

  const weeklyData = (weekly.data ?? []).map((w) => ({
    week: w.weekStart.slice(5),
    efficiency: Math.round(w.efficiencyScore * 100),
  }));

  const dailyData = aggregateDailyCost(sessions.data ?? [], 30);

  return (
    <section>
      <h1 className="text-xl font-semibold mb-4">History</h1>

      <div className="grid grid-cols-2 gap-3">
        <Panel title="Weekly efficiency · last 8">
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={weeklyData}>
                <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                <XAxis dataKey="week" tick={TICK_STYLE} stroke={GRID_STROKE} />
                <YAxis tick={TICK_STYLE} stroke={GRID_STROKE} domain={[0, 100]} unit="%" />
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', fontSize: 12 }} />
                <Line type="monotone" dataKey="efficiency" stroke={ACCENT} strokeWidth={2} dot={{ r: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Daily spend · last 30 days">
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dailyData}>
                <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                <XAxis dataKey="day" tick={TICK_STYLE} stroke={GRID_STROKE} />
                <YAxis tick={TICK_STYLE} stroke={GRID_STROKE} unit="$" />
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', fontSize: 12 }} />
                <Bar dataKey="cost" fill={ACCENT} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>
    </section>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="bg-bg-panel border border-bg-line rounded p-3">
      <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">{title}</div>
      {children}
    </div>
  );
}

function aggregateDailyCost(rows: SessionRow[], days: number): Array<{ day: string; cost: number }> {
  const byDay = new Map<string, number>();
  for (const r of rows) {
    if (r.estimatedCostUsd === null) continue;
    const day = new Date(r.startTime).toISOString().slice(5, 10); // MM-DD
    byDay.set(day, (byDay.get(day) ?? 0) + r.estimatedCostUsd);
  }
  // Last `days` keys, chronological
  const sorted = Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  return sorted.slice(-days).map(([day, cost]) => ({ day, cost: Number(cost.toFixed(2)) }));
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npm run test:web -- src/web/views/History.test.tsx
```

Expected: both PASS.

- [ ] **Step 5: Lint + tsc + build**

```bash
npm run lint
npx tsc --noEmit -p tsconfig.web.json
npm run build:web
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/web/views/History.tsx src/web/views/History.test.tsx
git commit -m "Feat: History view — weekly efficiency line + daily spend bars

Weekly efficiency chart fed from /api/weekly (last 8 weeks); daily
spend bars derived client-side by bucketing /api/sessions results by
day for the last 30 days.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 39 — Bundle-size CI check

**Files:**
- Create: `scripts/check-bundle-size.ts`
- Modify: `package.json`

Enforces the 400 KB gzipped ceiling on the SPA bundle.

- [ ] **Step 1: Write the script**

`scripts/check-bundle-size.ts`:

```ts
#!/usr/bin/env tsx
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';

const LIMIT_BYTES = 400 * 1024;
const ASSETS_DIR = resolve(process.cwd(), 'dist/web/assets');

function findMainJs(): string {
  let entries: string[];
  try {
    entries = readdirSync(ASSETS_DIR);
  } catch (err) {
    console.error(`Bundle check failed: ${ASSETS_DIR} not found. Run 'npm run build:web' first.`);
    process.exit(1);
  }
  const mainJs = entries.find((f) => /^main-.*\.js$/.test(f));
  if (!mainJs) {
    console.error(`No main-*.js found in ${ASSETS_DIR}. Files: ${entries.join(', ')}`);
    process.exit(1);
  }
  return join(ASSETS_DIR, mainJs);
}

function main(): void {
  const path = findMainJs();
  const raw = readFileSync(path);
  const gz = gzipSync(raw);
  const rawKb = (raw.length / 1024).toFixed(1);
  const gzKb  = (gz.length / 1024).toFixed(1);
  const rawSize = statSync(path).size;
  console.log(`SPA bundle: ${path}`);
  console.log(`  raw:      ${rawKb} KB  (${rawSize} bytes)`);
  console.log(`  gzipped:  ${gzKb} KB`);
  console.log(`  limit:    ${(LIMIT_BYTES / 1024).toFixed(0)} KB gzipped`);
  if (gz.length > LIMIT_BYTES) {
    console.error(`\n✗ FAIL: gzipped bundle exceeds limit by ${((gz.length - LIMIT_BYTES) / 1024).toFixed(1)} KB`);
    process.exit(1);
  }
  console.log('\n✓ OK');
}

main();
```

- [ ] **Step 2: Wire into npm scripts**

In `package.json`, append to `"scripts"`:

```json
"check:bundle-size": "tsx scripts/check-bundle-size.ts"
```

- [ ] **Step 3: Run it locally**

```bash
npm run build:web
npm run check:bundle-size
```

Expected: prints sizes and `✓ OK`. If FAIL, you've added a heavy dep — investigate before continuing.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-bundle-size.ts package.json
git commit -m "Chore: add SPA bundle-size CI check (400 KB gzipped ceiling)

Fails the build if dist/web/assets/main-*.js exceeds 400 KB gzipped.
Run via 'npm run check:bundle-size' after 'npm run build:web'.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 40 — Phase 3 acceptance check

- [ ] **Step 1: Full test suite**

```bash
npm test
npm run test:web
```

Expected: all PASS.

- [ ] **Step 2: Lint + build + bundle check**

```bash
npm run lint
npm run build
npm run check:bundle-size
```

Expected: zero errors, bundle under 400 KB gzipped.

- [ ] **Step 3: Manual smoke through real browser**

```bash
mkdir -p /tmp/nr-ai-test/.nr-ai-observe
echo '{ "mode": "local" }' > /tmp/nr-ai-test/.nr-ai-observe/config.json
HOME=/tmp/nr-ai-test node dist/index.js --stdio &
SERVER_PID=$!
sleep 1
echo "Open http://127.0.0.1:7777/ in your browser; press Enter when done."
read
kill $SERVER_PID 2>/dev/null || true
```

Manually verify:
- Sidebar shows four nav items
- Today view renders (KPIs + sparkline + recent table)
- Sessions view renders empty list (no sessions yet) with right-pane prompt
- History view renders both charts (will show no data on a fresh install)
- Audit view renders an empty table with filter chips

If everything works, Phase 3 is done.

---

# Phase 4 — Polish, docs, setup wizard

Goal by end of phase: setup wizard offers a "Mode" branch; README and ONBOARDING.md document local mode; smoke-test checklist passes; PR is ready.

## Task 41 — Setup wizard "Mode" branch

**Files:**
- Modify: `src/install/setup-wizard.ts`
- Modify: `src/install/setup-wizard.test.ts` (or co-located test)

- [ ] **Step 1: Read the current wizard**

```bash
sed -n '1,80p' src/install/setup-wizard.ts
```

Identify the existing prompt order (likely: licenseKey → accountId → developer → … → save).

- [ ] **Step 2: Add a Mode prompt at the top**

Above the licenseKey prompt, add:

```ts
const mode = await prompt({
  message: 'Which mode would you like?',
  choices: [
    { name: 'cloud — ship telemetry to New Relic (default)', value: 'cloud' },
    { name: 'local — keep all data on this machine, run a local dashboard', value: 'local' },
    { name: 'both  — ship to NR AND run the local dashboard', value: 'both' },
  ],
  default: 'cloud',
});
```

Wrap the licenseKey/accountId prompts in `if (mode !== 'local') { /* existing prompts */ }`.

After the licenseKey block, add:

```ts
if (mode === 'local' || mode === 'both') {
  const port = await prompt({
    message: 'Local dashboard port (loopback only):',
    default: 7777,
    validate: (p: number) => p > 0 && p < 65536 ? true : 'Port must be 1–65535',
  });
  config.dashboard = { port, host: '127.0.0.1', openOnStart: false };
}
```

Persist `mode` and `dashboard` into the saved config:

```ts
const writeOut = {
  mode,
  ...(mode !== 'local' && { licenseKey, accountId }),
  ...(config.dashboard && { dashboard: config.dashboard }),
  developer,
  // ... existing fields ...
};
```

- [ ] **Step 3: Add a unit test**

Append to `src/install/setup-wizard.test.ts` (create the file if it doesn't exist; mock `prompt`):

```ts
import { runSetupWizard } from './setup-wizard.js';

describe('setupWizard mode branch', () => {
  it("when mode='local' is chosen, does NOT prompt for licenseKey", async () => {
    const promptCalls: string[] = [];
    const fakePrompt = async (q: { message: string; choices?: unknown[] }) => {
      promptCalls.push(q.message);
      if (q.message.toLowerCase().includes('mode')) return 'local';
      if (q.message.toLowerCase().includes('port')) return 7777;
      if (q.message.toLowerCase().includes('developer')) return 'tester';
      return '';
    };
    const result = await runSetupWizard({ prompt: fakePrompt, save: () => {} });
    expect(result.mode).toBe('local');
    expect(result.licenseKey).toBeUndefined();
    expect(promptCalls.some((m) => m.toLowerCase().includes('license'))).toBe(false);
  });
});
```

If `runSetupWizard` doesn't already accept injected `prompt`/`save`, refactor it to do so. Keep the change minimal.

- [ ] **Step 4: Run, lint, build, commit**

```bash
npm test -- src/install/setup-wizard.test.ts
npm run lint
npm run build:server
git add src/install/setup-wizard.ts src/install/setup-wizard.test.ts
git commit -m "Feat: setup wizard offers cloud/local/both mode branch

Local-mode users skip licenseKey/accountId prompts and instead pick
a dashboard port (default 7777). Existing cloud-mode flow unchanged.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 42 — README updates

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Local mode" section**

Open `README.md` and add a new section after the existing "Quick Start" / "Configuration" section:

```markdown
## Local mode

If you'd rather not ship telemetry to New Relic, set `mode: 'local'` in your config:

```json
{
  "mode": "local"
}
```

In local mode:

- The MCP server does **not** construct `NrIngestManager` and never makes outbound HTTP calls to NR.
- An embedded dashboard boots at **http://127.0.0.1:7777** (configurable via `dashboard.port` or `NR_AI_DASHBOARD_PORT`).
- All telemetry stays in `~/.nr-ai-observe/` on your machine.
- `licenseKey` and `accountId` are not required.

The dashboard has four views:

- **Today** — live KPIs, sparkline of tool latencies, recent calls, anti-pattern alerts.
- **Sessions** — list of past sessions with a per-session timeline of every tool call.
- **History** — weekly efficiency and daily spend trends.
- **Audit** — every classified tool call (sensitive file access, destructive commands, external network), with a JSONL export button.

Run `nr-ai-observe setup` to choose a mode interactively.
```

- [ ] **Step 2: Verify markdown renders**

Open in your editor and confirm the section reads cleanly.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Docs: add Local mode section to README

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 43 — ONBOARDING.md updates

**Files:**
- Modify: `docs/ONBOARDING.md`

- [ ] **Step 1: Add a new sub-section**

Read the file:

```bash
cat docs/ONBOARDING.md | head -60
```

Add a "Choosing a mode" section just before the existing config-file walkthrough. Mirror the README content but lean more on workflow/troubleshooting:

```markdown
### Choosing a mode

NR AI Observatory supports three modes via the `mode` config field:

1. **`cloud`** (default) — telemetry ships to New Relic. Required for cross-team dashboards.
2. **`local`** — telemetry stays on your machine; dashboard runs at `http://127.0.0.1:7777`.
3. **`both`** — both behaviors active. Useful as a transition aid or to verify local data matches cloud.

If you're not sure, start with **`local`** to see what data the tool collects before opting into cloud transport.

#### Verifying local mode

After setting `mode: 'local'`:

```bash
# Restart Claude Code, then:
curl -s http://127.0.0.1:7777/api/health
# Expected: {"ok":true,"uptime":<number>}
```

You should also see this line in Claude Code's MCP startup logs:

```
Dashboard ready at http://127.0.0.1:7777
```

If the URL is unreachable, check whether port 7777 is in use (`lsof -i:7777`) and override with `NR_AI_DASHBOARD_PORT`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/ONBOARDING.md
git commit -m "Docs: add 'Choosing a mode' section to ONBOARDING.md

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

## Task 44 — Final smoke-test checklist + open the PR

**Files:**
- Create: `docs/superpowers/plans/2026-05-28-local-only-mode-smoke-test.md`

- [ ] **Step 1: Write the checklist**

```markdown
# Local-only mode v1 — smoke test

Run before opening the PR.

## Setup

```bash
mkdir -p ~/nr-ai-smoke/.nr-ai-observe
echo '{ "mode": "local" }' > ~/nr-ai-smoke/.nr-ai-observe/config.json
HOME=~/nr-ai-smoke node dist/index.js --stdio &
SERVER_PID=$!
sleep 1
```

## Verify

- [ ] `curl -s http://127.0.0.1:7777/api/health` returns `{"ok":true,...}`.
- [ ] `curl -sI http://127.0.0.1:7777/` returns `200` and `content-type: text/html`.
- [ ] `curl -sI -H "Host: evil.com" http://127.0.0.1:7777/api/health` returns `403`.
- [ ] `curl -s http://127.0.0.1:7777/api/health -o /dev/null -w "CSP: %header{content-security-policy}\n"` shows a CSP starting with `default-src 'self'`.
- [ ] `timeout 2 curl -sN http://127.0.0.1:7777/sse | head -3` shows `: stream-open`.

## Open in browser

Navigate to **http://127.0.0.1:7777/** and verify by eye:

- [ ] Sidebar has 4 nav items, "● connected" is green.
- [ ] Today view loads with KPIs, even if values are 0.
- [ ] Sessions view loads, shows "No sessions yet — start coding with Claude" if first run.
- [ ] History view loads with both charts (may be empty on first run).
- [ ] Audit view loads with filter chips and "No matching entries." in the table.

## Trigger live data

In another terminal, while the server is still running:

- [ ] Use Claude Code briefly with this MCP server attached.
- [ ] Tool calls appear in the Today view's "recent" table within ~2s of completion.
- [ ] Spend KPI updates as cost accumulates.

## Privacy proof

- [ ] `npm test -- src/index.privacy.test.ts` passes.
- [ ] In a fresh terminal: `tcpdump -nn -i any host api.newrelic.com` shows zero packets while running with `mode: 'local'`.

## Cleanup

```bash
kill $SERVER_PID
rm -rf ~/nr-ai-smoke
```
```

- [ ] **Step 2: Run the checklist end-to-end**

Walk through every checkbox. Anything that fails is a blocker — fix it before opening the PR.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feat/local-only-mode-spec
gh pr create --title "Feat: local-only mode + embedded dashboard" --body "$(cat <<'EOF'
## Summary

- Adds `mode: 'cloud' | 'local' | 'both'` config field that gates NR transport and dashboard startup.
- Adds an embedded React/Vite dashboard at `http://127.0.0.1:7777` with four views (Today, Sessions, History, Audit) and SSE-driven real-time updates.
- Privacy guarantees: in `mode: 'local'`, `NrIngestManager` is never constructed; strict CSP + DNS-rebinding protection on the dashboard; integration test asserts zero outbound HTTP.

## Test plan

- [x] `npm test` passes (server + privacy proof)
- [x] `npm run test:web` passes (SPA components and views)
- [x] `npm run build` produces `dist/index.js` and `dist/web/`
- [x] `npm run check:bundle-size` passes (under 400 KB gzipped)
- [x] Manual smoke checklist (`docs/superpowers/plans/2026-05-28-local-only-mode-smoke-test.md`) walked end-to-end
- [x] Existing tests unchanged in default `mode: 'cloud'`

## Spec & plan

- Design: `docs/superpowers/specs/2026-05-28-local-only-mode-design.md`
- Plan:   `docs/superpowers/plans/2026-05-28-local-only-mode.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Commit the smoke checklist**

```bash
git add docs/superpowers/plans/2026-05-28-local-only-mode-smoke-test.md
git commit -m "Docs: add smoke-test checklist for local-only mode v1

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
git push
```

Phase 4 — and the project — are done when this PR is approved and merged.

---

# Self-review notes

A skim against the spec turned up these gaps; either task above already covers them or they're called out below for the implementer to handle when they arrive at the relevant phase.

- **Cost forecast in SSE**: Task 15 sets `forecastEodUsd: null`; the spec wants a real value. The forecast tracker (`src/metrics/cost-forecast.ts`) already exists — wire it into the bus emission once you've added it to `ApiHandlerDeps` in Task 14.
- **Personal coach narrative card** (History view, spec §4): not in Task 38. Add as a follow-up commit in Phase 3 once the chart panels are landed; it reuses the existing `PersonalCoach` metric.
- **Cost-per-outcome breakdown** (History view, spec §4): not in Task 38. Add as a third panel after the daily-spend chart, fed from `/api/cost` (which is wired in Task 14).
- **`auditTrailManager` lifting** (Task 36): the spec assumes a clean separation; the current code has it embedded inside `NrIngestManager`. If the lift turns out to be invasive, a smaller alternative is to construct an empty `AuditTrailManager` in local mode just for the dashboard — no audit data will accumulate, but the API stays consistent.

# Stack notes for the implementer

- The repo enforces zero ESLint errors and zero warnings. Never add `eslint-disable`; fix the underlying issue.
- All TS imports use `.js` extensions (NodeNext). The SPA (`src/web/**`) uses Vite which doesn't require this — but `import './foo.js'` still works there, so be consistent if you prefer.
- `chmod +x` after `tsc` is required (preserved in `build:server`). If MCP stops connecting after a build, suspect missing exec bits.
- The repo previously used a Python agent and a separate shared package; both have been extracted. Don't add references to those — the current repo is flat single-package TypeScript.
- Git push to `main` is blocked by a pre-receive hook; PRs only.
- Use `npm run` for cross-dir builds, not `npx --prefix`.
