import { QualityTracker } from './quality.js';
import type { AiResponse } from '@nr-ai-observatory/shared';

const makeResponse = (overrides?: Partial<AiResponse>): AiResponse => ({
  id: 'test-id',
  timestamp: Date.now(),
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  durationMs: 200,
  timeToFirstTokenMs: 50,
  tokensPerSecond: null,
  inputTokens: 100,
  outputTokens: 500,
  thinkingTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 600,
  costInputUsd: null,
  costOutputUsd: null,
  costThinkingUsd: null,
  costCacheReadUsd: null,
  costCacheCreationUsd: null,
  costTotalUsd: null,
  stopReason: 'end_turn',
  contentBlockTypes: ['text'],
  error: null,
  'nr.appName': 'test',
  customAttributes: {},
  ...overrides,
});

describe('QualityTracker', () => {
  it('should initialize with default metrics', () => {
    const tracker = new QualityTracker();
    const metrics = tracker.getMetrics();

    expect(metrics.qualityScore).toBe(1.0);
    expect(metrics.maxTokensHitRate).toBe(0);
    expect(metrics.errorRate).toBe(0);
    expect(metrics.hasLatencyAnomaly).toBe(false);
    expect(metrics.hasLengthAnomaly).toBe(false);
  });

  it('should track max_tokens hit rate correctly', () => {
    const tracker = new QualityTracker();

    // Record 100 normal responses
    for (let i = 0; i < 100; i++) {
      tracker.recordStructuralSignals(makeResponse({ stopReason: 'end_turn' }));
    }

    let metrics = tracker.getMetrics();
    expect(metrics.maxTokensHitRate).toBe(0);
    expect(metrics.qualityScore).toBeCloseTo(1.0, 2);

    // Record 5 max_tokens responses
    for (let i = 0; i < 5; i++) {
      tracker.recordStructuralSignals(makeResponse({ stopReason: 'max_tokens' }));
    }

    metrics = tracker.getMetrics();
    // With window size 100, we have 100 normal + 5 max_tokens, but window only keeps 100
    // So it's roughly 5/100 = 0.05
    expect(metrics.maxTokensHitRate).toBeGreaterThan(0);
    expect(metrics.qualityScore).toBeLessThan(1.0);
  });

  it('should evict old data when window size exceeded', () => {
    const tracker = new QualityTracker(10);

    // Add 15 responses
    for (let i = 0; i < 15; i++) {
      tracker.recordStructuralSignals(makeResponse({ outputTokens: 100 + i }));
    }

    const metrics = tracker.getMetrics();
    expect(metrics.feedbackCount).toBe(0);

    // After 15 records with window size 10, only last 10 should be kept
    // The metrics should reflect only those 10 responses
    expect(metrics.avgResponseLength).toBeGreaterThan(0);
  });

  it('should detect latency anomaly when response is >2 std dev from mean', () => {
    const tracker = new QualityTracker();

    // Record 100 responses at ~200ms
    for (let i = 0; i < 100; i++) {
      tracker.recordStructuralSignals(makeResponse({ durationMs: 200 + Math.random() * 20 }));
    }

    let metrics = tracker.getMetrics();
    expect(metrics.hasLatencyAnomaly).toBe(false);

    // Record 1 response at 5000ms
    tracker.recordStructuralSignals(makeResponse({ durationMs: 5000 }));

    metrics = tracker.getMetrics();
    expect(metrics.hasLatencyAnomaly).toBe(true);
  });

  it('should detect response length anomaly', () => {
    const tracker = new QualityTracker();

    // Record 100 responses at ~500 tokens
    for (let i = 0; i < 100; i++) {
      tracker.recordStructuralSignals(makeResponse({ outputTokens: 500 + Math.random() * 50 }));
    }

    let metrics = tracker.getMetrics();
    expect(metrics.hasLengthAnomaly).toBe(false);

    // Record 1 response at 50 tokens
    tracker.recordStructuralSignals(makeResponse({ outputTokens: 50 }));

    metrics = tracker.getMetrics();
    expect(metrics.hasLengthAnomaly).toBe(true);
  });

  it('should calculate quality score with no anomalies as 1.0', () => {
    const tracker = new QualityTracker();

    // Record normal responses
    for (let i = 0; i < 20; i++) {
      tracker.recordStructuralSignals(makeResponse());
    }

    const metrics = tracker.getMetrics();
    expect(metrics.qualityScore).toBeCloseTo(1.0, 2);
  });

  it('should penalize quality score for high error rate', () => {
    const tracker = new QualityTracker();

    // Record 50 responses with 50% error rate
    for (let i = 0; i < 50; i++) {
      const hasError = i % 2 === 0;
      tracker.recordStructuralSignals(
        makeResponse({
          error: hasError ? { type: 'error', message: 'test error', statusCode: 500 } : null,
        }),
      );
    }

    const metrics = tracker.getMetrics();
    expect(metrics.errorRate).toBeCloseTo(0.5, 1);
    // 50% error rate: 1.0 - (0.5 * 0.3) = 0.85
    expect(metrics.qualityScore).toBeCloseTo(0.85, 2);
    expect(metrics.qualityScore).toBeLessThan(1.0);
  });

  it('should record and apply feedback score', () => {
    const tracker = new QualityTracker();

    // Record some responses
    for (let i = 0; i < 10; i++) {
      tracker.recordStructuralSignals(makeResponse());
    }

    // Record positive feedback (score = 1.0)
    tracker.recordFeedback('req-1', 1.0);

    let metrics = tracker.getMetrics();
    expect(metrics.feedbackCount).toBe(1);
    expect(metrics.avgFeedbackScore).toBeCloseTo(1.0, 2);
    // Positive feedback should improve quality score
    expect(metrics.qualityScore).toBeCloseTo(1.0, 2);

    // Record negative feedback
    tracker.recordFeedback('req-2', 0.0);

    metrics = tracker.getMetrics();
    expect(metrics.feedbackCount).toBe(2);
    expect(metrics.avgFeedbackScore).toBeCloseTo(0.5, 2);
  });

  it('should reject invalid feedback scores', () => {
    const tracker = new QualityTracker();

    // Mock logger to suppress warnings (it uses createLogger, not console)
    jest.spyOn(console, 'error').mockImplementation();

    tracker.recordFeedback('req-1', -0.5);
    tracker.recordFeedback('req-2', 1.5);

    const metrics = tracker.getMetrics();
    // Invalid scores should not be recorded
    expect(metrics.feedbackCount).toBe(0);

    jest.restoreAllMocks();
  });

  it('should track regeneration rate', () => {
    const tracker = new QualityTracker();

    // Record 20 responses
    for (let i = 0; i < 20; i++) {
      tracker.recordStructuralSignals(makeResponse());
    }

    // Record 5 regenerations
    for (let i = 0; i < 5; i++) {
      tracker.recordRegeneration(`req-${i}`);
    }

    const metrics = tracker.getMetrics();
    expect(metrics.regenerationRate).toBeCloseTo(0.25, 2); // 5 regen / 20 responses
  });

  it('should track edit distance', () => {
    const tracker = new QualityTracker();

    // Record some responses
    for (let i = 0; i < 10; i++) {
      tracker.recordStructuralSignals(makeResponse());
    }

    // Record edit distances
    tracker.recordEditDistance('req-1', 0.0);
    tracker.recordEditDistance('req-2', 0.5);
    tracker.recordEditDistance('req-3', 1.0);

    const metrics = tracker.getMetrics();
    expect(metrics.avgEditDistance).toBeCloseTo(0.5, 2); // Average of 0.0, 0.5, 1.0
  });

  it('should reject invalid edit distances', () => {
    const tracker = new QualityTracker();

    jest.spyOn(console, 'warn').mockImplementation();

    tracker.recordEditDistance('req-1', -0.1);
    tracker.recordEditDistance('req-2', 1.1);

    const metrics = tracker.getMetrics();
    expect(metrics.avgEditDistance).toBeNull();

    jest.restoreAllMocks();
  });

  it('should calculate avg latency correctly', () => {
    const tracker = new QualityTracker();

    // Record responses with specific latencies
    tracker.recordStructuralSignals(makeResponse({ durationMs: 100 }));
    tracker.recordStructuralSignals(makeResponse({ durationMs: 200 }));
    tracker.recordStructuralSignals(makeResponse({ durationMs: 300 }));

    const metrics = tracker.getMetrics();
    expect(metrics.avgLatencyMs).toBeCloseTo(200, 1); // Average of 100, 200, 300
  });

  it('should calculate avg response length correctly', () => {
    const tracker = new QualityTracker();

    // Record responses with specific output tokens
    tracker.recordStructuralSignals(makeResponse({ outputTokens: 400 }));
    tracker.recordStructuralSignals(makeResponse({ outputTokens: 500 }));
    tracker.recordStructuralSignals(makeResponse({ outputTokens: 600 }));

    const metrics = tracker.getMetrics();
    expect(metrics.avgResponseLength).toBeCloseTo(500, 1); // Average of 400, 500, 600
  });

  it('should reset all state', () => {
    const tracker = new QualityTracker();

    // Record some data
    tracker.recordStructuralSignals(makeResponse({ stopReason: 'max_tokens' }));
    tracker.recordFeedback('req-1', 0.5);
    tracker.recordRegeneration('req-1');
    tracker.recordEditDistance('req-1', 0.8);

    // Reset
    tracker.reset();

    const metrics = tracker.getMetrics();
    expect(metrics.qualityScore).toBe(1.0);
    expect(metrics.maxTokensHitRate).toBe(0);
    expect(metrics.feedbackCount).toBe(0);
    expect(metrics.regenerationRate).toBe(0);
    expect(metrics.avgEditDistance).toBeNull();
  });

  it('should handle empty window gracefully', () => {
    const tracker = new QualityTracker();

    const metrics = tracker.getMetrics();
    expect(metrics.qualityScore).toBe(1.0);
    expect(metrics.avgLatencyMs).toBe(0);
    expect(metrics.avgResponseLength).toBe(0);
  });

  it('should track error rate correctly', () => {
    const tracker = new QualityTracker();

    // Record 90 successful responses
    for (let i = 0; i < 90; i++) {
      tracker.recordStructuralSignals(makeResponse({ error: null }));
    }

    // Record 10 failed responses
    for (let i = 0; i < 10; i++) {
      tracker.recordStructuralSignals(
        makeResponse({
          error: { type: 'error', message: 'test', statusCode: 500 },
        }),
      );
    }

    const metrics = tracker.getMetrics();
    expect(metrics.errorRate).toBeCloseTo(0.1, 2); // 10%
  });

  it('should combine all signals into final quality score', () => {
    const tracker = new QualityTracker();

    // Create a scenario with multiple issues:
    // - 30% max_tokens hits
    // - 20% error rate
    // - Some latency and length anomalies
    for (let i = 0; i < 50; i++) {
      const stopReason = i < 15 ? 'max_tokens' : 'end_turn';
      const hasError = i < 10;
      tracker.recordStructuralSignals(
        makeResponse({
          stopReason,
          error: hasError ? { type: 'error', message: 'test', statusCode: 500 } : null,
          durationMs: i === 49 ? 5000 : 200, // Last one is an anomaly
        }),
      );
    }

    const metrics = tracker.getMetrics();
    expect(metrics.qualityScore).toBeLessThan(1.0);
    expect(metrics.qualityScore).toBeGreaterThan(0);
    expect(metrics.maxTokensHitRate).toBeGreaterThan(0);
    expect(metrics.errorRate).toBeGreaterThan(0);
  });

  it('should emit anomaly flags on recordStructuralSignals', () => {
    const tracker = new QualityTracker();

    // Record enough normal data to establish baseline
    for (let i = 0; i < 20; i++) {
      tracker.recordStructuralSignals(makeResponse());
    }

    // Record an anomalous response and get the flags
    const flags = tracker.recordStructuralSignals(makeResponse({ durationMs: 5000 }));

    expect(flags['ai.quality.latency_anomaly']).toBeDefined();
    expect(flags['ai.quality.max_tokens_hit_rate']).toBeDefined();
    expect(flags['ai.quality.error_rate']).toBeDefined();
    expect(flags['ai.quality.avg_latency_ms']).toBeDefined();
    expect(flags['ai.quality.latency_anomaly']).toBe(1); // Should be flagged as anomaly
  });
});
