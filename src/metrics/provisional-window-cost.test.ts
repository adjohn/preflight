import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CostTracker } from './cost-tracker.js';
import { buildCostTrackerSeed } from './cost-tracker-seed.js';
import { LocalSessionAggregator, RepoNameResolver } from './local-session-aggregator.js';
import { ToolSelectionScorer } from './tool-selection-scorer.js';
import { isTokenEventForThisProcess } from './cost-estimate-gate.js';
import { makeUsage } from '../__test-utils__/token-usage.js';
import { ZERO_QUALITY_PROXY_COUNTS } from './quality-proxy-tracker.js';
import { SessionStore, type FullSessionSummary } from '../storage/session-store.js';

const MODEL = 'claude-sonnet-4-20250514';
const PENDING_ID = 'pending-1700000000000';
const REAL_ID = 'real-session-a';
const PERSISTED_PRIOR_USD = 5;
const PENDING_WINDOW_USD = 0.02;

function summaryFor(sessionId: string, overrides: Partial<FullSessionSummary>): FullSessionSummary {
  const now = Date.now();
  return {
    sessionId,
    sessionName: 'repo',
    sessionNameSource: null,
    sessionIntent: null,
    repoName: null,
    startTime: now - 60_000,
    endTime: now,
    durationMs: 60_000,
    toolCallCount: 3,
    developer: 'alice',
    model: MODEL,
    toolBreakdown: {},
    skillBreakdown: {},
    filesRead: [],
    filesModified: [],
    linesAdded: 0,
    linesRemoved: 0,
    bashCommandCount: 0,
    testRunCount: 0,
    testPassCount: 0,
    buildRunCount: 0,
    buildPassCount: 0,
    estimatedCostUsd: PERSISTED_PRIOR_USD,
    subagentCostUsd: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensThinking: 0,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
    cacheSavingsUsd: 0,
    efficiencyScore: null,
    toolSelectionMetrics: null,
    modelBreakdown: {},
    costByWorkflowRunId: {},
    qualityProxy: { ...ZERO_QUALITY_PROXY_COUNTS },
    antiPatterns: [],
    taskCount: 1,
    taskSuccessRate: null,
    toolSuccessRate: null,
    contextCompressions: 0,
    agentSpawns: 0,
    userMessages: 0,
    assistantMessages: 0,
    userCorrections: 0,
    outcome: 'in progress',
    ...overrides,
  } as unknown as FullSessionSummary;
}

let tmpDir: string;
let store: SessionStore;

beforeEach(() => {
  tmpDir = mkdtempSync(resolve(tmpdir(), 'provisional-cost-'));
  store = new SessionStore({ storagePath: tmpDir });
  store.saveSession(summaryFor(REAL_ID, {}));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Mirrors the pending-window branch of src/index.ts: the stdio process owns
// PENDING_ID, drains REAL_ID's token event through the unscoped LocalStore,
// prices it (onTokenEvent, index.ts ~2363-2395), and the synthetic-owner
// persistSession branch writes the aggregator's rollups (index.ts ~2679-2700).
function drainPendingWindowEvent(aggregator: LocalSessionAggregator, timestamp: number): number {
  aggregator.recordToolCall({ sessionId: REAL_ID, toolName: 'Read', timestamp });
  const isOwn = isTokenEventForThisProcess({
    stdio: true,
    eventSessionId: REAL_ID,
    ownSessionId: PENDING_ID,
  });
  expect(isOwn).toBe(false);
  aggregator.recordTokenUsage(REAL_ID, {
    timestamp,
    costUsd: PENDING_WINDOW_USD,
    model: MODEL,
    inputTokens: 3_333,
    outputTokens: 0,
  });
  return PENDING_WINDOW_USD;
}

function persistPendingRollups(aggregator: LocalSessionAggregator): void {
  for (const rollup of aggregator.toSummaries({
    developer: 'alice',
    outcome: 'in progress',
    repoResolver: new RepoNameResolver(),
    toolSelectionScorer: new ToolSelectionScorer(),
  })) {
    store.saveSession(rollup as unknown as FullSessionSummary);
  }
}

describe('cost recorded under a provisional id, then adopted as the real id', () => {
  it('writes the pending-window cost for the real session before adoption', () => {
    const aggregator = new LocalSessionAggregator({
      persistedCostBaseline: (id) => store.loadSession(id),
    });
    drainPendingWindowEvent(aggregator, Date.now());
    persistPendingRollups(aggregator);

    expect(store.loadSession(REAL_ID)!.estimatedCostUsd).toBeCloseTo(
      PERSISTED_PRIOR_USD + PENDING_WINDOW_USD,
      6,
    );
  });

  it('keeps the pending-window cost in the total after adoption and a later checkpoint', () => {
    const aggregator = new LocalSessionAggregator({
      persistedCostBaseline: (id) => store.loadSession(id),
    });
    const pendingUsd = drainPendingWindowEvent(aggregator, Date.now());
    persistPendingRollups(aggregator);

    const costTracker = new CostTracker();
    costTracker.seedFromPersisted(buildCostTrackerSeed(store.loadSession(REAL_ID)!));
    const after = costTracker.recordTokenUsage(makeUsage({ inputTokens: 3_333 }), MODEL, {
      timestampMs: Date.now(),
    });
    store.saveSession(
      summaryFor(REAL_ID, {
        estimatedCostUsd: costTracker.getMetrics().sessionTotalCostUsd,
        outcome: 'in progress',
      }),
    );

    expect(store.loadSession(REAL_ID)!.estimatedCostUsd).toBeCloseTo(
      PERSISTED_PRIOR_USD + pendingUsd + after.totalUsd,
      6,
    );
  });

  it('does not add pending-window token cost to the live CostTracker before adoption', () => {
    const costTracker = new CostTracker();
    const isOwn = isTokenEventForThisProcess({
      stdio: true,
      eventSessionId: REAL_ID,
      ownSessionId: PENDING_ID,
    });
    if (isOwn) {
      costTracker.recordTokenUsage(makeUsage({ inputTokens: 3_333 }), MODEL, {
        timestampMs: Date.now(),
      });
    }
    expect(costTracker.getMetrics().sessionTotalCostUsd ?? 0).toBe(0);
  });
});

describe('PPID correction from one real id to another', () => {
  it('does not carry the first id in-memory cost into the corrected id persisted total', () => {
    store.saveSession(summaryFor('real-session-b', { estimatedCostUsd: 2 }));

    const costTracker = new CostTracker();
    costTracker.recordTokenUsage(makeUsage({ inputTokens: 3_333 }), MODEL, {
      timestampMs: Date.now(),
    });
    expect(costTracker.getMetrics().sessionTotalCostUsd ?? 0).toBeGreaterThan(0);

    // Mirrors adoptRealSessionId({ isCorrection: true }) at src/index.ts ~2968-2974 and
    // rehydrateTrackersIfResumed at src/index.ts ~1411-1418.
    costTracker.reset('real-session-b');
    costTracker.seedFromPersisted(buildCostTrackerSeed(store.loadSession('real-session-b')!));

    expect(costTracker.getMetrics().sessionTotalCostUsd).toBeCloseTo(2, 6);
  });
});
