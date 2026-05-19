# Implementation Plan: MCP Tool Call Tracing

**Roadmap item:** [20 — MCP Tool Call Tracing](../ROADMAP.md#20-mcp-tool-call-tracing)
**Effort estimate:** ~3 days
**Prerequisites:** Read `packages/nr-ai-mcp-server/src/hooks/event-processor.ts`, `packages/nr-ai-mcp-server/src/server.ts`, and `packages/nr-ai-mcp-server/src/storage/types.ts` before starting. Items 17 and 18 must be complete first — this plan depends on the OTel SDK dependencies from item 18.

---

## Goal

Trace every Claude Code tool call as an OpenTelemetry span. Each `ToolCallRecord` (a paired pre/post hook event) becomes a child span. Task boundaries detected by `TaskDetector` become intermediate parent spans. The MCP server session is the root span. The resulting waterfall shows exactly what the AI coding assistant did during a session — which files were read/edited, which commands were run, how long each step took, and which tasks they belonged to — in any OTel-compatible backend.

This is the first-ever OTel tracing implementation for MCP tool calls and AI coding session instrumentation.

---

## Background reading

Before starting, read these files end-to-end:

- `packages/nr-ai-mcp-server/src/hooks/event-processor.ts` — where `ToolCallRecord` objects are emitted via `onRecord`
- `packages/nr-ai-mcp-server/src/server.ts` — the `NrMcpServer` that wires everything together; root span lives here
- `packages/nr-ai-mcp-server/src/storage/types.ts` — `ToolCallRecord` and `HookEvent` interfaces
- `packages/nr-ai-mcp-server/src/metrics/task-detector.ts` — task boundary detection to use for task spans
- `packages/shared/src/transport/otlp-transport.ts` (from item 18) — provides the tracer

---

## Step 0 — Add OTel dependency to `packages/nr-ai-mcp-server`

`packages/nr-ai-mcp-server/package.json` currently has no `@opentelemetry` entries. Before writing any tracing files, add `"@opentelemetry/api": "^1.9.0"` to the `dependencies` block in `packages/nr-ai-mcp-server/package.json` and run `npm install` from the repo root. (`@opentelemetry/sdk-trace-node` and the exporters live in `packages/shared` — `nr-ai-mcp-server` only needs the API package for span types and `trace.getTracer()`.)

---

## Step 1 — Create `packages/nr-ai-mcp-server/src/tracing/` directory

Create three files in this directory:

### 1a — `packages/nr-ai-mcp-server/src/tracing/mcp-tracer.ts`

Manages the tracer instance for the MCP server:

```typescript
import { trace, type Tracer } from '@opentelemetry/api';
import { createLogger } from '@nr-ai-observatory/shared';

const logger = createLogger('mcp-tracer');
const SCOPE = 'nr-ai-mcp-server';
const VERSION = '1.0.0'; // keep in sync with package.json

let _tracer: Tracer | null = null;

export function initMcpTracer(): void {
  _tracer = trace.getTracer(SCOPE, VERSION);
  logger.debug('MCP tracer initialized');
}

export function getMcpTracer(): Tracer {
  return _tracer ?? trace.getTracer(SCOPE, VERSION);
}
```

### 1b — `packages/nr-ai-mcp-server/src/tracing/session-span.ts`

Manages the session-level root span lifecycle:

```typescript
import { type Span, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { getMcpTracer } from './mcp-tracer.js';
import { createLogger } from '@nr-ai-observatory/shared';

const logger = createLogger('session-span');

export class SessionSpan {
  private span: Span | null = null;
  private readonly sessionId: string;
  private readonly developer: string;

  constructor(sessionId: string, developer: string) {
    this.sessionId = sessionId;
    this.developer = developer;
  }

  start(): void {
    if (this.span) return;
    this.span = getMcpTracer().startSpan('ai.coding.session', {
      attributes: {
        'ai.session.id': this.sessionId,
        'ai.developer': this.developer,
        'ai.platform': 'claude-code',
      },
    });
    logger.debug('Session span started', { sessionId: this.sessionId });
  }

  end(toolCallCount: number, taskCount: number): void {
    if (!this.span) return;
    this.span.setAttributes({
      'ai.session.tool_call_count': toolCallCount,
      'ai.session.task_count': taskCount,
    });
    this.span.setStatus({ code: SpanStatusCode.OK });
    this.span.end();
    this.span = null;
  }

  getSpan(): Span | null {
    return this.span;
  }

  getContext() {
    if (!this.span) return context.active();
    return trace.setSpan(context.active(), this.span);
  }
}
```

### 1c — `packages/nr-ai-mcp-server/src/tracing/tool-call-span.ts`

Emits a child span for each completed `ToolCallRecord`:

```typescript
import { SpanStatusCode, context, trace } from '@opentelemetry/api';
import type { ToolCallRecord } from '../storage/types.js';
import { getMcpTracer } from './mcp-tracer.js';
import { createLogger } from '@nr-ai-observatory/shared';

const logger = createLogger('tool-call-span');

export function emitToolCallSpan(
  record: ToolCallRecord,
  parentContext: ReturnType<typeof context.active>,
  taskId?: string,
): void {
  const tracer = getMcpTracer();
  const spanName = `mcp.tool.${record.toolName}`;

  const span = tracer.startSpan(
    spanName,
    {
      startTime: record.timestamp,
      attributes: {
        'mcp.tool.name': record.toolName,
        'mcp.tool.use_id': record.toolUseId,
        'ai.session.id': record.sessionId ?? '',
        'mcp.tool.success': record.success,
        ...(record.inputSizeBytes !== undefined && { 'mcp.tool.input_size_bytes': record.inputSizeBytes }),
        ...(record.outputSizeBytes !== undefined && { 'mcp.tool.output_size_bytes': record.outputSizeBytes }),
        ...(taskId && { 'ai.task.id': taskId }),
      },
    },
    parentContext,
  );

  if (record.durationMs !== null) {
    const endTime = record.timestamp + record.durationMs;
    if (!record.success) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: record.error ?? record.errorType ?? 'tool call failed' });
      if (record.error) span.recordException(new Error(record.error));
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end(endTime);
  } else {
    // Orphaned/timeout record — end immediately
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'orphaned tool call (no post event)' });
    span.end();
  }

  logger.debug('Tool call span emitted', { tool: record.toolName, success: record.success });
}
```

---

## Step 2 — Create `TaskSpanTracker`

Create `packages/nr-ai-mcp-server/src/tracing/task-span-tracker.ts`.

This class maintains a map of open task spans keyed by task ID. When `TaskDetector` signals a new task boundary, a task span is opened. When the task ends, the span is closed. Tool call spans are parented under the active task span when one is open, otherwise directly under the session span.

```typescript
import { type Span, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { getMcpTracer } from './mcp-tracer.js';
import { createLogger } from '@nr-ai-observatory/shared';

const logger = createLogger('task-span-tracker');

export class TaskSpanTracker {
  private readonly activeTasks: Map<string, Span> = new Map();

  openTask(taskId: string, label: string, parentContext: ReturnType<typeof context.active>): void {
    if (this.activeTasks.has(taskId)) return;
    const span = getMcpTracer().startSpan(`ai.task ${label}`, {
      attributes: {
        'ai.task.id': taskId,
        'ai.task.label': label,
      },
    }, parentContext);
    this.activeTasks.set(taskId, span);
    logger.debug('Task span opened', { taskId, label });
  }

  closeTask(taskId: string, toolCallCount: number): void {
    const span = this.activeTasks.get(taskId);
    if (!span) return;
    span.setAttributes({ 'ai.task.tool_call_count': toolCallCount });
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    this.activeTasks.delete(taskId);
    logger.debug('Task span closed', { taskId });
  }

  getContext(taskId: string | null, fallback: ReturnType<typeof context.active>): ReturnType<typeof context.active> {
    if (!taskId) return fallback;
    const span = this.activeTasks.get(taskId);
    if (!span) return fallback;
    return trace.setSpan(context.active(), span);
  }

  closeAll(): void {
    for (const [taskId, span] of this.activeTasks) {
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      logger.debug('Force-closed task span', { taskId });
    }
    this.activeTasks.clear();
  }

  get size(): number {
    return this.activeTasks.size;
  }
}
```

---

## Step 3 — Wire tracing into `index.ts`

All modifications in this step go into `packages/nr-ai-mcp-server/src/index.ts`. Do **not** modify `server.ts` — `NrMcpServer` is a thin shell that holds no tracker references, no sessionTraceId, and has no `start()`/`stop()` methods. All tracker instances and the `onRecord` callback live inside the `main()` function's `if (options.stdio)` block.

### 3a — Import and create session/task span infrastructure

Add the imports near the top of `index.ts`:

```typescript
import { initMcpTracer } from './tracing/mcp-tracer.js';
import { SessionSpan } from './tracing/session-span.js';
import { TaskSpanTracker } from './tracing/task-span-tracker.js';
import { emitToolCallSpan } from './tracing/tool-call-span.js';
```

Inside the `if (options.stdio)` block, after the line `const sessionTraceId = randomUUID();`, add:

```typescript
if (config.transport !== 'nr-events-api') {
  initMcpTracer();
}
const sessionSpan = new SessionSpan(sessionTraceId, config.developer);
const taskSpanTracker = new TaskSpanTracker();
if (config.transport !== 'nr-events-api') {
  sessionSpan.start();
}
```

Note: `sessionTraceId` and `config.developer` are local variables already available at this point in `main()`.

### 3b — Emit tool call spans in the `onRecord` callback

Inside the existing `onRecord` callback (the function passed to `new HookEventProcessor({ ..., onRecord: (record) => { ... } })`), add the following **before** the `taskDetector.recordToolCall(record)` call so the active task ID is captured before any boundary event fires:

```typescript
// Capture active task ID before recordToolCall may close the current task
const taskIdBeforeRecord = config.transport !== 'nr-events-api'
  ? taskDetector.getActiveTaskId()
  : null;
```

Then immediately after `taskDetector.recordToolCall(record)`, add the span emission and new-task detection:

```typescript
if (config.transport !== 'nr-events-api') {
  // Emit tool call span — parent is the active task span (or session span if no task)
  const activeTaskId = taskDetector.getActiveTaskId();
  const parentCtx = activeTaskId
    ? taskSpanTracker.getContext(activeTaskId, sessionSpan.getContext())
    : sessionSpan.getContext();
  emitToolCallSpan(record, parentCtx, activeTaskId ?? undefined);

  // Open a task span if a new task was started by this record
  if (activeTaskId !== null && activeTaskId !== taskIdBeforeRecord) {
    taskSpanTracker.openTask(activeTaskId, record.toolName, sessionSpan.getContext());
  }
}
```

### 3c — Close task spans when tasks complete

Inside the existing `for (const task of taskDetector.drainNewlyCompletedTasks())` loop (already present in `onRecord` around line 278), add the task span closure alongside the existing `capturedNrIngest.ingestCodingTask(task)` call:

```typescript
for (const task of taskDetector.drainNewlyCompletedTasks()) {
  capturedNrIngest.ingestCodingTask(task);
  taskCompletionTracker.recordTask(task);
  // Close the task span — this handles both signal-driven and idle-timer-driven closures
  if (config.transport !== 'nr-events-api') {
    taskSpanTracker.closeTask(task.taskId, task.toolCallCount);
  }
  // ... existing antiPatternDetector.analyze() code unchanged ...
}
```

This is the correct hook for task closures: `drainNewlyCompletedTasks()` fires for all close triggers including idle-timer-based ones, which happen asynchronously and cannot be caught by comparing before/after `getActiveTaskId()`.

### 3d — End session span on shutdown

In the `shutdown` async function in `main()`, add before `eventProcessor?.stop()`:

```typescript
if (config.transport !== 'nr-events-api') {
  taskSpanTracker.closeAll();
  const stats = sessionTracker.getMetrics();
  const taskMetrics = taskDetector.getMetrics();
  sessionSpan.end(stats.totalToolCalls, taskMetrics.totalTasksCompleted);
}
```

Note: the correct field is `taskMetrics.totalTasksCompleted` (from `TaskMetrics` interface), not `taskMetrics.detectedTaskCount`.

---

## Step 4 — Extend `TaskDetector` with active task access

In `packages/nr-ai-mcp-server/src/metrics/task-detector.ts`, add a `getActiveTaskId()` method that returns the current in-progress task's ID (or `null` if no task is active). Read the existing `TaskDetector` source before implementing to use the correct internal state field.

---

## Step 5 — Write tests

Create:

- `packages/nr-ai-mcp-server/src/tracing/mcp-tracer.test.ts` — init idempotency, getTracer returns non-null
- `packages/nr-ai-mcp-server/src/tracing/session-span.test.ts` — start/end lifecycle, end sets attributes
- `packages/nr-ai-mcp-server/src/tracing/tool-call-span.test.ts` — span attributes from record, error path sets ERROR status
- `packages/nr-ai-mcp-server/src/tracing/task-span-tracker.test.ts` — open/close lifecycle, closeAll, getContext fallback

For all tests, mock `getMcpTracer()` to return a mock tracer with a `startSpan` that returns a mock span object:

```typescript
const mockSpan = {
  setAttributes: jest.fn(),
  setStatus: jest.fn(),
  recordException: jest.fn(),
  end: jest.fn(),
};
const mockTracer = { startSpan: jest.fn(() => mockSpan) };
jest.mock('../tracing/mcp-tracer.js', () => ({ getMcpTracer: () => mockTracer }));
```

---

## Acceptance criteria

- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] When `transport === 'nr-events-api'`, `initMcpTracer()` is not called and no spans are emitted
- [ ] When OTLP is configured, each `ToolCallRecord` produces exactly one span via `emitToolCallSpan`
- [ ] Session span starts at server startup, ends at shutdown with `tool_call_count` and `task_count` attributes
- [ ] Task spans are opened when a task boundary is detected and closed when the task ends
- [ ] Tool call spans are children of the active task span (or session span when no task is active)
- [ ] Failed tool calls (record.success === false) set `SpanStatusCode.ERROR` and call `recordException`
- [ ] Orphaned tool call records (durationMs === null) produce an ERROR span that ends immediately
- [ ] `npm run lint` passes

---

## File checklist

Files to **create**:

```
packages/nr-ai-mcp-server/src/tracing/mcp-tracer.ts
packages/nr-ai-mcp-server/src/tracing/mcp-tracer.test.ts
packages/nr-ai-mcp-server/src/tracing/session-span.ts
packages/nr-ai-mcp-server/src/tracing/session-span.test.ts
packages/nr-ai-mcp-server/src/tracing/tool-call-span.ts
packages/nr-ai-mcp-server/src/tracing/tool-call-span.test.ts
packages/nr-ai-mcp-server/src/tracing/task-span-tracker.ts
packages/nr-ai-mcp-server/src/tracing/task-span-tracker.test.ts
```

Files to **modify**:

```
packages/nr-ai-mcp-server/package.json                 — add @opentelemetry/api dependency
packages/nr-ai-mcp-server/src/index.ts                 — wire session/task/tool-call spans
packages/nr-ai-mcp-server/src/metrics/task-detector.ts — add getActiveTaskId()
```
