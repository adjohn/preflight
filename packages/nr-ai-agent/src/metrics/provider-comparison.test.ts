import { ProviderComparisonAggregator, comparisonMetricsToCustomAttributes } from './provider-comparison.js';

describe('ProviderComparisonAggregator', () => {
  it('should initialize with empty data', () => {
    const agg = new ProviderComparisonAggregator();

    expect(agg.getAllMetrics()).toEqual([]);
    expect(agg.snapshot().size).toBe(0);
  });

  it('should record and retrieve metrics for a single provider-model pair', () => {
    const agg = new ProviderComparisonAggregator();

    agg.record('anthropic', 'claude-sonnet-4-20250514', 100, 50, 5, 0.01, false, 0, null, null);

    const metrics = agg.getMetrics('anthropic', 'claude-sonnet-4-20250514', null);

    expect(metrics).not.toBeNull();
    expect(metrics!.requestCount).toBe(1);
    expect(metrics!.avgDurationMs).toBe(100);
    expect(metrics!.avgCostPerRequestUsd).toBe(0.01);
    expect(metrics!.errorRate).toBe(0);
  });

  it('should compute per-provider averages correctly', () => {
    const agg = new ProviderComparisonAggregator();

    // Add 10 Anthropic requests
    for (let i = 0; i < 10; i++) {
      agg.record('anthropic', 'claude-sonnet-4-20250514', 100 + i * 10, 50, 5, 0.01, i === 0, 0, null, null);
    }

    // Add 10 Gemini requests
    for (let i = 0; i < 10; i++) {
      agg.record('google', 'gemini-2.0-flash', 80 + i * 5, 40, 6, 0.005, false, 0, null, null);
    }

    const anthropicMetrics = agg.getMetrics('anthropic', 'claude-sonnet-4-20250514', null);
    const geminiMetrics = agg.getMetrics('google', 'gemini-2.0-flash', null);

    expect(anthropicMetrics).not.toBeNull();
    expect(geminiMetrics).not.toBeNull();
    expect(anthropicMetrics!.requestCount).toBe(10);
    expect(geminiMetrics!.requestCount).toBe(10);

    // Anthropic avg duration = (100 + 110 + 120 + ... + 190) / 10 = 145
    expect(anthropicMetrics!.avgDurationMs).toBeCloseTo(145, 1);

    // Gemini avg duration = (80 + 85 + 90 + ... + 125) / 10 = 102.5
    expect(geminiMetrics!.avgDurationMs).toBeCloseTo(102.5, 1);
  });

  it('should calculate p95 duration correctly', () => {
    const agg = new ProviderComparisonAggregator();

    // Add 20 requests with increasing duration
    for (let i = 0; i < 20; i++) {
      agg.record('anthropic', 'claude-sonnet-4', 100 + i * 10, 50, 5, 0.01, false, 0, null, null);
    }

    const metrics = agg.getMetrics('anthropic', 'claude-sonnet-4', null);

    // p95 of [100, 110, 120, ..., 290] should be around 280
    expect(metrics!.p95DurationMs).toBeGreaterThan(270);
    expect(metrics!.p95DurationMs).toBeLessThanOrEqual(290);
  });

  it('should compute error rate independently per provider', () => {
    const agg = new ProviderComparisonAggregator();

    // Anthropic: 2 errors out of 10 = 20% error rate
    for (let i = 0; i < 10; i++) {
      agg.record('anthropic', 'claude-sonnet-4', 100, 50, 5, 0.01, i < 2, 0, null, null);
    }

    // Gemini: 0 errors out of 10 = 0% error rate
    for (let i = 0; i < 10; i++) {
      agg.record('google', 'gemini-2.0-flash', 80, 40, 6, 0.005, false, 0, null, null);
    }

    const anthropicMetrics = agg.getMetrics('anthropic', 'claude-sonnet-4', null);
    const geminiMetrics = agg.getMetrics('google', 'gemini-2.0-flash', null);

    expect(anthropicMetrics!.errorRate).toBeCloseTo(0.2, 2);
    expect(geminiMetrics!.errorRate).toBeCloseTo(0, 2);
  });

  it('should facet metrics by provider and model separately', () => {
    const agg = new ProviderComparisonAggregator();

    // Anthropic with two models
    agg.record('anthropic', 'claude-sonnet-4', 100, 50, 5, 0.01, false, 0, null, null);
    agg.record('anthropic', 'claude-opus-4', 200, 100, 4, 0.02, false, 0, null, null);

    const sonnetMetrics = agg.getMetrics('anthropic', 'claude-sonnet-4', null);
    const opusMetrics = agg.getMetrics('anthropic', 'claude-opus-4', null);

    expect(sonnetMetrics!.avgDurationMs).toBe(100);
    expect(opusMetrics!.avgDurationMs).toBe(200);
    expect(sonnetMetrics!.avgCostPerRequestUsd).toBe(0.01);
    expect(opusMetrics!.avgCostPerRequestUsd).toBe(0.02);
  });

  it('should support request categorization', () => {
    const agg = new ProviderComparisonAggregator();

    // Code-review category
    for (let i = 0; i < 5; i++) {
      agg.record('anthropic', 'claude-sonnet-4', 100, 50, 5, 0.01, false, 0, null, 'code-review');
    }

    // Chat category
    for (let i = 0; i < 5; i++) {
      agg.record('anthropic', 'claude-sonnet-4', 50, 25, 10, 0.005, false, 0, null, 'chat');
    }

    const reviewMetrics = agg.getMetrics('anthropic', 'claude-sonnet-4', 'code-review');
    const chatMetrics = agg.getMetrics('anthropic', 'claude-sonnet-4', 'chat');

    expect(reviewMetrics!.avgDurationMs).toBe(100);
    expect(chatMetrics!.avgDurationMs).toBe(50);
    expect(reviewMetrics!.requestCount).toBe(5);
    expect(chatMetrics!.requestCount).toBe(5);
  });

  it('should evict old data when window size exceeded', () => {
    const agg = new ProviderComparisonAggregator(5);

    // Add 10 requests with increasing cost
    for (let i = 0; i < 10; i++) {
      agg.record('anthropic', 'claude-sonnet-4', 100, 50, 5, 0.01 + i * 0.001, false, 0, null, null);
    }

    const metrics = agg.getMetrics('anthropic', 'claude-sonnet-4', null);

    // Should only have last 5 requests
    expect(metrics!.requestCount).toBe(5);
    // Average cost should be close to last 5 costs (0.015 + 0.016 + 0.017 + 0.018 + 0.019) / 5 = 0.017
    expect(metrics!.avgCostPerRequestUsd).toBeGreaterThan(0.015);
  });

  it('should handle thinking tokens and depth index', () => {
    const agg = new ProviderComparisonAggregator();

    // Add requests with thinking tokens and depth index
    agg.record('anthropic', 'claude-sonnet-4', 100, 50, 5, 0.01, false, 1000, 0.8, null);
    agg.record('anthropic', 'claude-sonnet-4', 120, 60, 4.5, 0.012, false, 1200, 0.85, null);

    const metrics = agg.getMetrics('anthropic', 'claude-sonnet-4', null);

    expect(metrics!.avgThinkingTokens).toBeCloseTo(1100, 1);
    expect(metrics!.avgDepthIndex).toBeCloseTo(0.825, 3);
  });

  it('should return null for unknown provider-model pair', () => {
    const agg = new ProviderComparisonAggregator();

    const metrics = agg.getMetrics('unknown', 'unknown', null);

    expect(metrics).toBeNull();
  });

  it('should snapshot all metrics', () => {
    const agg = new ProviderComparisonAggregator();

    agg.record('anthropic', 'claude-sonnet-4', 100, 50, 5, 0.01, false, 0, null, null);
    agg.record('google', 'gemini-2.0-flash', 80, 40, 6, 0.005, false, 0, null, null);

    const snapshot = agg.snapshot();

    expect(snapshot.size).toBe(2);
    expect(Array.from(snapshot.values())).toHaveLength(2);
  });

  it('should handle ttft metric correctly', () => {
    const agg = new ProviderComparisonAggregator();

    agg.record('anthropic', 'claude-sonnet-4', 100, 50, 5, 0.01, false, 0, null, null);
    agg.record('anthropic', 'claude-sonnet-4', 120, 60, 4.8, 0.012, false, 0, null, null);
    agg.record('anthropic', 'claude-sonnet-4', 110, 55, 4.9, 0.011, false, 0, null, null);

    const metrics = agg.getMetrics('anthropic', 'claude-sonnet-4', null);

    // Average TTFT = (50 + 60 + 55) / 3 = 55
    expect(metrics!.avgTtftMs).toBeCloseTo(55, 1);
  });

  it('should handle requests with null ttft', () => {
    const agg = new ProviderComparisonAggregator();

    agg.record('anthropic', 'claude-sonnet-4', 100, 50, 5, 0.01, false, 0, null, null);
    agg.record('anthropic', 'claude-sonnet-4', 120, null, 4.8, 0.012, false, 0, null, null);
    agg.record('anthropic', 'claude-sonnet-4', 110, 55, 4.9, 0.011, false, 0, null, null);

    const metrics = agg.getMetrics('anthropic', 'claude-sonnet-4', null);

    // Average TTFT = (50 + 55) / 2 = 52.5
    expect(metrics!.avgTtftMs).toBeCloseTo(52.5, 1);
  });

  it('should return null depthIndex when no data has it', () => {
    const agg = new ProviderComparisonAggregator();

    agg.record('anthropic', 'claude-sonnet-4', 100, 50, 5, 0.01, false, 0, null, null);
    agg.record('anthropic', 'claude-sonnet-4', 120, 60, 4.8, 0.012, false, 0, null, null);

    const metrics = agg.getMetrics('anthropic', 'claude-sonnet-4', null);

    expect(metrics!.avgDepthIndex).toBeNull();
  });

  it('should reset all data', () => {
    const agg = new ProviderComparisonAggregator();

    agg.record('anthropic', 'claude-sonnet-4', 100, 50, 5, 0.01, false, 0, null, null);
    expect(agg.getAllMetrics()).toHaveLength(1);

    agg.reset();

    expect(agg.getAllMetrics()).toHaveLength(0);
  });

  it('should return all metrics across all provider-model pairs', () => {
    const agg = new ProviderComparisonAggregator();

    agg.record('anthropic', 'claude-sonnet-4', 100, 50, 5, 0.01, false, 0, null, null);
    agg.record('anthropic', 'claude-opus-4', 200, 100, 4, 0.02, false, 0, null, null);
    agg.record('google', 'gemini-2.0-flash', 80, 40, 6, 0.005, false, 0, null, null);

    const allMetrics = agg.getAllMetrics();

    expect(allMetrics).toHaveLength(3);
    expect(allMetrics.map((m) => `${m.provider}:${m.model}`)).toContain('anthropic:claude-sonnet-4');
    expect(allMetrics.map((m) => `${m.provider}:${m.model}`)).toContain('anthropic:claude-opus-4');
    expect(allMetrics.map((m) => `${m.provider}:${m.model}`)).toContain('google:gemini-2.0-flash');
  });

  it('should compute tokens per second correctly', () => {
    const agg = new ProviderComparisonAggregator();

    agg.record('anthropic', 'claude-sonnet-4', 100, 50, 5.5, 0.01, false, 0, null, null);
    agg.record('anthropic', 'claude-sonnet-4', 120, 60, 4.5, 0.012, false, 0, null, null);

    const metrics = agg.getMetrics('anthropic', 'claude-sonnet-4', null);

    // Average tokens/sec = (5.5 + 4.5) / 2 = 5.0
    expect(metrics!.avgTokensPerSecond).toBeCloseTo(5, 1);
  });

  it('should compute cost per request correctly', () => {
    const agg = new ProviderComparisonAggregator();

    agg.record('anthropic', 'claude-sonnet-4', 100, 50, 5, 0.01, false, 0, null, null);
    agg.record('anthropic', 'claude-sonnet-4', 120, 60, 4.8, 0.02, false, 0, null, null);
    agg.record('anthropic', 'claude-sonnet-4', 110, 55, 4.9, 0.03, false, 0, null, null);

    const metrics = agg.getMetrics('anthropic', 'claude-sonnet-4', null);

    // Average cost = (0.01 + 0.02 + 0.03) / 3 = 0.02
    expect(metrics!.avgCostPerRequestUsd).toBeCloseTo(0.02, 6);
  });
});

describe('comparisonMetricsToCustomAttributes', () => {
  it('should convert metrics to custom attributes', () => {
    const metrics = {
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      category: 'code-review',
      requestCount: 100,
      avgDurationMs: 150.5,
      p95DurationMs: 250.3,
      avgTtftMs: 75.2,
      avgTokensPerSecond: 5.5,
      avgCostPerRequestUsd: 0.015,
      errorRate: 0.02,
      avgThinkingTokens: 1000.5,
      avgDepthIndex: 0.85,
    };

    const attrs = comparisonMetricsToCustomAttributes(metrics);

    expect(attrs['ai.provider.name']).toBe('anthropic');
    expect(attrs['ai.provider.model']).toBe('claude-sonnet-4');
    expect(attrs['ai.provider.category']).toBe('code-review');
    expect(attrs['ai.provider.request_count']).toBe(100);
    expect(attrs['ai.provider.avg_duration_ms']).toBe(150.5);
    expect(attrs['ai.provider.p95_duration_ms']).toBe(250.3);
    expect(attrs['ai.provider.avg_ttft_ms']).toBe(75.2);
    expect(attrs['ai.provider.avg_tokens_per_second']).toBe(5.5);
    expect(attrs['ai.provider.avg_cost_per_request_usd']).toBe(0.015);
    expect(attrs['ai.provider.error_rate']).toBe(0.02);
    expect(attrs['ai.provider.avg_thinking_tokens']).toBe(1000.5);
    expect(attrs['ai.provider.avg_depth_index']).toBe(0.85);
  });

  it('should omit null depthIndex', () => {
    const metrics = {
      provider: 'google',
      model: 'gemini-2.0-flash',
      category: 'all',
      requestCount: 50,
      avgDurationMs: 120,
      p95DurationMs: 200,
      avgTtftMs: 60,
      avgTokensPerSecond: 6,
      avgCostPerRequestUsd: 0.01,
      errorRate: 0,
      avgThinkingTokens: 0,
      avgDepthIndex: null,
    };

    const attrs = comparisonMetricsToCustomAttributes(metrics);

    expect(attrs['ai.provider.avg_depth_index']).toBeUndefined();
    expect(attrs['ai.provider.avg_thinking_tokens']).toBe(0);
  });
});
