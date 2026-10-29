import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, type FullSessionSummary } from '../storage/session-store.js';
import { LocalSessionAggregator, RepoNameResolver } from './local-session-aggregator.js';
import { ToolSelectionScorer } from './tool-selection-scorer.js';

const REAL_ID = 'a143754c-f742-40b7-bf1a-7dc01ad1932f';

class StubRepoResolver extends RepoNameResolver {
  override resolve(): string | null {
    return 'acme/widgets';
  }
}

function summariesOf(agg: LocalSessionAggregator): Array<Record<string, unknown>> {
  return agg.toSummaries({
    developer: 'tester',
    platform: 'copilot',
    outcome: 'in progress',
    repoResolver: new StubRepoResolver(),
    toolSelectionScorer: new ToolSelectionScorer(),
  });
}

function recordCopilotCall(agg: LocalSessionAggregator, costUsd: number): void {
  agg.recordToolCall({
    sessionId: REAL_ID,
    toolName: 'Read',
    timestamp: Date.now(),
    durationMs: 10,
    success: true,
    cwd: '/tmp/work',
  });
  agg.recordTokenUsage(REAL_ID, {
    timestamp: Date.now(),
    costUsd,
    model: 'claude-opus-4-7',
    inputTokens: 1000,
    outputTokens: 100,
  });
}

describe('LocalSessionAggregator durability gaps', () => {
  let storagePath: string;

  beforeEach(() => {
    storagePath = mkdtempSync(join(tmpdir(), 'agg-gap-'));
  });

  afterEach(() => {
    rmSync(storagePath, { recursive: true, force: true });
  });

  it('keeps the persisted session cost across a process restart', () => {
    const store = new SessionStore({ storagePath });

    const before = new LocalSessionAggregator({
      persistedCostBaseline: (id) => store.loadSession(id),
    });
    recordCopilotCall(before, 10);
    for (const s of summariesOf(before)) {
      store.saveSession(s as unknown as FullSessionSummary);
    }

    // Restarted process: it only sees usage drained after the restart.
    const after = new LocalSessionAggregator({
      persistedCostBaseline: (id) => store.loadSession(id),
    });
    recordCopilotCall(after, 2);
    for (const s of summariesOf(after)) {
      store.saveSession(s as unknown as FullSessionSummary);
    }

    expect(store.loadSession(REAL_ID)?.estimatedCostUsd).toBeCloseTo(12, 6);
  });
});
