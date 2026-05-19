import { extractReasoningMetrics, reasoningMetricsToCustomAttributes } from './reasoning.js';

describe('extractReasoningMetrics', () => {
  it('should return null when no thinking tokens are used', () => {
    const result = extractReasoningMetrics({
      thinkingTokens: 0,
      outputTokens: 100,
      thinkingBudgetTokens: null,
      thinkingDurationMs: null,
      totalDurationMs: 1000,
    });
    expect(result).toBeNull();
  });

  it('should correctly calculate metrics for Anthropic thinking response', () => {
    const result = extractReasoningMetrics({
      thinkingTokens: 1000,
      outputTokens: 500,
      thinkingBudgetTokens: 2000,
      thinkingDurationMs: 500,
      totalDurationMs: 1000,
    });

    expect(result).not.toBeNull();
    expect(result!.thinkingTokens).toBe(1000);
    expect(result!.thinkingBudgetTokens).toBe(2000);
    expect(result!.budgetUtilization).toBe(0.5);
    expect(result!.thinkingToOutputRatio).toBe(2.0);
    expect(result!.depthIndex).toBeGreaterThan(0);
    expect(result!.depthIndex).toBeLessThanOrEqual(1);
  });

  it('should handle max budget utilization at 100%', () => {
    const result = extractReasoningMetrics({
      thinkingTokens: 2000,
      outputTokens: 500,
      thinkingBudgetTokens: 2000,
      thinkingDurationMs: 500,
      totalDurationMs: 1000,
    });

    expect(result).not.toBeNull();
    expect(result!.budgetUtilization).toBe(1.0);
  });

  it('should clamp budget utilization above 100%', () => {
    const result = extractReasoningMetrics({
      thinkingTokens: 2500,
      outputTokens: 500,
      thinkingBudgetTokens: 2000,
      thinkingDurationMs: 500,
      totalDurationMs: 1000,
    });

    expect(result).not.toBeNull();
    expect(result!.budgetUtilization).toBe(1.0);
  });

  it('should handle null thinking budget', () => {
    const result = extractReasoningMetrics({
      thinkingTokens: 1000,
      outputTokens: 500,
      thinkingBudgetTokens: null,
      thinkingDurationMs: 500,
      totalDurationMs: 1000,
    });

    expect(result).not.toBeNull();
    expect(result!.budgetUtilization).toBeNull();
    expect(result!.thinkingToOutputRatio).toBe(2.0);
  });

  it('should handle context pressure calculation at 25%', () => {
    const result = extractReasoningMetrics({
      thinkingTokens: 500,
      outputTokens: 100,
      thinkingBudgetTokens: 4000,
      thinkingDurationMs: 250,
      totalDurationMs: 2000,
    });

    expect(result).not.toBeNull();
    expect(result!.budgetUtilization).toBeCloseTo(0.125, 2);
  });

  it('should produce normalized depthIndex between 0 and 1', () => {
    // Extreme high token ratio
    const highTokenResult = extractReasoningMetrics({
      thinkingTokens: 10000,
      outputTokens: 100,
      thinkingBudgetTokens: 20000,
      thinkingDurationMs: 1000,
      totalDurationMs: 1000,
    });
    expect(highTokenResult!.depthIndex).toBeGreaterThanOrEqual(0);
    expect(highTokenResult!.depthIndex).toBeLessThanOrEqual(1);

    // Extreme low token ratio
    const lowTokenResult = extractReasoningMetrics({
      thinkingTokens: 1,
      outputTokens: 1000,
      thinkingBudgetTokens: 100,
      thinkingDurationMs: 10,
      totalDurationMs: 1000,
    });
    expect(lowTokenResult!.depthIndex).toBeGreaterThanOrEqual(0);
    expect(lowTokenResult!.depthIndex).toBeLessThanOrEqual(1);
  });

  it('should handle zero output tokens gracefully', () => {
    const result = extractReasoningMetrics({
      thinkingTokens: 1000,
      outputTokens: 0,
      thinkingBudgetTokens: 2000,
      thinkingDurationMs: 500,
      totalDurationMs: 1000,
    });

    expect(result).not.toBeNull();
    expect(result!.thinkingToOutputRatio).toBeNull();
  });

  it('should handle zero total duration', () => {
    const result = extractReasoningMetrics({
      thinkingTokens: 1000,
      outputTokens: 500,
      thinkingBudgetTokens: 2000,
      thinkingDurationMs: 0,
      totalDurationMs: 0,
    });

    expect(result).not.toBeNull();
    expect(result!.depthIndex).toBeGreaterThanOrEqual(0);
    expect(result!.depthIndex).toBeLessThanOrEqual(1);
  });
});

describe('reasoningMetricsToCustomAttributes', () => {
  it('should return empty object for null metrics', () => {
    const result = reasoningMetricsToCustomAttributes(null);
    expect(result).toEqual({});
  });

  it('should convert reasoning metrics to custom attributes', () => {
    const metrics = extractReasoningMetrics({
      thinkingTokens: 1000,
      outputTokens: 500,
      thinkingBudgetTokens: 2000,
      thinkingDurationMs: 500,
      totalDurationMs: 1000,
    })!;

    const attrs = reasoningMetricsToCustomAttributes(metrics);

    expect(attrs['ai.reasoning.thinking_tokens']).toBe(1000);
    expect(attrs['ai.reasoning.thinking_budget_tokens']).toBe(2000);
    expect(attrs['ai.reasoning.budget_utilization']).toBe(0.5);
    expect(attrs['ai.reasoning.thinking_to_output_ratio']).toBe(2);
    expect(attrs['ai.reasoning.depth_index']).toBeDefined();
    expect(attrs['ai.reasoning.thinking_duration_ms']).toBe(500);
  });

  it('should round depth_index to 3 decimal places', () => {
    const metrics = extractReasoningMetrics({
      thinkingTokens: 1000,
      outputTokens: 500,
      thinkingBudgetTokens: 2000,
      thinkingDurationMs: 333,
      totalDurationMs: 1000,
    })!;

    const attrs = reasoningMetricsToCustomAttributes(metrics);
    const depthIndex = attrs['ai.reasoning.depth_index'] as number;

    // Verify it's rounded to 3 decimal places
    expect(depthIndex).toBe(Math.round(depthIndex * 1000) / 1000);
  });

  it('should omit null fields from attributes', () => {
    const metrics = extractReasoningMetrics({
      thinkingTokens: 1000,
      outputTokens: 500,
      thinkingBudgetTokens: null,
      thinkingDurationMs: null,
      totalDurationMs: 1000,
    })!;

    const attrs = reasoningMetricsToCustomAttributes(metrics);

    expect(attrs['ai.reasoning.thinking_budget_tokens']).toBeUndefined();
    expect(attrs['ai.reasoning.budget_utilization']).toBeUndefined();
    expect(attrs['ai.reasoning.thinking_duration_ms']).toBeUndefined();
    expect(attrs['ai.reasoning.thinking_tokens']).toBe(1000);
    expect(attrs['ai.reasoning.thinking_to_output_ratio']).toBe(2);
  });
});
