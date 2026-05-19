import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ExperimentConfig {
  readonly name: string;
  readonly variants: ReadonlyArray<string>;
  readonly metrics: ReadonlyArray<string>;
  readonly startDate: Date;
  readonly endDate?: Date;
}

export interface VariantStats {
  readonly variant: string;
  readonly mean: number;
  readonly median: number;
  readonly p95: number;
  readonly stdDev: number;
  readonly sampleCount: number;
}

export interface PairwiseComparison {
  readonly variant1: string;
  readonly variant2: string;
  readonly relativeDifference: number;
  readonly pValue: number;
  readonly isSignificant: boolean;
}

export interface MetricComparison {
  readonly metric: string;
  readonly variantStats: ReadonlyArray<VariantStats>;
  readonly pairwiseComparisons: ReadonlyArray<PairwiseComparison>;
}

export interface ExperimentResults {
  readonly experimentName: string;
  readonly metrics: ReadonlyArray<MetricComparison>;
  readonly recommendedWinner: string | null;
  readonly timestamp: number;
}

export interface ExperimentTrackerOptions {
  readonly persistPath?: string;
}

interface ExperimentState {
  config: ExperimentConfig;
  dataByVariant: Map<string, Map<string, number[]>>;
}

interface PersistedConfig {
  name: string;
  variants: string[];
  metrics: string[];
  startDate: string;
  endDate?: string;
}

export class ExperimentTracker {
  private experiments: Map<string, ExperimentState> = new Map();
  private readonly variantStorage = new AsyncLocalStorage<Map<string, string>>();
  private readonly persistPath: string | null;

  constructor(options?: ExperimentTrackerOptions) {
    this.persistPath = options?.persistPath ?? null;
    if (this.persistPath) {
      this.loadFromDisk();
    }
  }

  defineExperiment(config: ExperimentConfig): void {
    this.setupExperiment(config);
    this.saveToDisk();
  }

  private setupExperiment(config: ExperimentConfig): void {
    this.experiments.set(config.name, {
      config,
      dataByVariant: new Map(),
    });

    for (const variant of config.variants) {
      const variantData = new Map<string, number[]>();
      for (const metric of config.metrics) {
        variantData.set(metric, []);
      }
      this.experiments.get(config.name)!.dataByVariant.set(variant, variantData);
    }
  }

  tagRequest(experimentName: string, variant: string): void {
    const experiment = this.experiments.get(experimentName);
    if (!experiment) {
      return;
    }

    if (!experiment.config.variants.includes(variant)) {
      return;
    }

    const current = this.variantStorage.getStore() ?? new Map<string, string>();
    const updated = new Map(current);
    updated.set(experimentName, variant);
    this.variantStorage.enterWith(updated);
  }

  recordMetricValue(experimentName: string, variant: string, metricName: string, value: number): void {
    const experiment = this.experiments.get(experimentName);
    if (!experiment) {
      return;
    }

    const variantData = experiment.dataByVariant.get(variant);
    if (!variantData) {
      return;
    }

    const metricValues = variantData.get(metricName);
    if (!metricValues) {
      return;
    }

    metricValues.push(value);
  }

  getCurrentVariant(experimentName: string): string | null {
    return this.variantStorage.getStore()?.get(experimentName) ?? null;
  }

  getActiveVariants(): ReadonlyMap<string, string> {
    return this.variantStorage.getStore() ?? new Map();
  }

  getExperimentNames(): ReadonlyArray<string> {
    return Array.from(this.experiments.keys());
  }

  getExperimentConfig(experimentName: string): ExperimentConfig | null {
    return this.experiments.get(experimentName)?.config ?? null;
  }

  getExperimentResults(experimentName: string): ExperimentResults {
    const experiment = this.experiments.get(experimentName);
    if (!experiment) {
      return {
        experimentName,
        metrics: [],
        recommendedWinner: null,
        timestamp: Date.now(),
      };
    }

    const metrics: MetricComparison[] = [];

    for (const metric of experiment.config.metrics) {
      const variantStats: VariantStats[] = [];

      for (const variant of experiment.config.variants) {
        const variantData = experiment.dataByVariant.get(variant);
        if (!variantData) continue;

        const values = variantData.get(metric) ?? [];
        if (values.length === 0) continue;

        variantStats.push({
          variant,
          mean: this.calculateMean(values),
          median: this.calculateMedian(values),
          p95: this.calculatePercentile(values, 0.95),
          stdDev: this.calculateStdDev(values),
          sampleCount: values.length,
        });
      }

      const pairwiseComparisons: PairwiseComparison[] = [];

      for (let i = 0; i < variantStats.length; i++) {
        for (let j = i + 1; j < variantStats.length; j++) {
          const stat1 = variantStats[i];
          const stat2 = variantStats[j];

          const relativeDifference =
            stat1.mean !== 0 ? ((stat2.mean - stat1.mean) / stat1.mean) * 100 : 0;
          const pValue = this.calculateTTest(
            experiment.dataByVariant.get(stat1.variant)?.get(metric) ?? [],
            experiment.dataByVariant.get(stat2.variant)?.get(metric) ?? [],
          );

          pairwiseComparisons.push({
            variant1: stat1.variant,
            variant2: stat2.variant,
            relativeDifference,
            pValue,
            isSignificant: pValue < 0.05,
          });
        }
      }

      metrics.push({
        metric,
        variantStats,
        pairwiseComparisons,
      });
    }

    // Tally significant wins and losses per variant across ALL metrics.
    // A winner must have at least one win and zero losses.
    const winCounts = new Map<string, number>();
    const lossCounts = new Map<string, number>();

    for (const mc of metrics) {
      for (const comp of mc.pairwiseComparisons) {
        if (!comp.isSignificant) continue;
        const winner = comp.relativeDifference < 0 ? comp.variant2 : comp.variant1;
        const loser = comp.relativeDifference < 0 ? comp.variant1 : comp.variant2;
        winCounts.set(winner, (winCounts.get(winner) ?? 0) + 1);
        lossCounts.set(loser, (lossCounts.get(loser) ?? 0) + 1);
      }
    }

    let recommendedWinner: string | null = null;
    let bestWins = 0;
    for (const [variant, wins] of winCounts) {
      if ((lossCounts.get(variant) ?? 0) === 0 && wins > bestWins) {
        bestWins = wins;
        recommendedWinner = variant;
      }
    }

    return {
      experimentName,
      metrics,
      recommendedWinner,
      timestamp: Date.now(),
    };
  }

  private saveToDisk(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const configs: PersistedConfig[] = Array.from(this.experiments.values()).map(({ config }) => ({
        name: config.name,
        variants: [...config.variants],
        metrics: [...config.metrics],
        startDate: config.startDate.toISOString(),
        endDate: config.endDate?.toISOString(),
      }));
      writeFileSync(this.persistPath, JSON.stringify(configs, null, 2), { mode: 0o600 });
    } catch {
      // best-effort — persistence failure should not crash the tracker
    }
  }

  private loadFromDisk(): void {
    if (!this.persistPath) return;
    try {
      const raw = readFileSync(this.persistPath, 'utf-8');
      const configs = JSON.parse(raw) as PersistedConfig[];
      for (const c of configs) {
        this.setupExperiment({
          name: c.name,
          variants: c.variants,
          metrics: c.metrics,
          startDate: new Date(c.startDate),
          endDate: c.endDate ? new Date(c.endDate) : undefined,
        });
      }
    } catch {
      // file not found or malformed — start with empty state
    }
  }

  private calculateMean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private calculateMedian(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  private calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    // percentile is 0–1 (e.g. 0.95 for p95); compute the 1-based rank position
    const index = Math.ceil(percentile * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
  }

  private calculateStdDev(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = this.calculateMean(values);
    const variance = values.reduce((sum, val) => sum + (val - mean) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
  }

  private calculateTTest(values1: number[], values2: number[]): number {
    if (values1.length < 2 || values2.length < 2) {
      return 1.0;
    }

    const mean1 = this.calculateMean(values1);
    const mean2 = this.calculateMean(values2);
    const std1 = this.calculateStdDev(values1);
    const std2 = this.calculateStdDev(values2);

    if (std1 === 0 && std2 === 0) {
      return mean1 === mean2 ? 1.0 : 0.0;
    }

    const se = Math.sqrt((std1 ** 2 / values1.length) + (std2 ** 2 / values2.length));
    if (se === 0) {
      return 1.0;
    }

    const t = Math.abs((mean1 - mean2) / se);
    const df = values1.length + values2.length - 2;

    return this.tTestToPValue(t, df);
  }

  private tTestToPValue(t: number, df: number): number {
    if (t === 0) {
      return 1.0;
    }

    // Two-tailed p-value via regularised incomplete beta function
    // p = I_x(df/2, 0.5) where x = df / (t^2 + df)
    const x = df / (t * t + df);
    const p = this.incompleteBeta(x, df / 2, 0.5);
    return Math.min(1.0, Math.max(0.0, p));
  }

  private incompleteBeta(x: number, a: number, b: number): number {
    if (x <= 0) return 0;
    if (x >= 1) return 1;

    const maxIterations = 100;
    let result = 1;
    let term = 1;

    for (let i = 0; i < maxIterations; i++) {
      const numerator = (a + b) * x * (1 - x);
      const denominator = (a + 1) * (1 + numerator);

      term *= numerator / denominator;
      result += term;

      if (Math.abs(term) < 1e-10) break;
    }

    return (Math.exp((a * Math.log(x)) + (b * Math.log(1 - x))) / a) * result;
  }
}
