import { calculateCost } from '@nr-ai-observatory/shared';
import type { AiResponse } from '@nr-ai-observatory/shared';

export interface CacheMetrics {
  readonly cacheHit: boolean;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheSavingsUsd: number;
  readonly cacheCreationCostUsd: number;
  readonly cacheNetSavingsUsd: number;
}

export interface CacheAggregates {
  readonly totalRequests: number;
  readonly cacheHitCount: number;
  readonly cacheHitRate: number;
  readonly cumulativeSavingsUsd: number;
  readonly cumulativeCreationCostUsd: number;
  readonly cacheRoi: number | null;
  readonly cacheEfficiencyScore: number | null;
}

export function extractCacheMetrics(response: AiResponse, costTrackingEnabled: boolean = true): CacheMetrics {
  const cacheReadTokens = response.cacheReadTokens ?? 0;
  const cacheCreationTokens = response.cacheCreationTokens ?? 0;
  const cacheHit = cacheReadTokens > 0;

  let cacheSavingsUsd = 0;
  let cacheCreationCostUsd = 0;

  if (costTrackingEnabled) {
    // Calculate costs using the pricing module
    const costBreakdown = calculateCost(response.model, {
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      thinkingTokens: response.thinkingTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalTokens: response.totalTokens,
    });

    // Savings from cache reads = full input price minus cache read price (already calculated by pricing)
    cacheSavingsUsd = costBreakdown.savingsFromCacheUsd;

    // Creation cost = premium for writing to cache
    cacheCreationCostUsd = Math.max(0, costBreakdown.cacheCreationUsd);
  }

  const cacheNetSavingsUsd = cacheSavingsUsd - cacheCreationCostUsd;

  return {
    cacheHit,
    cacheReadTokens,
    cacheCreationTokens,
    cacheSavingsUsd,
    cacheCreationCostUsd,
    cacheNetSavingsUsd,
  };
}

export class CacheEconomicsTracker {
  private totalRequests = 0;
  private cacheHitCount = 0;
  private cumulativeSavingsUsd = 0;
  private cumulativeCreationCostUsd = 0;
  private readonly costTrackingEnabled: boolean;

  constructor(costTrackingEnabled: boolean = true) {
    this.costTrackingEnabled = costTrackingEnabled;
  }

  record(response: AiResponse): void {
    const metrics = extractCacheMetrics(response, this.costTrackingEnabled);

    this.totalRequests += 1;
    if (metrics.cacheHit) {
      this.cacheHitCount += 1;
    }

    if (this.costTrackingEnabled) {
      this.cumulativeSavingsUsd += metrics.cacheSavingsUsd;
      this.cumulativeCreationCostUsd += metrics.cacheCreationCostUsd;
    }
  }

  getAggregates(): CacheAggregates {
    const cacheHitRate = this.totalRequests > 0 ? this.cacheHitCount / this.totalRequests : 0;

    let cacheRoi: number | null = null;
    let cacheEfficiencyScore: number | null = null;

    if (this.costTrackingEnabled) {
      // ROI = cumulative savings / cumulative creation cost
      if (this.cumulativeCreationCostUsd > 0) {
        cacheRoi = this.cumulativeSavingsUsd / this.cumulativeCreationCostUsd;
      } else if (this.cumulativeSavingsUsd > 0) {
        // If we have savings but no creation cost, ROI is infinite
        cacheRoi = Infinity;
      }

      // Efficiency = savings / (savings + creation cost)
      const totalCacheActivity = this.cumulativeSavingsUsd + this.cumulativeCreationCostUsd;
      if (totalCacheActivity > 0) {
        cacheEfficiencyScore = this.cumulativeSavingsUsd / totalCacheActivity;
      } else if (this.totalRequests > 0) {
        // No cache activity but we have requests
        cacheEfficiencyScore = 0;
      }
    }

    return {
      totalRequests: this.totalRequests,
      cacheHitCount: this.cacheHitCount,
      cacheHitRate,
      cumulativeSavingsUsd: this.cumulativeSavingsUsd,
      cumulativeCreationCostUsd: this.cumulativeCreationCostUsd,
      cacheRoi,
      cacheEfficiencyScore,
    };
  }

  reset(): void {
    this.totalRequests = 0;
    this.cacheHitCount = 0;
    this.cumulativeSavingsUsd = 0;
    this.cumulativeCreationCostUsd = 0;
  }
}

export function cacheMetricsToCustomAttributes(
  metrics: CacheMetrics | null,
): Record<string, string | number> {
  if (!metrics) {
    return {};
  }

  const attrs: Record<string, string | number> = {
    'ai.cache.hit': metrics.cacheHit ? 1 : 0,
    'ai.cache.read_tokens': metrics.cacheReadTokens,
    'ai.cache.creation_tokens': metrics.cacheCreationTokens,
  };

  if (metrics.cacheSavingsUsd !== 0) {
    attrs['ai.cache.savings_usd'] = Math.round(metrics.cacheSavingsUsd * 1000000) / 1000000;
  }
  if (metrics.cacheCreationCostUsd !== 0) {
    attrs['ai.cache.creation_cost_usd'] = Math.round(metrics.cacheCreationCostUsd * 1000000) / 1000000;
  }
  if (metrics.cacheNetSavingsUsd !== 0) {
    attrs['ai.cache.net_savings_usd'] = Math.round(metrics.cacheNetSavingsUsd * 1000000) / 1000000;
  }

  return attrs;
}
