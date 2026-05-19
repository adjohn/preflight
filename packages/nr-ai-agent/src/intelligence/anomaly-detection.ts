export interface AnomalyResult {
  readonly anomalous: boolean;
  readonly zScore: number;
  readonly baselineMean: number;
  readonly baselineStdDev: number;
}

export interface SignalState {
  readonly signalName: string;
  readonly currentValue: number;
  readonly baselineMean: number;
  readonly baselineStdDev: number;
  readonly zScore: number;
  readonly anomalous: boolean;
  readonly sampleCount: number;
}

export interface AnomalyReport {
  readonly signals: ReadonlyArray<SignalState>;
  readonly compositeScore: number;
  readonly anomalousSignals: ReadonlyArray<string>;
  readonly timestamp: number;
}

export interface AnomalyDetectorOptions {
  readonly baselineWindowMs?: number;
  readonly maxSamples?: number;
  readonly zScoreThreshold?: number;
  readonly minSamplesToDetect?: number;
  readonly structuralSignalWeight?: number;
  readonly applicationSignalWeight?: number;
  readonly semanticSignalWeight?: number;
}

interface RollingWindowEntry {
  timestamp: number;
  value: number;
}

interface PerSignalState {
  rollingWindow: RollingWindowEntry[];
  currentValue: number;
  anomalous: boolean;
  zScore: number;
}

export class AnomalyDetector {
  private signals: Map<string, PerSignalState> = new Map();
  private baselineWindowMs: number;
  private maxSamples: number;
  private zScoreThreshold: number;
  private minSamplesToDetect: number;
  private structuralSignalWeight: number;
  private applicationSignalWeight: number;
  private semanticSignalWeight: number;
  private lastReport: AnomalyReport | null = null;

  private readonly structuralSignals = new Set([
    'stop_reason',
    'response_length',
    'latency_ms',
    'error_rate',
    'thinking_depth',
  ]);

  private readonly applicationSignals = new Set([
    'user_feedback',
    'regeneration_rate',
    'edit_distance',
  ]);

  private readonly semanticSignals = new Set(['drift_score']);

  constructor(options?: AnomalyDetectorOptions) {
    this.baselineWindowMs = options?.baselineWindowMs ?? 7 * 24 * 60 * 60 * 1000;
    this.maxSamples = options?.maxSamples ?? 10000;
    this.zScoreThreshold = options?.zScoreThreshold ?? 2.0;
    this.minSamplesToDetect = options?.minSamplesToDetect ?? 100;
    this.structuralSignalWeight = options?.structuralSignalWeight ?? 0.3;
    this.applicationSignalWeight = options?.applicationSignalWeight ?? 0.5;
    this.semanticSignalWeight = options?.semanticSignalWeight ?? 0.2;
  }

  recordSignal(signalName: string, value: number, timestamp: number): void {
    let state = this.signals.get(signalName);
    if (!state) {
      state = {
        rollingWindow: [],
        currentValue: value,
        anomalous: false,
        zScore: 0,
      };
      this.signals.set(signalName, state);
    }

    state.currentValue = value;
    state.rollingWindow.push({ timestamp, value });

    const cutoffTime = timestamp - this.baselineWindowMs;
    state.rollingWindow = state.rollingWindow.filter((e) => e.timestamp >= cutoffTime);

    if (state.rollingWindow.length > this.maxSamples) {
      const excess = state.rollingWindow.length - this.maxSamples;
      state.rollingWindow = state.rollingWindow.slice(excess);
    }

    if (state.rollingWindow.length > this.minSamplesToDetect) {
      const stats = this.computeStats(state.rollingWindow);
      state.zScore = (value - stats.mean) / (stats.stdDev + 0.0001);
      state.anomalous = Math.abs(state.zScore) > this.zScoreThreshold;
    }
  }

  checkAnomaly(signalName: string, value: number): AnomalyResult {
    const state = this.signals.get(signalName);

    if (!state || state.rollingWindow.length < this.minSamplesToDetect) {
      return {
        anomalous: false,
        zScore: 0,
        baselineMean: 0,
        baselineStdDev: 0,
      };
    }

    const stats = this.computeStats(state.rollingWindow);
    const zScore = (value - stats.mean) / (stats.stdDev + 0.0001);
    const anomalous = Math.abs(zScore) > this.zScoreThreshold;

    return {
      anomalous,
      zScore,
      baselineMean: stats.mean,
      baselineStdDev: stats.stdDev,
    };
  }

  getCompositeScore(): number {
    if (this.signals.size === 0) {
      return 0.0;
    }

    let structuralAnomalies = 0;
    let structuralTotal = 0;
    let applicationAnomalies = 0;
    let applicationTotal = 0;
    let semanticAnomalies = 0;
    let semanticTotal = 0;

    for (const [signalName, state] of this.signals) {
      if (state.rollingWindow.length < this.minSamplesToDetect) {
        continue;
      }

      if (this.structuralSignals.has(signalName)) {
        structuralTotal += 1;
        if (state.anomalous) {
          structuralAnomalies += 1;
        }
      } else if (this.applicationSignals.has(signalName)) {
        applicationTotal += 1;
        if (state.anomalous) {
          applicationAnomalies += 1;
        }
      } else if (this.semanticSignals.has(signalName)) {
        semanticTotal += 1;
        if (state.anomalous) {
          semanticAnomalies += 1;
        }
      }
    }

    let totalWeight = 0;
    let weightedScore = 0;

    if (structuralTotal > 0) {
      const structuralScore = structuralAnomalies / structuralTotal;
      totalWeight += this.structuralSignalWeight;
      weightedScore += structuralScore * this.structuralSignalWeight;
    }

    if (applicationTotal > 0) {
      const applicationScore = applicationAnomalies / applicationTotal;
      totalWeight += this.applicationSignalWeight;
      weightedScore += applicationScore * this.applicationSignalWeight;
    }

    if (semanticTotal > 0) {
      const semanticScore = semanticAnomalies / semanticTotal;
      totalWeight += this.semanticSignalWeight;
      weightedScore += semanticScore * this.semanticSignalWeight;
    }

    if (totalWeight === 0) {
      return 0.0;
    }

    const compositeScore = weightedScore / totalWeight;
    return Math.min(1.0, Math.max(0.0, compositeScore));
  }

  getAnomalyReport(): AnomalyReport {
    const timestamp = Date.now();
    const signalStates: SignalState[] = [];
    const anomalousSignals: string[] = [];

    for (const [signalName, state] of this.signals) {
      if (state.rollingWindow.length < this.minSamplesToDetect) {
        continue;
      }

      const stats = this.computeStats(state.rollingWindow);
      const signalState: SignalState = {
        signalName,
        currentValue: state.currentValue,
        baselineMean: stats.mean,
        baselineStdDev: stats.stdDev,
        zScore: state.zScore,
        anomalous: state.anomalous,
        sampleCount: state.rollingWindow.length,
      };

      signalStates.push(signalState);

      if (state.anomalous) {
        anomalousSignals.push(signalName);
      }
    }

    const report: AnomalyReport = {
      signals: signalStates,
      compositeScore: this.getCompositeScore(),
      anomalousSignals,
      timestamp,
    };

    this.lastReport = report;
    return report;
  }

  private computeStats(window: RollingWindowEntry[]): { mean: number; stdDev: number } {
    if (window.length === 0) {
      return { mean: 0, stdDev: 0 };
    }

    const values = window.map((e) => e.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;

    const variance =
      values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;

    const stdDev = Math.sqrt(variance);

    return { mean, stdDev };
  }
}
