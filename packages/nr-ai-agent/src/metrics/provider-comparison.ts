export interface ProviderModelStats {
  readonly provider: string;
  readonly model: string;
  readonly category: string;
  readonly requestCount: number;
  readonly avgDurationMs: number;
  readonly p95DurationMs: number;
  readonly avgTtftMs: number;
  readonly avgTokensPerSecond: number;
  readonly avgCostPerRequestUsd: number;
  readonly errorRate: number;
  readonly avgThinkingTokens: number;
  readonly avgDepthIndex: number | null;
}

interface RollingDataPoint {
  durationMs: number;
  ttftMs: number | null;
  tokensPerSecond: number;
  costUsd: number;
  hasError: boolean;
  thinkingTokens: number;
  depthIndex: number | null;
}

interface ProviderModelData {
  dataPoints: RollingDataPoint[];
  errorCount: number;
}

const DEFAULT_WINDOW_SIZE = 100;

export class ProviderComparisonAggregator {
  private windowSize: number;
  private data = new Map<string, ProviderModelData>();

  constructor(windowSize: number = DEFAULT_WINDOW_SIZE) {
    this.windowSize = windowSize;
  }

  record(
    provider: string,
    model: string,
    durationMs: number,
    ttftMs: number | null,
    tokensPerSecond: number,
    costUsd: number,
    hasError: boolean,
    thinkingTokens: number = 0,
    depthIndex: number | null = null,
    category: string | null = null,
  ): void {
    const key = this.makeKey(provider, model, category);

    let entry = this.data.get(key);
    if (!entry) {
      entry = { dataPoints: [], errorCount: 0 };
      this.data.set(key, entry);
    }

    const dataPoint: RollingDataPoint = {
      durationMs,
      ttftMs,
      tokensPerSecond,
      costUsd,
      hasError,
      thinkingTokens,
      depthIndex,
    };

    entry.dataPoints.push(dataPoint);
    if (hasError) {
      entry.errorCount += 1;
    }

    // Evict oldest data if window exceeded
    if (entry.dataPoints.length > this.windowSize) {
      const removed = entry.dataPoints.shift()!;
      if (removed.hasError) {
        entry.errorCount -= 1;
      }
    }
  }

  getMetrics(provider: string, model: string, category: string | null = null): ProviderModelStats | null {
    const key = this.makeKey(provider, model, category);
    const entry = this.data.get(key);

    if (!entry || entry.dataPoints.length === 0) {
      return null;
    }

    const dataPoints = entry.dataPoints;
    const requestCount = dataPoints.length;

    // Calculate averages
    const avgDurationMs = dataPoints.reduce((sum, dp) => sum + dp.durationMs, 0) / requestCount;
    const avgTtftMs = dataPoints
      .filter((dp) => dp.ttftMs !== null)
      .reduce((sum, dp) => sum + (dp.ttftMs || 0), 0) / (dataPoints.filter((dp) => dp.ttftMs !== null).length || 1);
    const avgTokensPerSecond = dataPoints.reduce((sum, dp) => sum + dp.tokensPerSecond, 0) / requestCount;
    const avgCostPerRequestUsd = dataPoints.reduce((sum, dp) => sum + dp.costUsd, 0) / requestCount;
    const errorRate = entry.errorCount / requestCount;
    const avgThinkingTokens = dataPoints.reduce((sum, dp) => sum + dp.thinkingTokens, 0) / requestCount;

    // Calculate p95
    const sortedDurations = [...dataPoints].map((dp) => dp.durationMs).sort((a, b) => a - b);
    const p95Index = Math.ceil(requestCount * 0.95) - 1;
    const p95DurationMs = sortedDurations[Math.max(0, p95Index)];

    // Calculate average depthIndex (only for data points that have it)
    let avgDepthIndex: number | null = null;
    const pointsWithDepth = dataPoints.filter((dp) => dp.depthIndex !== null);
    if (pointsWithDepth.length > 0) {
      avgDepthIndex =
        pointsWithDepth.reduce((sum, dp) => sum + (dp.depthIndex || 0), 0) / pointsWithDepth.length;
    }

    return {
      provider,
      model,
      category: category || 'all',
      requestCount,
      avgDurationMs: Math.round(avgDurationMs * 100) / 100,
      p95DurationMs: Math.round(p95DurationMs * 100) / 100,
      avgTtftMs: Math.round(avgTtftMs * 100) / 100,
      avgTokensPerSecond: Math.round(avgTokensPerSecond * 100) / 100,
      avgCostPerRequestUsd: Math.round(avgCostPerRequestUsd * 1000000) / 1000000,
      errorRate: Math.round(errorRate * 10000) / 10000,
      avgThinkingTokens: Math.round(avgThinkingTokens * 100) / 100,
      avgDepthIndex: avgDepthIndex !== null ? Math.round(avgDepthIndex * 10000) / 10000 : null,
    };
  }

  getAllMetrics(): ProviderModelStats[] {
    const result: ProviderModelStats[] = [];

    for (const key of this.data.keys()) {
      const [provider, model, category] = this.parseKey(key);
      const metrics = this.getMetrics(provider, model, category);
      if (metrics) {
        result.push(metrics);
      }
    }

    return result;
  }

  snapshot(): Map<string, ProviderModelStats> {
    const result = new Map<string, ProviderModelStats>();

    for (const key of this.data.keys()) {
      const [provider, model, category] = this.parseKey(key);
      const metrics = this.getMetrics(provider, model, category);
      if (metrics) {
        result.set(key, metrics);
      }
    }

    return result;
  }

  reset(): void {
    this.data.clear();
  }

  private makeKey(provider: string, model: string, category: string | null): string {
    const cat = category || 'all';
    return `${provider}:${model}:${cat}`;
  }

  private parseKey(key: string): [string, string, string | null] {
    const [provider, model, cat] = key.split(':');
    return [provider, model, cat === 'all' ? null : cat];
  }
}

export function providerModelStatsToNrEvent(
  metrics: ProviderModelStats,
  appName: string,
): Record<string, string | number> {
  const event: Record<string, string | number> = {
    eventType: 'AiProviderComparison',
    'nr.appName': appName,
    provider: metrics.provider,
    model: metrics.model,
    category: metrics.category,
    requestCount: metrics.requestCount,
    avgDurationMs: metrics.avgDurationMs,
    p95DurationMs: metrics.p95DurationMs,
    avgTtftMs: metrics.avgTtftMs,
    avgTokensPerSecond: metrics.avgTokensPerSecond,
    avgCostPerRequestUsd: metrics.avgCostPerRequestUsd,
    errorRate: metrics.errorRate,
    avgThinkingTokens: metrics.avgThinkingTokens,
  };
  if (metrics.avgDepthIndex !== null) {
    event.avgDepthIndex = metrics.avgDepthIndex;
  }
  return event;
}

export function comparisonMetricsToCustomAttributes(metrics: ProviderModelStats): Record<string, string | number> {
  const attrs: Record<string, string | number> = {
    'ai.provider.name': metrics.provider,
    'ai.provider.model': metrics.model,
    'ai.provider.category': metrics.category,
    'ai.provider.request_count': metrics.requestCount,
    'ai.provider.avg_duration_ms': metrics.avgDurationMs,
    'ai.provider.p95_duration_ms': metrics.p95DurationMs,
    'ai.provider.avg_ttft_ms': metrics.avgTtftMs,
    'ai.provider.avg_tokens_per_second': metrics.avgTokensPerSecond,
    'ai.provider.avg_cost_per_request_usd': metrics.avgCostPerRequestUsd,
    'ai.provider.error_rate': metrics.errorRate,
    'ai.provider.avg_thinking_tokens': metrics.avgThinkingTokens,
  };

  if (metrics.avgDepthIndex !== null) {
    attrs['ai.provider.avg_depth_index'] = metrics.avgDepthIndex;
  }

  return attrs;
}
