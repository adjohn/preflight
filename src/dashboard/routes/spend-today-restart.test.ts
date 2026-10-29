import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApiHandler } from './api-handler.js';
import { CostTracker } from '../../metrics/cost-tracker.js';
import { buildCostTrackerSeed } from '../../metrics/cost-tracker-seed.js';
import { localDateKey, localStartOfDay } from '../../lib/date.js';
import { makeUsage } from '../../__test-utils__/token-usage.js';
import type { FullSessionSummary } from '../../storage/session-store.js';

const NOON = new Date(2026, 9, 29, 12, 0, 0).getTime();
const TODAY_KEY = localDateKey(NOON);
const YESTERDAY_KEY = localDateKey(NOON - 86_400_000);
const DAY_START = localStartOfDay(NOON);
const HOUR = 3_600_000;

function fakeRes(): {
  res: ServerResponse;
  status: () => number;
  body: () => string;
} {
  let status = 0;
  let body = '';
  const res = {
    writeHead: (s: number) => {
      status = s;
    },
    setHeader: () => {},
    end: (chunk?: string | Buffer) => {
      if (chunk) body += chunk.toString();
    },
    headersSent: false,
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}

function summary(overrides: Record<string, unknown>): FullSessionSummary {
  return {
    sessionId: 'resumed-1',
    startTime: DAY_START - 2 * HOUR,
    endTime: DAY_START + 2 * HOUR,
    estimatedCostUsd: 10,
    subagentCostUsd: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensThinking: 0,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
    cacheSavingsUsd: 0,
    modelBreakdown: {},
    costByWorkflowRunId: {},
    timeline: [],
    toolCallCount: 0,
    ...overrides,
  } as unknown as FullSessionSummary;
}

function seedFor(persisted: FullSessionSummary): CostTracker {
  const tracker = new CostTracker();
  tracker.seedFromPersisted(buildCostTrackerSeed(persisted));
  return tracker;
}

describe('Spend Today across a restart (real CostTracker + buildCostTrackerSeed)', () => {
  beforeEach(() => {
    jest.useFakeTimers({
      now: NOON,
      doNotFake: ['setTimeout', 'setInterval', 'setImmediate', 'nextTick', 'queueMicrotask'],
    });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('a session resumed the next day books nothing to today (yesterday-only activity)', () => {
    const persisted = summary({
      startTime: DAY_START - 26 * HOUR,
      endTime: DAY_START - 2 * HOUR,
      estimatedCostUsd: 7,
      timeline: Array.from({ length: 5 }, (_, i) => ({
        timestamp: DAY_START - 10 * HOUR + i * 1000,
        durationMs: null,
        toolName: 'Read',
      })),
    });
    const tracker = seedFor(persisted);
    expect(tracker.getCostForDay(TODAY_KEY)).toBe(0);
    expect(tracker.getMetrics().sessionTotalCostUsd).toBeCloseTo(7, 6);
  });

  it('seeds today cost from the persisted exact today-bucket, not a timeline pro-rate', () => {
    const persisted = summary({
      startTime: DAY_START - 2 * HOUR,
      endTime: DAY_START + 2 * HOUR,
      estimatedCostUsd: 10,
      costByDayUsd: { [YESTERDAY_KEY]: 8, [TODAY_KEY]: 2 },
      timeline: [
        ...Array.from({ length: 9 }, (_, i) => ({
          timestamp: DAY_START - 90 * 60_000 + i * 1000,
          durationMs: null,
          toolName: 'Read',
        })),
        { timestamp: DAY_START + 60 * 60_000, durationMs: null, toolName: 'Read' },
      ],
    });
    const tracker = seedFor(persisted);
    expect(tracker.getCostForDay(TODAY_KEY)).toBeCloseTo(2, 6);
  });

  it('seeds today subagent cost from the persisted exact today-bucket, not a ratio', () => {
    const persisted = summary({
      startTime: DAY_START - 2 * HOUR,
      endTime: DAY_START + 2 * HOUR,
      estimatedCostUsd: 10,
      subagentCostUsd: 4,
      costByDayUsd: { [YESTERDAY_KEY]: 8, [TODAY_KEY]: 2 },
      subagentCostByDayUsd: { [YESTERDAY_KEY]: 3.5, [TODAY_KEY]: 0.5 },
      timeline: [
        ...Array.from({ length: 9 }, (_, i) => ({
          timestamp: DAY_START - 90 * 60_000 + i * 1000,
          durationMs: null,
          toolName: 'Read',
        })),
        { timestamp: DAY_START + 60 * 60_000, durationMs: null, toolName: 'Read' },
      ],
    });
    const tracker = seedFor(persisted);
    expect(tracker.getSubagentCostForDay(TODAY_KEY)).toBeCloseTo(0.5, 6);
  });

  it('dashboard Spend Today counts a live session that already has a checkpoint today', async () => {
    const costTracker = new CostTracker();
    costTracker.recordTokenUsage(
      makeUsage({ inputTokens: 200_000, outputTokens: 20_000, totalTokens: 220_000 }),
      'claude-sonnet-4',
      { timestampMs: NOON - 60_000 },
    );
    const liveCost = costTracker.getMetrics().sessionTotalCostUsd ?? 0;
    expect(liveCost).toBeGreaterThan(0);

    const checkpoint = summary({
      sessionId: 'live-1',
      startTime: DAY_START + HOUR,
      endTime: NOON - 60_000,
      estimatedCostUsd: liveCost,
      costByDayUsd: { [TODAY_KEY]: liveCost },
      timeline: [],
    });

    const handler = createApiHandler({
      localStore: { peekAllBuffers: () => [] },
      sessionStore: {
        loadTodaySessions: () => [checkpoint],
        loadSessionsOverlappingToday: () => [checkpoint],
        listSessions: () => [],
        loadSession: () => null,
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionStore'],
      sessionTracker: {
        getMetrics: () => ({ sessionId: 'live-1', sessionStartTime: DAY_START + HOUR }),
      } as unknown as Parameters<typeof createApiHandler>[0]['sessionTracker'],
      costTracker,
    });
    const req = { method: 'GET', url: '/api/sessions/today/aggregate' } as IncomingMessage;
    const { res, status, body } = fakeRes();
    await handler(req, res);
    expect(status()).toBe(200);
    const parsed = JSON.parse(body()) as { totalCostUsd: number };
    expect(parsed.totalCostUsd).toBeCloseTo(liveCost, 6);
  });
});
