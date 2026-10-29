import type { FullSessionSummary } from '../storage/session-store.js';
import type { CostTrackerSeed } from './cost-tracker.js';
import { localDateKey, todayPortionOfSessionCost, todayPortionRatio } from '../lib/date.js';

// Builds the seed a freshly-started process's CostTracker needs to recover a
// resumed session's pre-restart totals — see CostTracker.seedFromPersisted()
// for why this exists (ParentTranscriptWatcher's read cursor durably survives
// a restart; CostTracker's totals do not, without this).
//
// dayCostUsd/daySubagentCostUsd take the persisted exact per-day bucket when
// the summary has one, so Spend Today is unchanged by a restart. Summaries
// without buckets fall back to pro-rating by the timeline, so a session whose
// prior activity already spanned a midnight doesn't over-attribute to today.
export function buildCostTrackerSeed(persisted: FullSessionSummary): CostTrackerSeed {
  const totalCostUsd = persisted.estimatedCostUsd ?? 0;
  const costByModel: Record<string, number> = {};
  for (const [model, entry] of Object.entries(persisted.modelBreakdown)) {
    costByModel[model] = entry.totalCostUsd;
  }
  const dayKey = localDateKey();
  const todayRatio = todayPortionRatio(persisted);
  const dayCostUsd =
    persisted.costByDayUsd !== undefined
      ? (persisted.costByDayUsd[dayKey] ?? 0)
      : todayPortionOfSessionCost(persisted);
  const daySubagentCostUsd =
    persisted.subagentCostByDayUsd !== undefined
      ? (persisted.subagentCostByDayUsd[dayKey] ?? 0)
      : persisted.subagentCostUsd * todayRatio;
  return {
    totalCostUsd,
    subagentCostUsd: persisted.subagentCostUsd,
    parentCostUsd: totalCostUsd - persisted.subagentCostUsd,
    totalInputTokens: persisted.tokensInput,
    totalOutputTokens: persisted.tokensOutput,
    totalThinkingTokens: persisted.tokensThinking,
    totalCacheReadTokens: persisted.tokensCacheRead,
    totalCacheCreationTokens: persisted.tokensCacheCreation,
    totalCacheSavingsUsd: persisted.cacheSavingsUsd,
    costByModel,
    costByWorkflowRunId: persisted.costByWorkflowRunId,
    dayKey,
    dayCostUsd,
    daySubagentCostUsd,
    ...(persisted.unpricedByModel && { unpricedByModel: persisted.unpricedByModel }),
    ...(persisted.estimatedByModel && { estimatedByModel: persisted.estimatedByModel }),
    ...(persisted.byteEstimates && { byteEstimates: persisted.byteEstimates }),
  };
}
