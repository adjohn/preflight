import type { FullSessionSummary } from '../storage/session-store.js';

/**
 * "What's contributing to your spend": independent characteristics of the
 * sessions in a window, each expressed as a share of total spend, plus share
 * tables by skill, subagent type, plugin, and loop. Spend (USD) is the single
 * denominator; tokens are reported alongside where known. Characteristics
 * overlap (a long session can also be subagent-heavy), so shares do not sum
 * to 100%.
 */

export type UsageInsightId =
  'high_context' | 'subagent_heavy' | 'long_sessions' | 'loops' | 'plugins';

export interface UsageShareRow {
  readonly key: string;
  readonly costUsd: number;
  readonly tokens: number;
  readonly count: number;
  /** Percentage of `UsageInsightsReport.totalCostUsd`, rounded to a whole number. */
  readonly sharePct: number;
}

export interface UsageInsight extends UsageShareRow {
  readonly id: UsageInsightId;
  readonly sessionCount: number;
  readonly headline: string;
  readonly advice: string;
}

export interface LoopRow {
  readonly sessionId: string;
  readonly sessionName: string | null;
  /** ScheduleWakeup calls + 1: the initial run plus every self-scheduled wakeup. */
  readonly runs: number;
  readonly tokens: number;
  readonly tokensPerRun: number;
  readonly costUsd: number;
  readonly lastRunMs: number;
}

export interface UsageInsightsReport {
  readonly windowDays: number;
  readonly sessionCount: number;
  readonly totalCostUsd: number;
  readonly totalTokens: number;
  /** Sorted by share descending; zero-share insights are omitted. */
  readonly insights: readonly UsageInsight[];
  readonly skills: readonly UsageShareRow[];
  readonly subagents: readonly UsageShareRow[];
  readonly plugins: readonly UsageShareRow[];
  readonly loops: readonly LoopRow[];
  /** Share of window spend that carries tool/skill attribution; null when no session has attribution. */
  readonly attributionRatePct: number | null;
}

export interface UsageInsightsOptions {
  readonly nowMs: number;
  readonly windowDays: number;
}

export function computeUsageInsights(
  _sessions: readonly FullSessionSummary[],
  _opts: UsageInsightsOptions,
): UsageInsightsReport {
  throw new Error('not implemented');
}
