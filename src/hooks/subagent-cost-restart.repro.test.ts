import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubagentWatcher } from './subagent-watcher.js';
import { HookEventProcessor, type SubagentTurnEvent } from './event-processor.js';
import { LocalStore } from '../storage/local-store.js';
import { CostTracker } from '../metrics/cost-tracker.js';
import { buildCostTrackerSeed } from '../metrics/cost-tracker-seed.js';
import type { FullSessionSummary } from '../storage/session-store.js';

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const AGENT_ID = 'a1234567890abcdef';
const STDERR_WRITE = process.stderr.write;

function subagentLine(messageId: string, contentType = 'text', outputTokens = 50): string {
  return JSON.stringify({
    type: 'assistant',
    agentId: AGENT_ID,
    uuid: `uuid-${messageId}-${contentType}`,
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID,
    isSidechain: true,
    message: {
      id: messageId,
      role: 'assistant',
      model: 'claude-opus-4-7',
      stop_reason: null,
      content: [{ type: contentType }],
      usage: {
        input_tokens: 100,
        output_tokens: outputTokens,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 200,
      },
    },
  });
}

function setMtime(path: string, secondsAgo: number): void {
  const t = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path, t, t);
}

describe('subagent cost across restart (repro)', () => {
  let storagePath: string;
  let projectsDir: string;
  let oldAgentPath: string;
  let newAgentPath: string;

  beforeEach(() => {
    process.stderr.write = jest.fn(() => true) as unknown as typeof process.stderr.write;
    storagePath = mkdtempSync(join(tmpdir(), 'sac-storage-'));
    projectsDir = mkdtempSync(join(tmpdir(), 'sac-projects-'));
    const oldSub = join(projectsDir, 'old-slug', SESSION_ID, 'subagents');
    const newSub = join(projectsDir, 'new-slug', SESSION_ID, 'subagents');
    mkdirSync(oldSub, { recursive: true });
    mkdirSync(newSub, { recursive: true });
    oldAgentPath = join(oldSub, `agent-${AGENT_ID}.jsonl`);
    newAgentPath = join(newSub, `agent-${AGENT_ID}.jsonl`);
  });

  afterEach(() => {
    process.stderr.write = STDERR_WRITE;
    rmSync(storagePath, { recursive: true, force: true });
    rmSync(projectsDir, { recursive: true, force: true });
  });

  function makeProcess(costTracker: CostTracker) {
    const turns: SubagentTurnEvent[] = [];
    const processor = new HookEventProcessor({
      store: new LocalStore(storagePath, SESSION_ID),
      pollIntervalMs: 10,
      onRecord: () => {},
      onSubagentTurn: (turn) => {
        turns.push(turn);
        costTracker.recordTokenUsage(
          {
            inputTokens: turn.inputTokens,
            outputTokens: turn.outputTokens,
            thinkingTokens: turn.reasoningTokens,
            cacheReadTokens: turn.cacheReadTokens,
            cacheCreationTokens: turn.cacheCreationTokens,
            totalTokens:
              turn.inputTokens +
              turn.outputTokens +
              turn.reasoningTokens +
              turn.cacheReadTokens +
              turn.cacheCreationTokens,
          },
          turn.model,
          { timestampMs: turn.timestampMs, agentId: turn.agentId, workflowRunId: null },
        );
      },
    });
    const watcher = new SubagentWatcher({
      storagePath,
      projectsDir,
      parentSessionId: SESSION_ID,
      pollIntervalMs: 10,
    });
    return { processor, watcher, turns };
  }

  /** One watcher poll, then one processor drain (start + synchronous final drain in stop). */
  function pump(p: ReturnType<typeof makeProcess>): void {
    p.watcher.poll();
    p.processor.start();
    p.processor.stop();
  }

  function persistedSummary(ct: CostTracker): FullSessionSummary {
    const m = ct.getMetrics();
    const now = Date.now();
    const modelBreakdown: Record<string, unknown> = {};
    for (const [model, usd] of Object.entries(m.costByModel)) {
      modelBreakdown[model] = { totalCostUsd: usd };
    }
    return {
      startTime: now - 60_000,
      endTime: now,
      estimatedCostUsd: m.sessionTotalCostUsd,
      subagentCostUsd: m.subagentCostUsd,
      tokensInput: m.totalInputTokens,
      tokensOutput: m.totalOutputTokens,
      tokensThinking: m.totalThinkingTokens,
      tokensCacheRead: m.totalCacheReadTokens,
      tokensCacheCreation: m.totalCacheCreationTokens,
      cacheSavingsUsd: m.totalCacheSavingsUsd,
      modelBreakdown,
      costByWorkflowRunId: {},
    } as unknown as FullSessionSummary;
  }

  function seededTracker(persisted: FullSessionSummary): CostTracker {
    const ct = new CostTracker();
    ct.seedFromPersisted(buildCostTrackerSeed(persisted));
    return ct;
  }

  it('control, no restart: a message whose second line lands after the first was counted is counted once', () => {
    writeFileSync(oldAgentPath, subagentLine('msg_M', 'text') + '\n');
    setMtime(oldAgentPath, 100);
    const cost = new CostTracker();
    const p = makeProcess(cost);
    pump(p);
    const oneMessageUsd = cost.getMetrics().subagentCostUsd;
    expect(oneMessageUsd).toBeGreaterThan(0);

    appendFileSync(oldAgentPath, subagentLine('msg_M', 'tool_use') + '\n');
    pump(p);

    expect(p.turns.length).toBe(1);
    expect(cost.getMetrics().subagentCostUsd).toBeCloseTo(oneMessageUsd, 10);
  });

  it('restart between line 1 and line 2 of one message: the message is not counted twice', () => {
    writeFileSync(oldAgentPath, subagentLine('msg_M', 'text') + '\n');
    setMtime(oldAgentPath, 100);
    const costA = new CostTracker();
    const a = makeProcess(costA);
    pump(a);
    const oneMessageUsd = costA.getMetrics().subagentCostUsd;
    expect(a.turns.length).toBe(1);
    const persisted = persistedSummary(costA);

    // Process A dies after reading line 1. Claude Code then writes line 2 of the same message.
    appendFileSync(oldAgentPath, subagentLine('msg_M', 'tool_use') + '\n');

    const costB = seededTracker(persisted);
    const b = makeProcess(costB);
    pump(b);

    expect(b.turns.length).toBe(0);
    expect(costB.getMetrics().subagentCostUsd).toBeCloseTo(oneMessageUsd, 10);
  });

  it('restart after the canonical transcript moved to a new project dir: turns are not re-counted', () => {
    writeFileSync(oldAgentPath, subagentLine('msg_1') + '\n' + subagentLine('msg_2') + '\n');
    setMtime(oldAgentPath, 100);
    const costA = new CostTracker();
    const a = makeProcess(costA);
    pump(a);
    const countedUsd = costA.getMetrics().subagentCostUsd;
    expect(a.turns.length).toBe(2);
    const persisted = persistedSummary(costA);

    // Repo rename: the new project dir holds the same history, newer mtime.
    writeFileSync(newAgentPath, subagentLine('msg_1') + '\n' + subagentLine('msg_2') + '\n');
    setMtime(newAgentPath, 1);

    const costB = seededTracker(persisted);
    const b = makeProcess(costB);
    pump(b);

    expect(costB.getMetrics().subagentCostUsd).toBeCloseTo(countedUsd, 10);
  });

  it('in-process canonical switch with more than 4096 messages: no message is counted twice', () => {
    const N = 4097;
    const body = Array.from({ length: N }, (_, i) => subagentLine(`msg_${i}`) + '\n').join('');
    writeFileSync(oldAgentPath, body);
    setMtime(oldAgentPath, 100);
    const cost = new CostTracker();
    const p = makeProcess(cost);
    for (let i = 0; i < 200 && p.turns.length < N; i++) pump(p);
    expect(p.turns.length).toBe(N);
    const countedUsd = cost.getMetrics().subagentCostUsd;

    writeFileSync(newAgentPath, body);
    setMtime(newAgentPath, 1);
    for (let i = 0; i < 200; i++) pump(p);

    expect(cost.getMetrics().subagentCostUsd).toBeCloseTo(countedUsd, 10);
  });

  it('restart with a truncated (torn) cursor file: turns are not re-counted', () => {
    writeFileSync(oldAgentPath, subagentLine('msg_1') + '\n' + subagentLine('msg_2') + '\n');
    setMtime(oldAgentPath, 100);
    const costA = new CostTracker();
    const a = makeProcess(costA);
    pump(a);
    const countedUsd = costA.getMetrics().subagentCostUsd;
    expect(a.turns.length).toBe(2);
    const persisted = persistedSummary(costA);

    const cursorFiles = readdirSync(storagePath).filter((n) => n.startsWith('.subagent-pos-'));
    expect(cursorFiles).toHaveLength(1);
    // A SIGKILL between truncate and write of the cursor leaves an empty file.
    writeFileSync(join(storagePath, cursorFiles[0]!), '');

    const costB = seededTracker(persisted);
    const b = makeProcess(costB);
    pump(b);

    expect(costB.getMetrics().subagentCostUsd).toBeCloseTo(countedUsd, 10);
  });
});
