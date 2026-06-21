# Subagent Attribution Tracking

Track which tool calls and token costs originate from spawned subagents vs. the parent agent, with per-subagent cost breakdown and depth-aware NR events.

---

## Problem Statement

All tool calls in a session — whether made by the parent agent or any spawned subagent — arrive at the hook processor with the same `session_id` and no ancestry metadata. The `Agent` tool call itself is tracked (with `subagentType`, `description`, etc.), but the hundreds of Read/Bash/Edit calls the subagent makes are indistinguishable from parent-agent work.

**What's missing:**

- Which tool calls belong to which subagent
- Per-subagent cost breakdown
- Nesting depth on NR events (enables NRQL `FACET agent_depth`)
- Total cost attributable to subagented work vs. parent work

---

## Data Model Changes

### `ToolCallRecord` (src/storage/types.ts)

Add three optional fields:

```typescript
export interface ToolCallRecord {
  // ... existing fields ...
  readonly agentDepth?: number; // 0 = parent, 1 = subagent, 2 = sub-subagent
  readonly parentAgentId?: string; // toolUseId of the spawning Agent call; null at depth 0
  readonly agentAttributionMode?: 'exact' | 'best-effort' | 'ambiguous';
}
```

`agentAttributionMode` documents how confident the attribution is:

- `exact` — sequential agent; depth stack was unambiguous
- `best-effort` — background agent; only one was active at the time
- `ambiguous` — background agent; multiple were active simultaneously

Records without these fields are parent-level calls (backward-compatible: all existing records implicitly have `agentDepth: 0`).

### `AiToolCall` NR event (src/shared/events/ — requires upstream sync)

Two new fields emitted by `toolCallToNrEvent()` in `nr-ingest.ts`:

```
agent_depth       integer   0 = parent, 1 = subagent, ...
parent_agent_id   string    tool_use_id of the spawning Agent call (absent at depth 0)
attribution_mode  string    'exact' | 'best-effort' | 'ambiguous'
```

These go through the existing `for (const [key, value] of Object.entries(record))` loop in `toolCallToNrEvent`, so no changes to `nr-ingest.ts` are needed once the record carries the fields — the loop already forwards numeric and string values. The upstream schema documentation in `nr-ai-typescript-shared` still needs updating.

---

## Phase 1 — Sequential Agent Attribution

**Target:** non-background `Agent` tool calls (`run_in_background` absent or `false`).

### Mechanism: depth stack in `HookEventProcessor`

Add a private stack to `HookEventProcessor` that tracks in-flight sequential Agent calls:

```typescript
interface AgentFrame {
  readonly toolUseId: string;
  readonly subagentType?: string;
  readonly startTimestamp: number;
}

private readonly agentStack: AgentFrame[] = [];
```

**`handlePreEvent` — when tool is `Agent` and `runInBackground` is falsy:**

```typescript
if (event.tool === 'Agent' && !event.runInBackground) {
  this.agentStack.push({
    toolUseId: event.toolUseId as string,
    subagentType: event.subagentType as string | undefined,
    startTimestamp: event.timestamp,
  });
}
```

**`handlePostEvent` — when completing an `Agent` pair:**

```typescript
if (preEvent.tool === 'Agent' && !preEvent.runInBackground) {
  this.agentStack.pop();
}
```

**All other tool records** — after building the `ToolCallRecord`, inject depth fields:

```typescript
if (this.agentStack.length > 0) {
  const frame = this.agentStack[this.agentStack.length - 1];
  Object.assign(record, {
    agentDepth: this.agentStack.length,
    parentAgentId: frame.toolUseId,
    agentAttributionMode: 'exact',
  });
}
```

`Object.assign` is safe here because `record` is being constructed (not yet frozen). The `ToolCallRecord` type allows `readonly` because consumers receive it after assignment; the pre-emit mutation is fine within the processor.

### Stack integrity on orphan/timeout

When a sequential Agent pre-event is swept as an orphan (subagent never completed), it would leave a stale frame on the stack. In `sweepOrphans()` and `flushPending()`, after emitting an orphan Agent record, pop any corresponding frame:

```typescript
if (event.tool === 'Agent' && !event.runInBackground) {
  const idx = this.agentStack.findIndex((f) => f.toolUseId === key);
  if (idx !== -1) this.agentStack.splice(idx, 1);
}
```

### Sub-subagents

No special handling required. If a subagent itself spawns an Agent, the pre-event pushes another frame onto the stack (`length` becomes 2), giving nested tool calls `agentDepth: 2`. Fully recursive.

---

## Phase 2 — Background Agent Attribution

**Target:** `run_in_background: true` Agent tool calls. These are harder because the parent continues running tool calls concurrently with the background agent.

### Mechanism: active window map

Add a separate map of in-flight background Agent calls:

```typescript
interface BackgroundAgentWindow {
  readonly toolUseId: string;
  readonly subagentType?: string;
  readonly startTimestamp: number;
}

private readonly backgroundAgents: Map<string, BackgroundAgentWindow> = new Map();
```

**`handlePreEvent` — when `runInBackground` is true:**

```typescript
if (event.tool === 'Agent' && event.runInBackground) {
  this.backgroundAgents.set(event.toolUseId as string, {
    toolUseId: event.toolUseId as string,
    subagentType: event.subagentType as string | undefined,
    startTimestamp: event.timestamp,
  });
}
```

**`handlePostEvent` — when completing a background `Agent` pair:**

```typescript
if (preEvent.tool === 'Agent' && preEvent.runInBackground) {
  this.backgroundAgents.delete(preEvent.toolUseId as string);
}
```

**All other tool records** — when `agentStack` is empty (not inside a sequential agent), check the background window map:

```typescript
if (this.agentStack.length === 0 && this.backgroundAgents.size > 0) {
  if (this.backgroundAgents.size === 1) {
    const [frame] = this.backgroundAgents.values();
    Object.assign(record, {
      agentDepth: 1,
      parentAgentId: frame.toolUseId,
      agentAttributionMode: 'best-effort',
    });
  } else {
    // Multiple background agents active — can't attribute
    Object.assign(record, {
      agentDepth: 1,
      parentAgentId: 'ambiguous',
      agentAttributionMode: 'ambiguous',
    });
  }
}
```

**Why "best-effort" is still useful even when ambiguous:** even `agentDepth: 1` with `attribution_mode = 'ambiguous'` lets you filter out subagent overhead from parent cost totals (via `WHERE agent_depth = 0`) and see the relative proportion of subagented work over time.

### Background agent window cleanup

If a background Agent pre-event is swept as an orphan, remove it from `backgroundAgents`:

```typescript
if (event.tool === 'Agent' && event.runInBackground) {
  this.backgroundAgents.delete(key);
}
```

---

## Phase 3 — Token Attribution

Token events (`mode: 'token'`) are written to the buffer by the hook collector and processed by `handleTokenEvent`. They carry no agent ancestry — the collector fires once per PostToolUse and extracts the latest assistant entry from the transcript.

### Approach

Enrich `TokenEvent` with the same depth fields before passing to `onTokenEvent`:

```typescript
// In handleTokenEvent, after constructing tokenEvent:
if (this.agentStack.length > 0) {
  const frame = this.agentStack[this.agentStack.length - 1];
  Object.assign(tokenEvent, {
    agentDepth: this.agentStack.length,
    parentAgentId: frame.toolUseId,
    agentAttributionMode: 'exact',
  });
} else if (this.backgroundAgents.size === 1) {
  const [frame] = this.backgroundAgents.values();
  Object.assign(tokenEvent, {
    agentDepth: 1,
    parentAgentId: frame.toolUseId,
    agentAttributionMode: 'best-effort',
  });
}
```

`TokenEvent` in `src/storage/types.ts` gets the same three optional fields as `ToolCallRecord`.

### Cost tracker consumption

`CostTracker` (and `TurnCostAttributor`) already receive `TokenEvent`. They can split accumulation:

```typescript
// Existing: totalCostUsd accumulated from all token events
// New:
parentCostUsd: number; // agentDepth === 0 or undefined
subagentCostUsd: number; // agentDepth >= 1
subagentCostByType: Map<string, number>; // keyed by parentAgentId
```

---

## Phase 4 — CostTracker and Session Metrics

### `src/metrics/cost-tracker.ts`

New fields on `CostMetrics`:

```typescript
readonly parentCostUsd: number;
readonly subagentCostUsd: number;
readonly subagentCostByAgentId: Record<string, number>;
readonly subagentCostByType: Record<string, number>;  // keyed by subagentType
```

In `recordToolCall()`, check `record.agentDepth` to route costs to the right accumulator.

In `recordTokens()`, same check on `event.agentDepth`.

### `src/metrics/session-tracker.ts`

New summary fields:

```typescript
readonly subagentToolCallCount: number;
readonly subagentToolCallFraction: number;  // 0–1
readonly uniqueSubagentsSpawned: number;    // distinct parentAgentId values seen
```

---

## Phase 5 — MCP Tool Surface

### Existing tool update: `nr_observe_get_cost_breakdown`

Append a `subagentBreakdown` section to the existing response:

```json
{
  "subagentBreakdown": {
    "parentCostUsd": 0.012,
    "subagentCostUsd": 0.031,
    "subagentFraction": 0.72,
    "byType": {
      "Explore": 0.018,
      "code-reviewer": 0.013
    }
  }
}
```

### New tool: `nr_observe_get_subagent_breakdown`

Full subagent attribution report for the current session:

```typescript
server.tool('nr_observe_get_subagent_breakdown', {}, () => {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          totalAgentsSpawned: N,
          sequentialAgents: N,
          backgroundAgents: N,
          agents: [
            {
              toolUseId: 'abc123',
              subagentType: 'Explore',
              toolCallCount: 47,
              estimatedCostUsd: 0.018,
              durationMs: 12400,
              attributionMode: 'exact',
            },
            // ...
          ],
          attributionCoverage: {
            exactPct: 0.85,
            bestEffortPct: 0.1,
            ambiguousPct: 0.05,
          },
        }),
      },
    ],
  };
});
```

Register in `src/tools/cost-tools.ts` alongside the existing cost tools.

---

## Phase 6 — Shared Events Schema (Upstream Sync Required)

The three new NR event fields (`agent_depth`, `parent_agent_id`, `attribution_mode`) need documenting in `nr-ai-typescript-shared`. No code change is needed in `nr-ingest.ts` — the existing open-ended loop in `toolCallToNrEvent` already forwards all string/number/boolean fields from the record. But the upstream schema doc and any event-type validation should reflect the new fields.

Steps:

1. Add field docs to the `AiToolCall` schema in `nr-ai-typescript-shared`
2. Run `npm run sync:shared` in this repo
3. Update `src/shared/events/types.ts` if it contains a typed `AiToolCall` interface

---

## Implementation Sequence

| Step | File(s)                                                                    | Complexity        | Blocked by   |
| ---- | -------------------------------------------------------------------------- | ----------------- | ------------ |
| 1    | `src/storage/types.ts` — add 3 fields to `ToolCallRecord` and `TokenEvent` | Trivial           | —            |
| 2    | `src/hooks/event-processor.ts` — sequential stack (Phase 1)                | Small (~50 lines) | Step 1       |
| 3    | `src/hooks/event-processor.ts` — background window map (Phase 2)           | Small (~40 lines) | Step 2       |
| 4    | `src/hooks/event-processor.ts` — token attribution (Phase 3)               | Trivial           | Step 3       |
| 5    | `src/metrics/cost-tracker.ts` — split parent/subagent accumulators         | Small (~30 lines) | Step 1       |
| 6    | `src/metrics/session-tracker.ts` — subagent summary fields                 | Trivial           | Step 1       |
| 7    | `src/tools/cost-tools.ts` — update `nr_observe_get_cost_breakdown`         | Small             | Step 5       |
| 8    | `src/tools/cost-tools.ts` — add `nr_observe_get_subagent_breakdown`        | Small (~60 lines) | Steps 5–6    |
| 9    | `nr-ai-typescript-shared` — schema docs + `npm run sync:shared`            | Trivial           | Step 8 ships |

Steps 1–8 are entirely local. Step 9 is a follow-on sync PR.

---

## Testing Strategy

### Unit tests — event processor

`src/hooks/event-processor.test.ts` additions:

- Sequential: pre Agent → pre Read → post Read → post Agent emits Read with `agentDepth:1`, Agent with `agentDepth:0`
- Sub-subagent: nested Agent calls produce `agentDepth:2` on the innermost tool calls
- Orphan cleanup: orphaned sequential Agent pre-event clears the stack frame; subsequent records are `agentDepth:0`
- Background single: one background Agent active → subsequent tool call is `best-effort, depth:1`
- Background multiple: two background agents active → tool call is `ambiguous, depth:1`
- Background + sequential: both active → sequential takes precedence (stack check runs first)
- No agents active: records have no depth fields (backward-compatible)

### Unit tests — cost tracker

`src/metrics/cost-tracker.test.ts` additions:

- Token events with `agentDepth:1` accumulate to `subagentCostUsd`, not `parentCostUsd`
- `subagentCostByType` groups correctly when `parentAgentId` is consistent across events

---

## NRQL Examples (post-launch)

```sql
-- Parent vs subagent cost split for the last 7 days
SELECT sum(estimated_cost_usd) FROM AiCodingTask
FACET cases(WHERE agent_depth = 0 AS 'parent', WHERE agent_depth > 0 AS 'subagent')
SINCE 7 days ago

-- Subagent type cost breakdown
SELECT sum(estimated_cost_usd) FROM AiToolCall
WHERE agent_depth = 1
FACET subagentType
SINCE 7 days ago

-- Sessions with high subagent cost fraction
SELECT session_id, sum(estimated_cost_usd) AS total,
  filter(sum(estimated_cost_usd), WHERE agent_depth > 0) AS subagent_cost
FROM AiToolCall FACET session_id SINCE 1 day ago

-- Attribution quality over time
SELECT percentage(count(*), WHERE attribution_mode = 'exact') AS exact_pct,
  percentage(count(*), WHERE attribution_mode = 'ambiguous') AS ambiguous_pct
FROM AiToolCall WHERE agent_depth > 0 SINCE 30 days ago TIMESERIES 1 day
```

---

## Known Limitations

1. **Claude Code provides no explicit ancestry metadata.** All attribution is inferred from ordering and timing. This is correct for sequential agents and best-effort for background agents. If Claude Code adds a `parent_tool_use_id` field to hook payloads in the future, Phase 2 can be replaced with a direct lookup — the data model already has `parentAgentId`.

2. **Worktree-isolated agents** (`isolation: 'worktree'`) have a different `cwd`. Token extraction uses `transcript_path` from the hook payload (the authoritative field) rather than deriving it from `cwd`, so token capture should still work. Attribution is handled by the event processor stack and is unaffected by `cwd`.

3. **Background agents spanning multiple poll cycles.** The `backgroundAgents` map persists across poll cycles (it's private instance state), so a background agent that runs for several seconds across many buffer drains is correctly tracked.

4. **`drainAllSessions` mode** (`--local` dashboard). In this mode, events from multiple Claude Code sessions are mixed. The agent stack/background map is per-`HookEventProcessor` instance, and in `--local` mode a single processor handles all sessions. A sequential Agent call in session A could overlap with a tool call in session B, producing incorrect depth attribution. Mitigation: partition depth tracking by `sessionId` (wrap `agentStack` and `backgroundAgents` in `Map<sessionId, ...>`) as a follow-on enhancement.
