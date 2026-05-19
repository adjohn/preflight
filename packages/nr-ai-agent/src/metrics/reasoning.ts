export interface ReasoningMetrics {
  readonly thinkingTokens: number;
  readonly thinkingBudgetTokens: number | null;
  readonly budgetUtilization: number | null;
  readonly thinkingToOutputRatio: number | null;
  readonly depthIndex: number | null;
  readonly thinkingDurationMs: number | null;
  readonly thinkingEfficiency: number | null;
}

interface ExtractReasoningParams {
  thinkingTokens: number;
  outputTokens: number;
  thinkingBudgetTokens: number | null;
  thinkingDurationMs: number | null;
  totalDurationMs: number;
}

function normalize(value: number, min: number = 0, max: number = 1): number {
  if (value <= min) return 0;
  if (value >= max) return 1;
  return (value - min) / (max - min);
}

function calculateDepthIndex(params: ExtractReasoningParams): number | null {
  if (params.thinkingTokens === 0 || params.outputTokens === 0) {
    return null;
  }

  const tokenRatio = params.thinkingTokens / params.outputTokens;
  const timeRatio = params.thinkingDurationMs && params.totalDurationMs > 0
    ? params.thinkingDurationMs / params.totalDurationMs
    : 0;
  const budgetUtil = params.thinkingBudgetTokens
    ? params.thinkingTokens / params.thinkingBudgetTokens
    : 0;

  // Weighted sum of normalized components
  const normalizedTokenRatio = normalize(tokenRatio, 0, 5); // Clamp token ratio at 5:1
  const normalizedTimeRatio = normalize(timeRatio, 0, 0.8); // Clamp time ratio at 80%
  const normalizedBudgetUtil = Math.min(budgetUtil, 1); // Budget util is already 0-1

  const depthScore = (
    normalizedTokenRatio * 0.4 +
    normalizedTimeRatio * 0.3 +
    normalizedBudgetUtil * 0.3
  );

  return Math.min(Math.max(depthScore, 0), 1);
}

export function extractReasoningMetrics(params: ExtractReasoningParams): ReasoningMetrics | null {
  // Return null if no thinking tokens used
  if (params.thinkingTokens === 0) {
    return null;
  }

  const budgetUtilization = params.thinkingBudgetTokens
    ? Math.min(params.thinkingTokens / params.thinkingBudgetTokens, 1)
    : null;

  const thinkingToOutputRatio = params.outputTokens > 0
    ? params.thinkingTokens / params.outputTokens
    : null;

  const depthIndex = calculateDepthIndex(params);

  const thinkingEfficiency =
    params.thinkingDurationMs !== null && params.thinkingDurationMs > 0
      ? (params.thinkingTokens / params.thinkingDurationMs) * 1000
      : null;

  return {
    thinkingTokens: params.thinkingTokens,
    thinkingBudgetTokens: params.thinkingBudgetTokens,
    budgetUtilization,
    thinkingToOutputRatio,
    depthIndex,
    thinkingDurationMs: params.thinkingDurationMs,
    thinkingEfficiency,
  };
}

export function reasoningMetricsToCustomAttributes(
  metrics: ReasoningMetrics | null,
): Record<string, string | number> {
  if (!metrics) {
    return {};
  }

  const attrs: Record<string, string | number> = {
    'ai.reasoning.thinking_tokens': metrics.thinkingTokens,
  };

  if (metrics.thinkingBudgetTokens !== null) {
    attrs['ai.reasoning.thinking_budget_tokens'] = metrics.thinkingBudgetTokens;
  }

  if (metrics.budgetUtilization !== null) {
    attrs['ai.reasoning.budget_utilization'] = Math.round(metrics.budgetUtilization * 1000) / 1000;
  }

  if (metrics.thinkingToOutputRatio !== null) {
    attrs['ai.reasoning.thinking_to_output_ratio'] = Math.round(metrics.thinkingToOutputRatio * 1000) / 1000;
  }

  if (metrics.depthIndex !== null) {
    attrs['ai.reasoning.depth_index'] = Math.round(metrics.depthIndex * 1000) / 1000;
  }

  if (metrics.thinkingDurationMs !== null) {
    attrs['ai.reasoning.thinking_duration_ms'] = metrics.thinkingDurationMs;
  }

  if (metrics.thinkingEfficiency !== null) {
    attrs['ai.reasoning.thinking_efficiency'] = Math.round(metrics.thinkingEfficiency * 100) / 100;
  }

  return attrs;
}
