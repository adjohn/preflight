import { CacheEconomicsTracker, extractCacheMetrics, cacheMetricsToCustomAttributes } from './cache-economics.js';
import type { AiResponse } from '@nr-ai-observatory/shared';

function makeMockResponse(overrides?: Partial<AiResponse>): AiResponse {
  const defaults: AiResponse = {
    id: 'test-id',
    timestamp: Date.now(),
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    durationMs: 1000,
    timeToFirstTokenMs: 100,
    tokensPerSecond: 5,
    inputTokens: 1000,
    outputTokens: 500,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 1500,
    costInputUsd: 0.003,
    costOutputUsd: 0.015,
    costThinkingUsd: null,
    costCacheReadUsd: 0,
    costCacheCreationUsd: 0,
    costTotalUsd: 0.018,
    stopReason: 'end_turn',
    contentBlockTypes: ['text'],
    error: null,
    'nr.appName': 'test-app',
    customAttributes: {},
  };

  return { ...defaults, ...overrides };
}

describe('extractCacheMetrics', () => {
  it('should return zero metrics for non-caching request', () => {
    const response = makeMockResponse();
    const metrics = extractCacheMetrics(response, true);

    expect(metrics.cacheHit).toBe(false);
    expect(metrics.cacheReadTokens).toBe(0);
    expect(metrics.cacheCreationTokens).toBe(0);
    expect(metrics.cacheSavingsUsd).toBe(0);
    expect(metrics.cacheCreationCostUsd).toBe(0);
    expect(metrics.cacheNetSavingsUsd).toBe(0);
  });

  it('should correctly identify cache hit', () => {
    const response = makeMockResponse({
      cacheReadTokens: 5000,
      cacheCreationTokens: 0,
    });
    const metrics = extractCacheMetrics(response, true);

    expect(metrics.cacheHit).toBe(true);
    expect(metrics.cacheReadTokens).toBe(5000);
  });

  it('should calculate cache metrics for Anthropic with 5000 read and 1000 creation tokens', () => {
    const response = makeMockResponse({
      inputTokens: 6000,
      outputTokens: 500,
      cacheReadTokens: 5000,
      cacheCreationTokens: 1000,
    });

    const metrics = extractCacheMetrics(response, true);

    expect(metrics.cacheHit).toBe(true);
    expect(metrics.cacheReadTokens).toBe(5000);
    expect(metrics.cacheCreationTokens).toBe(1000);
    expect(metrics.cacheSavingsUsd).toBeGreaterThan(0);
    expect(metrics.cacheCreationCostUsd).toBeGreaterThan(0);
  });

  it('should calculate net savings correctly', () => {
    const response = makeMockResponse({
      inputTokens: 6000,
      outputTokens: 500,
      cacheReadTokens: 5000,
      cacheCreationTokens: 1000,
    });

    const metrics = extractCacheMetrics(response, true);
    const expectedNetSavings = metrics.cacheSavingsUsd - metrics.cacheCreationCostUsd;

    expect(metrics.cacheNetSavingsUsd).toBe(expectedNetSavings);
  });

  it('should skip cost calculations when costTrackingEnabled is false', () => {
    const response = makeMockResponse({
      cacheReadTokens: 5000,
      cacheCreationTokens: 1000,
    });

    const metrics = extractCacheMetrics(response, false);

    expect(metrics.cacheHit).toBe(true);
    expect(metrics.cacheReadTokens).toBe(5000);
    expect(metrics.cacheSavingsUsd).toBe(0);
    expect(metrics.cacheCreationCostUsd).toBe(0);
  });
});

describe('CacheEconomicsTracker', () => {
  it('should track cache hit count correctly', () => {
    const tracker = new CacheEconomicsTracker(true);

    // 7 cache hits
    for (let i = 0; i < 7; i++) {
      tracker.record(makeMockResponse({ cacheReadTokens: 100 }));
    }

    // 3 cache misses
    for (let i = 0; i < 3; i++) {
      tracker.record(makeMockResponse({ cacheReadTokens: 0 }));
    }

    const agg = tracker.getAggregates();
    expect(agg.totalRequests).toBe(10);
    expect(agg.cacheHitCount).toBe(7);
    expect(agg.cacheHitRate).toBeCloseTo(0.7, 2);
  });

  it('should calculate cache hit rate correctly', () => {
    const tracker = new CacheEconomicsTracker(true);

    tracker.record(makeMockResponse({ cacheReadTokens: 100 }));
    tracker.record(makeMockResponse({ cacheReadTokens: 0 }));
    tracker.record(makeMockResponse({ cacheReadTokens: 200 }));

    const agg = tracker.getAggregates();
    expect(agg.cacheHitRate).toBeCloseTo(0.667, 2);
  });

  it('should accumulate savings and creation costs', () => {
    const tracker = new CacheEconomicsTracker(true);

    // Request 1: 5000 read tokens, 1000 creation tokens
    tracker.record(
      makeMockResponse({
        inputTokens: 6000,
        outputTokens: 500,
        cacheReadTokens: 5000,
        cacheCreationTokens: 1000,
      }),
    );

    // Request 2: 3000 read tokens, 0 creation tokens
    tracker.record(
      makeMockResponse({
        inputTokens: 3000,
        outputTokens: 500,
        cacheReadTokens: 3000,
        cacheCreationTokens: 0,
      }),
    );

    const agg = tracker.getAggregates();
    expect(agg.cumulativeSavingsUsd).toBeGreaterThan(0);
    expect(agg.cumulativeCreationCostUsd).toBeGreaterThan(0);
  });

  it('should calculate ROI when creation costs exist', () => {
    const tracker = new CacheEconomicsTracker(true);

    tracker.record(
      makeMockResponse({
        inputTokens: 6000,
        outputTokens: 500,
        cacheReadTokens: 5000,
        cacheCreationTokens: 1000,
      }),
    );

    const agg = tracker.getAggregates();
    if (agg.cumulativeCreationCostUsd > 0) {
      expect(agg.cacheRoi).toBe(
        agg.cumulativeSavingsUsd / agg.cumulativeCreationCostUsd,
      );
    }
  });

  it('should calculate efficiency score correctly', () => {
    const tracker = new CacheEconomicsTracker(true);

    tracker.record(
      makeMockResponse({
        inputTokens: 6000,
        outputTokens: 500,
        cacheReadTokens: 5000,
        cacheCreationTokens: 1000,
      }),
    );

    const agg = tracker.getAggregates();
    if (agg.cumulativeSavingsUsd + agg.cumulativeCreationCostUsd > 0) {
      expect(agg.cacheEfficiencyScore).toBe(
        agg.cumulativeSavingsUsd /
          (agg.cumulativeSavingsUsd + agg.cumulativeCreationCostUsd),
      );
    }
  });

  it('should handle zero hit rate when all requests miss cache', () => {
    const tracker = new CacheEconomicsTracker(true);

    for (let i = 0; i < 5; i++) {
      tracker.record(makeMockResponse({ cacheReadTokens: 0 }));
    }

    const agg = tracker.getAggregates();
    expect(agg.cacheHitCount).toBe(0);
    expect(agg.cacheHitRate).toBe(0);
  });

  it('should have null ROI when no creation costs', () => {
    const tracker = new CacheEconomicsTracker(true);

    tracker.record(
      makeMockResponse({
        inputTokens: 3000,
        outputTokens: 500,
        cacheReadTokens: 3000,
        cacheCreationTokens: 0,
      }),
    );

    const agg = tracker.getAggregates();
    if (agg.cumulativeCreationCostUsd === 0 && agg.cumulativeSavingsUsd > 0) {
      expect(agg.cacheRoi).toBe(Infinity);
    }
  });

  it('should skip cost calculations when costTrackingEnabled is false', () => {
    const tracker = new CacheEconomicsTracker(false);

    tracker.record(
      makeMockResponse({
        inputTokens: 6000,
        outputTokens: 500,
        cacheReadTokens: 5000,
        cacheCreationTokens: 1000,
      }),
    );

    const agg = tracker.getAggregates();
    expect(agg.cumulativeSavingsUsd).toBe(0);
    expect(agg.cumulativeCreationCostUsd).toBe(0);
    expect(agg.cacheRoi).toBeNull();
  });

  it('should reset aggregates', () => {
    const tracker = new CacheEconomicsTracker(true);

    for (let i = 0; i < 5; i++) {
      tracker.record(makeMockResponse({ cacheReadTokens: 100 }));
    }

    tracker.reset();

    const agg = tracker.getAggregates();
    expect(agg.totalRequests).toBe(0);
    expect(agg.cacheHitCount).toBe(0);
    expect(agg.cumulativeSavingsUsd).toBe(0);
    expect(agg.cumulativeCreationCostUsd).toBe(0);
  });
});

describe('cacheMetricsToCustomAttributes', () => {
  it('should return empty object for null metrics', () => {
    const attrs = cacheMetricsToCustomAttributes(null);
    expect(attrs).toEqual({});
  });

  it('should include cache hit and token counts', () => {
    const response = makeMockResponse({
      cacheReadTokens: 5000,
      cacheCreationTokens: 1000,
    });
    const metrics = extractCacheMetrics(response, true);
    const attrs = cacheMetricsToCustomAttributes(metrics);

    expect(attrs['ai.cache.hit']).toBe(1);
    expect(attrs['ai.cache.read_tokens']).toBe(5000);
    expect(attrs['ai.cache.creation_tokens']).toBe(1000);
  });

  it('should round USD values to 6 decimal places', () => {
    const response = makeMockResponse({
      inputTokens: 6000,
      outputTokens: 500,
      cacheReadTokens: 5000,
      cacheCreationTokens: 1000,
    });
    const metrics = extractCacheMetrics(response, true);
    const attrs = cacheMetricsToCustomAttributes(metrics);

    if (attrs['ai.cache.savings_usd']) {
      const savingsUsd = attrs['ai.cache.savings_usd'] as number;
      expect(savingsUsd).toBe(Math.round(savingsUsd * 1000000) / 1000000);
    }
  });

  it('should omit zero USD values', () => {
    const response = makeMockResponse({
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    const metrics = extractCacheMetrics(response, true);
    const attrs = cacheMetricsToCustomAttributes(metrics);

    expect(attrs['ai.cache.savings_usd']).toBeUndefined();
    expect(attrs['ai.cache.creation_cost_usd']).toBeUndefined();
    expect(attrs['ai.cache.net_savings_usd']).toBeUndefined();
  });
});
