import { createLogger } from '../core/index.js';
import { ZERO_QUALITY_PROXY_COUNTS } from '../metrics/quality-proxy-tracker.js';
import type { ReplayTimelineEntry, ToolCallRecord } from '../storage/types.js';
import { SessionStore } from '../storage/session-store.js';
import type { FullSessionSummary } from '../storage/session-store.js';
import type { SessionWriter } from '../storage/session-writers.js';

const logger = createLogger('homelab-accumulator');

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const STALE_SESSION_MS = 3 * 60 * 1000;
const FLUSH_INTERVAL_MS = 60_000;

export interface HomelabIngestPayload {
  readonly developer: string;
  readonly sessionId: string;
  readonly records: ToolCallRecord[];
}

interface ActiveSession {
  readonly developer: string;
  readonly sessionId: string;
  readonly recordsByToolUseId: Map<string, ToolCallRecord>;
  readonly startTime: number;
  readonly writer: SessionWriter;
  lastSeen: number;
}

function isIngestPayload(v: unknown): v is HomelabIngestPayload {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.developer === 'string' &&
    typeof obj.sessionId === 'string' &&
    Array.isArray(obj.records) &&
    obj.records.every((r: { toolUseId?: unknown } | null) => {
      const id = r?.toolUseId;
      return typeof id === 'string' && id !== '';
    })
  );
}

export class HomelabAccumulator {
  private readonly sessionStore: SessionStore;
  private readonly sessions = new Map<string, ActiveSession>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: { storagePath: string }) {
    this.sessionStore = new SessionStore({ storagePath: opts.storagePath });
  }

  handleIngest(payload: unknown): 'ok' | 'invalid' {
    if (!isIngestPayload(payload)) return 'invalid';
    const { developer, sessionId, records } = payload;
    if (!developer || !SESSION_ID_RE.test(sessionId)) return 'invalid';

    const key = `${developer}:${sessionId}`;
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        developer,
        sessionId,
        recordsByToolUseId: new Map(),
        startTime: records[0]?.timestamp ?? Date.now(),
        writer: this.sessionStore.writer('homelab'),
        lastSeen: Date.now(),
      };
      this.sessions.set(key, session);
    }
    for (const r of records) session.recordsByToolUseId.set(r.toolUseId, r);
    session.lastSeen = Date.now();
    return 'ok';
  }

  start(): void {
    this.flushTimer = setInterval(() => this.flushStaleSessions(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
  }

  stop(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushAllSessions();
  }

  private flushStaleSessions(): void {
    const cutoff = Date.now() - STALE_SESSION_MS;
    for (const [key, session] of this.sessions) {
      if (session.lastSeen < cutoff) {
        this.save(session);
        this.sessions.delete(key);
      }
    }
  }

  private flushAllSessions(): void {
    for (const session of this.sessions.values()) {
      this.save(session);
    }
    this.sessions.clear();
  }

  private save(session: ActiveSession): void {
    try {
      session.writer.save({ summary: buildMinimalSummary(session), retracted: false });
    } catch (err) {
      logger.warn('Failed to save homelab session', {
        error: String(err),
        sessionId: session.sessionId,
      });
    }
  }
}

function toTimelineEntry(r: ToolCallRecord): ReplayTimelineEntry {
  return {
    timestamp: r.timestamp,
    toolUseId: r.toolUseId,
    toolName: r.toolName,
    durationMs: r.durationMs,
    success: r.success,
  };
}

function buildMinimalSummary(session: ActiveSession): FullSessionSummary {
  const records = [...session.recordsByToolUseId.values()];
  const toolBreakdown: Record<string, number> = {};
  for (const r of records) {
    toolBreakdown[r.toolName] = (toolBreakdown[r.toolName] ?? 0) + 1;
  }

  const endTime = records.at(-1)?.timestamp ?? session.lastSeen;
  return {
    sessionId: session.sessionId,
    startTime: session.startTime,
    endTime,
    durationMs: endTime - session.startTime,
    toolCallCount: records.length,
    developer: session.developer,
    sessionName: null,
    sessionNameSource: null,
    sessionIntent: null,
    repoName: null,
    model: null,
    toolBreakdown,
    timeline: records.map(toTimelineEntry),
    skillBreakdown: {},
    filesRead: [],
    filesModified: [],
    linesAdded: 0,
    linesRemoved: 0,
    bashCommandCount: toolBreakdown.Bash ?? 0,
    testRunCount: 0,
    testPassCount: 0,
    buildRunCount: 0,
    buildPassCount: 0,
    estimatedCostUsd: null,
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
    taskCount: 0,
    taskSuccessRate: null,
    toolSuccessRate: null,
    contextCompressions: 0,
    agentSpawns: 0,
    userMessages: 0,
    assistantMessages: 0,
    userCorrections: 0,
    outcome: 'unknown',
    platform: 'homelab',
  };
}
