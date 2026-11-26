import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { HomelabAccumulator } from './homelab-accumulator.js';
import { SessionStore, deserializeFullSessionSummary } from '../storage/session-store.js';
import type { FullSessionSummary } from '../storage/session-store.js';
import type { ToolCallRecord } from '../storage/types.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;
let tmpDir: string;

beforeEach(() => {
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  tmpDir = mkdtempSync(resolve(tmpdir(), 'homelab-acc-test-'));
});

afterEach(() => {
  stderrSpy.mockRestore();
  rmSync(tmpDir, { recursive: true, force: true });
  jest.useRealTimers();
});

function makeRecord(n: number, tool = 'Read'): ToolCallRecord {
  return {
    id: `id-${n}`,
    sessionId: 'session-abc',
    toolName: tool,
    toolUseId: `u-${n}`,
    timestamp: 1_700_000_000_000 + n * 1000,
    durationMs: 10,
    success: true,
  };
}

function records(from: number, count: number, tool = 'Read'): ToolCallRecord[] {
  return Array.from({ length: count }, (_, i) => makeRecord(from + i, tool));
}

function runServer(...batches: ToolCallRecord[][]): void {
  const acc = new HomelabAccumulator({ storagePath: tmpDir });
  for (const batch of batches) {
    expect(acc.handleIngest({ developer: 'alice', sessionId: 'session-abc', records: batch })).toBe(
      'ok',
    );
  }
  acc.stop();
}

function saved(): FullSessionSummary | null {
  return new SessionStore({ storagePath: tmpDir }).loadSession('session-abc');
}

function writeOlderBuildFile(fields: Record<string, unknown>): void {
  const dir = new SessionStore({ storagePath: tmpDir }).getSessionsDir();
  mkdirSync(dir, { recursive: true });
  const day = new Date(makeRecord(0).timestamp).toISOString().slice(0, 10);
  const startTime = makeRecord(0).timestamp;
  const file = { sessionId: 'session-abc', developer: 'alice', startTime, ...fields };
  writeFileSync(resolve(dir, `${day}_session-abc.json`), JSON.stringify(file));
}

function shareOf(calls: readonly ToolCallRecord[]): FullSessionSummary {
  const toolBreakdown: Record<string, number> = {};
  for (const c of calls) toolBreakdown[c.toolName] = (toolBreakdown[c.toolName] ?? 0) + 1;
  return deserializeFullSessionSummary({
    sessionId: 'session-abc',
    startTime: calls[0].timestamp,
    endTime: calls[calls.length - 1].timestamp,
    toolCallCount: calls.length,
    toolBreakdown,
    bashCommandCount: toolBreakdown.Bash ?? 0,
    timeline: calls.map(({ timestamp, toolName, toolUseId, durationMs, success }) => ({
      timestamp,
      toolName,
      toolUseId,
      durationMs,
      success,
    })),
  } as Parameters<typeof deserializeFullSessionSummary>[0]);
}

describe('HomelabAccumulator', () => {
  it('returns invalid for missing developer', () => {
    const acc = new HomelabAccumulator({ storagePath: tmpDir });
    const result = acc.handleIngest({ developer: '', sessionId: 'abc123', records: [] });
    expect(result).toBe('invalid');
  });

  it('returns invalid for invalid sessionId', () => {
    const acc = new HomelabAccumulator({ storagePath: tmpDir });
    const result = acc.handleIngest({
      developer: 'alice',
      sessionId: '../etc/passwd',
      records: [],
    });
    expect(result).toBe('invalid');
  });

  it('saves the calls of every batch of a session', () => {
    runServer(records(0, 3), records(3, 4, 'Edit'));
    expect(saved()?.developer).toBe('alice');
    expect(saved()?.toolCallCount).toBe(7);
    expect(saved()?.toolBreakdown).toEqual({ Read: 3, Edit: 4 });
  });

  it.each([undefined, '', 7])(
    'rejects a batch holding a record with toolUseId %p and keeps the saved calls',
    (toolUseId) => {
      runServer(records(0, 5));
      const acc = new HomelabAccumulator({ storagePath: tmpDir });
      const bad = [...records(5, 2), { ...makeRecord(7), toolUseId }];
      expect(acc.handleIngest({ developer: 'alice', sessionId: 'session-abc', records: bad })).toBe(
        'invalid',
      );
      acc.stop();
      expect(saved()?.toolCallCount).toBe(5);
    },
  );

  it('adds a later batch to the calls the session already saved', () => {
    runServer(records(0, 12));
    expect(saved()?.toolCallCount).toBe(12);
    runServer([...records(12, 2), ...records(14, 1, 'Edit')]);
    expect(saved()?.toolCallCount).toBe(15);
    expect(saved()?.toolBreakdown).toEqual({ Read: 14, Edit: 1 });
  });

  it('adds a batch to a session saved without a timeline by an older build', () => {
    writeOlderBuildFile({
      endTime: makeRecord(11).timestamp,
      toolCallCount: 12,
      toolBreakdown: { Read: 12 },
    });
    runServer(records(12, 3));
    expect(saved()?.toolCallCount).toBe(15);
  });

  it('adds a batch, resent calls included, to the session an older build saved with its timeline', () => {
    const older = shareOf(records(0, 12));
    writeOlderBuildFile({ ...older, startTime: older.startTime });
    runServer(records(10, 5));
    expect(saved()?.toolCallCount).toBe(15);
    expect(saved()?.toolBreakdown).toEqual({ Read: 15 });
  });

  it('adds the calls of a session it saved and dropped when a later batch brings it back', () => {
    const acc = new HomelabAccumulator({ storagePath: tmpDir });
    acc.handleIngest({ developer: 'alice', sessionId: 'session-abc', records: records(0, 3) });
    acc.stop();
    acc.handleIngest({ developer: 'alice', sessionId: 'session-abc', records: records(3, 2) });
    acc.stop();
    expect(saved()?.toolCallCount).toBe(5);
  });

  it('counts once each call it holds with an engine, beside a dashboard share', () => {
    const engineCalls = [...records(0, 3), ...records(3, 2, 'Bash')];
    const store = new SessionStore({ storagePath: tmpDir });
    const estimate = {
      costUsd: 0.5,
      inputTokens: 100,
      outputTokens: 0,
      costByModel: {},
      costByDayUsd: {},
    };
    const engineShare = {
      ...shareOf(engineCalls),
      endTime: makeRecord(40).timestamp,
      outcome: 'completed',
      estimatedCostUsd: 0.5,
      byteEstimates: estimate,
    };
    store.writer('engine').save({ summary: engineShare, retracted: false });
    store.writer('aggregator').save({ summary: shareOf(records(20, 3, 'Edit')), retracted: false });
    runServer(engineCalls, records(30, 2));

    expect(saved()?.toolCallCount).toBe(10);
    expect(saved()?.toolBreakdown).toEqual({ Read: 5, Bash: 2, Edit: 3 });
    expect(saved()?.bashCommandCount).toBe(2);
    expect(saved()?.estimatedCostUsd).toBe(0.5);
    expect(saved()?.outcome).toBe('completed');
  });

  it('saves a session once it goes three minutes without a batch', () => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
    const acc = new HomelabAccumulator({ storagePath: tmpDir });
    acc.start();
    acc.handleIngest({ developer: 'alice', sessionId: 'session-abc', records: records(0, 1) });
    jest.advanceTimersByTime(120_000);
    acc.handleIngest({ developer: 'alice', sessionId: 'session-abc', records: records(1, 1) });
    jest.advanceTimersByTime(120_000);
    expect(saved()).toBeNull();
    jest.advanceTimersByTime(120_000);
    expect(saved()?.toolCallCount).toBe(2);
    acc.stop();
  });

  it('counts a resent batch once, before and after the session is saved', () => {
    const batch = records(0, 3);
    runServer(batch, batch);
    expect(saved()?.toolCallCount).toBe(3);
    runServer(batch, records(3, 1));
    expect(saved()?.toolCallCount).toBe(4);
  });
});
