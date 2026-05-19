import { createLogger } from '@nr-ai-observatory/shared';

const logger = createLogger('quality-tracker');

export interface QualitySignalInput {
  readonly durationMs: number;
  readonly timeToFirstTokenMs: number | null;
  readonly outputTokens: number;
  readonly stopReason: string | null;
  readonly error: unknown;
  readonly depthIndex?: number | null;
}

const DEFAULT_WINDOW_SIZE = 100;
const DEFAULT_ERROR_RATE_THRESHOLD = 0.05; // 5%
const ANOMALY_THRESHOLD_STDDEV = 2.0;

export interface QualityMetrics {
  readonly qualityScore: number;
  readonly maxTokensHitRate: number;
  readonly errorRate: number;
  readonly hasLatencyAnomaly: boolean;
  readonly hasLengthAnomaly: boolean;
  readonly avgResponseLength: number;
  readonly avgLatencyMs: number;
  readonly feedbackCount: number;
  readonly avgFeedbackScore: number | null;
  readonly regenerationRate: number;
  readonly avgEditDistance: number | null;
}

interface RollingDataPoint {
  durationMs: number;
  timeToFirstTokenMs: number | null;
  outputTokens: number;
  stopReason: string | null;
  hasError: boolean;
  depthIndex: number | null;
}

interface FeedbackRecord {
  score: number;
  metadata?: Record<string, string>;
}

export class QualityTracker {
  private windowSize: number;
  private errorRateThreshold: number;
  private dataWindow: RollingDataPoint[] = [];
  private feedbackMap = new Map<string, FeedbackRecord>();
  private regenerationCount = 0;
  private editDistanceValues: number[] = [];

  constructor(windowSize: number = DEFAULT_WINDOW_SIZE, errorRateThreshold: number = DEFAULT_ERROR_RATE_THRESHOLD) {
    this.windowSize = windowSize;
    this.errorRateThreshold = errorRateThreshold;
  }

  recordStructuralSignals(response: QualitySignalInput): Record<string, number | boolean> {
    const dataPoint: RollingDataPoint = {
      durationMs: response.durationMs,
      timeToFirstTokenMs: response.timeToFirstTokenMs ?? null,
      outputTokens: response.outputTokens,
      stopReason: response.stopReason ?? null,
      hasError: !!response.error,
      depthIndex: response.depthIndex ?? null,
    };

    this.dataWindow.push(dataPoint);
    if (this.dataWindow.length > this.windowSize) {
      this.dataWindow.shift();
    }

    const anomalyFlags: Record<string, number | boolean> = {};

    // Check for response length anomaly
    if (this.dataWindow.length >= 10) {
      const { isAnomaly, mean, stdDev } = this.detectLengthAnomaly();
      anomalyFlags['ai.quality.length_anomaly'] = isAnomaly ? 1 : 0;
      anomalyFlags['ai.quality.avg_response_length'] = Math.round(mean * 100) / 100;
      if (stdDev !== null) {
        anomalyFlags['ai.quality.response_length_stddev'] = Math.round(stdDev * 100) / 100;
      }
    }

    // Check for latency anomaly
    if (this.dataWindow.length >= 10) {
      const { isAnomaly, mean, stdDev } = this.detectLatencyAnomaly();
      anomalyFlags['ai.quality.latency_anomaly'] = isAnomaly ? 1 : 0;
      anomalyFlags['ai.quality.avg_latency_ms'] = Math.round(mean * 100) / 100;
      if (stdDev !== null) {
        anomalyFlags['ai.quality.latency_stddev'] = Math.round(stdDev * 100) / 100;
      }
    }

    // Track max_tokens hit rate
    const maxTokensHitRate = this.calculateMaxTokensHitRate();
    anomalyFlags['ai.quality.max_tokens_hit_rate'] = Math.round(maxTokensHitRate * 10000) / 10000;

    // Track error rate
    const errorRate = this.calculateErrorRate();
    anomalyFlags['ai.quality.error_rate'] = Math.round(errorRate * 10000) / 10000;

    return anomalyFlags;
  }

  recordFeedback(requestId: string, score: number, metadata?: Record<string, string>): void {
    if (score < 0 || score > 1) {
      logger.warn('Invalid feedback score (must be 0-1)', { requestId, score });
      return;
    }
    this.feedbackMap.set(requestId, { score, metadata });
  }

  recordRegeneration(_requestId: string): void {
    this.regenerationCount += 1;
  }

  recordEditDistance(requestId: string, editDistance: number): void {
    if (editDistance < 0 || editDistance > 1) {
      logger.warn('Invalid edit distance (must be 0-1)', { requestId, editDistance });
      return;
    }
    this.editDistanceValues.push(editDistance);
    if (this.editDistanceValues.length > this.windowSize) {
      this.editDistanceValues.shift();
    }
  }

  getMetrics(): QualityMetrics {
    const maxTokensHitRate = this.calculateMaxTokensHitRate();
    const errorRate = this.calculateErrorRate();
    const { isAnomaly: hasLatencyAnomaly } = this.detectLatencyAnomaly();
    const { isAnomaly: hasLengthAnomaly, mean: avgResponseLength } = this.detectLengthAnomaly();

    let avgFeedbackScore: number | null = null;
    if (this.feedbackMap.size > 0) {
      const sum = Array.from(this.feedbackMap.values()).reduce((acc, f) => acc + f.score, 0);
      avgFeedbackScore = sum / this.feedbackMap.size;
    }

    let avgEditDistance: number | null = null;
    if (this.editDistanceValues.length > 0) {
      const sum = this.editDistanceValues.reduce((acc, val) => acc + val, 0);
      avgEditDistance = sum / this.editDistanceValues.length;
    }

    const regenerationRate = this.dataWindow.length > 0 ? this.regenerationCount / this.dataWindow.length : 0;

    // Composite quality score calculation
    let qualityScore = 1.0;

    // Penalty for max_tokens hits
    qualityScore -= maxTokensHitRate * 0.3;

    // Penalty for errors
    qualityScore -= errorRate * 0.3;

    // Penalty for latency anomaly
    if (hasLatencyAnomaly) {
      qualityScore -= 0.2;
    }

    // Penalty for length anomaly
    if (hasLengthAnomaly) {
      qualityScore -= 0.2;
    }

    // Boost or penalty for user feedback if available
    if (avgFeedbackScore !== null) {
      const feedbackDelta = avgFeedbackScore - 0.5; // 0.5 is neutral
      qualityScore += feedbackDelta * 0.2; // Higher weight for direct feedback
    }

    // Penalty for regenerations
    if (regenerationRate > 0) {
      qualityScore -= regenerationRate * 0.1;
    }

    // Clamp to 0.0 - 1.0 (after all calculations)
    qualityScore = Math.max(0, Math.min(1.0, qualityScore));

    const avgLatencyMs = this.dataWindow.length > 0
      ? this.dataWindow.reduce((acc, dp) => acc + dp.durationMs, 0) / this.dataWindow.length
      : 0;

    return {
      qualityScore: Math.round(qualityScore * 10000) / 10000,
      maxTokensHitRate: Math.round(maxTokensHitRate * 10000) / 10000,
      errorRate: Math.round(errorRate * 10000) / 10000,
      hasLatencyAnomaly,
      hasLengthAnomaly,
      avgResponseLength: Math.round(avgResponseLength * 100) / 100,
      avgLatencyMs: Math.round(avgLatencyMs * 100) / 100,
      feedbackCount: this.feedbackMap.size,
      avgFeedbackScore: avgFeedbackScore !== null ? Math.round(avgFeedbackScore * 10000) / 10000 : null,
      regenerationRate: Math.round(regenerationRate * 10000) / 10000,
      avgEditDistance: avgEditDistance !== null ? Math.round(avgEditDistance * 10000) / 10000 : null,
    };
  }

  private calculateMaxTokensHitRate(): number {
    if (this.dataWindow.length === 0) return 0;
    const maxTokensCount = this.dataWindow.filter((dp) => dp.stopReason === 'max_tokens').length;
    return maxTokensCount / this.dataWindow.length;
  }

  private calculateErrorRate(): number {
    if (this.dataWindow.length === 0) return 0;
    const errorCount = this.dataWindow.filter((dp) => dp.hasError).length;
    return errorCount / this.dataWindow.length;
  }

  private detectLengthAnomaly(): { isAnomaly: boolean; mean: number; stdDev: number | null } {
    if (this.dataWindow.length < 2) return { isAnomaly: false, mean: 0, stdDev: null };

    const lengths = this.dataWindow.map((dp) => dp.outputTokens);
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((a, val) => a + Math.pow(val - mean, 2), 0) / lengths.length;
    const stdDev = Math.sqrt(variance);

    const lastLength = this.dataWindow[this.dataWindow.length - 1].outputTokens;
    const isAnomaly = stdDev > 0 && Math.abs(lastLength - mean) > ANOMALY_THRESHOLD_STDDEV * stdDev;

    return { isAnomaly, mean, stdDev };
  }

  private detectLatencyAnomaly(): { isAnomaly: boolean; mean: number; stdDev: number | null } {
    if (this.dataWindow.length < 2) return { isAnomaly: false, mean: 0, stdDev: null };

    const latencies = this.dataWindow.map((dp) => dp.durationMs);
    const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const variance = latencies.reduce((a, val) => a + Math.pow(val - mean, 2), 0) / latencies.length;
    const stdDev = Math.sqrt(variance);

    const lastLatency = this.dataWindow[this.dataWindow.length - 1].durationMs;
    const isAnomaly = stdDev > 0 && Math.abs(lastLatency - mean) > ANOMALY_THRESHOLD_STDDEV * stdDev;

    return { isAnomaly, mean, stdDev };
  }

  reset(): void {
    this.dataWindow = [];
    this.feedbackMap.clear();
    this.regenerationCount = 0;
    this.editDistanceValues = [];
  }
}

export function qualityMetricsToCustomAttributes(metrics: QualityMetrics): Record<string, string | number> {
  const attrs: Record<string, string | number> = {
    'ai.quality.score': metrics.qualityScore,
    'ai.quality.max_tokens_hit_rate': metrics.maxTokensHitRate,
    'ai.quality.error_rate': metrics.errorRate,
    'ai.quality.has_latency_anomaly': metrics.hasLatencyAnomaly ? 1 : 0,
    'ai.quality.has_length_anomaly': metrics.hasLengthAnomaly ? 1 : 0,
    'ai.quality.avg_response_length': metrics.avgResponseLength,
    'ai.quality.avg_latency_ms': metrics.avgLatencyMs,
    'ai.quality.feedback_count': metrics.feedbackCount,
    'ai.quality.regeneration_rate': metrics.regenerationRate,
  };

  if (metrics.avgFeedbackScore !== null) {
    attrs['ai.quality.avg_feedback_score'] = metrics.avgFeedbackScore;
  }

  if (metrics.avgEditDistance !== null) {
    attrs['ai.quality.avg_edit_distance'] = metrics.avgEditDistance;
  }

  return attrs;
}
