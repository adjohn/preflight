export interface CostDimensions {
  readonly model?: string;
  readonly feature?: string;
  readonly team?: string;
}

export interface CostForecast {
  readonly projectedDailyCostUsd: ReadonlyArray<number>;
  readonly projectedMonthlyCostUsd: number;
  readonly confidenceIntervalLow: number;
  readonly confidenceIntervalHigh: number;
  readonly growthRatePercent: number;
  readonly projectedBudgetExceedDate: string | null;
}

export type CostAlertType = 'growth' | 'forecast';

export interface CostAlertDetails {
  readonly type: CostAlertType;
  readonly growthRatePercent?: number;
  readonly growthThresholdPercent?: number;
  readonly projectedMonthlyCostUsd?: number;
  readonly monthlyBudgetUsd?: number;
}

export interface CostForecasterOptions {
  readonly bufferDays?: number;
  readonly monthlyBudgetUsd?: number;
  readonly growthThresholdPercent?: number;
  readonly onAlert?: (details: CostAlertDetails) => void;
}

interface HourlyAggregate {
  timestamp: number;
  totalCost: number;
  byModel: Record<string, number>;
  byFeature: Record<string, number>;
  byTeam: Record<string, number>;
}

interface DailyAggregate {
  date: string;
  totalCost: number;
  byModel: Record<string, number>;
  byFeature: Record<string, number>;
  byTeam: Record<string, number>;
}

export class CostForecaster {
  private hourlyBuffer: HourlyAggregate[] = [];
  private bufferDays: number;
  private monthlyBudgetUsd: number | null;
  private growthThresholdPercent: number;
  private onAlert: ((details: CostAlertDetails) => void) | undefined;
  private lastForecastTime: number = 0;
  private cachedForecast: CostForecast | null = null;
  private cacheValidityMs: number = 60 * 60 * 1000;

  constructor(options?: CostForecasterOptions) {
    this.bufferDays = options?.bufferDays ?? 30;
    this.monthlyBudgetUsd = options?.monthlyBudgetUsd ?? this.getMonthlyBudgetFromEnv();
    this.growthThresholdPercent = options?.growthThresholdPercent ?? 10.0;
    this.onAlert = options?.onAlert;
  }

  recordCost(timestamp: number, costUsd: number, dimensions: CostDimensions = {}): void {
    const hourStart = this.getHourStart(timestamp);
    let entry = this.hourlyBuffer.find((e) => e.timestamp === hourStart);

    if (!entry) {
      entry = {
        timestamp: hourStart,
        totalCost: 0,
        byModel: {},
        byFeature: {},
        byTeam: {},
      };
      this.hourlyBuffer.push(entry);
      this.hourlyBuffer.sort((a, b) => a.timestamp - b.timestamp);
    }

    entry.totalCost += costUsd;

    if (dimensions.model) {
      entry.byModel[dimensions.model] ??= 0;
      entry.byModel[dimensions.model] += costUsd;
    }

    if (dimensions.feature) {
      entry.byFeature[dimensions.feature] ??= 0;
      entry.byFeature[dimensions.feature] += costUsd;
    }

    if (dimensions.team) {
      entry.byTeam[dimensions.team] ??= 0;
      entry.byTeam[dimensions.team] += costUsd;
    }

    this.evictOldData(timestamp);
    this.cachedForecast = null;
  }

  forecast(horizonDays: number = 30): CostForecast {
    const now = Date.now();
    if (this.cachedForecast && now - this.lastForecastTime < this.cacheValidityMs) {
      return this.cachedForecast;
    }

    const dailyData = this.aggregateToDaily();

    if (dailyData.length === 0) {
      return {
        projectedDailyCostUsd: Array(horizonDays).fill(0),
        projectedMonthlyCostUsd: 0,
        confidenceIntervalLow: 0,
        confidenceIntervalHigh: 0,
        growthRatePercent: 0,
        projectedBudgetExceedDate: null,
      };
    }

    const dailyCosts = dailyData.map((d) => d.totalCost);
    const regression = this.linearRegression(dailyCosts);
    const seasonalFactor = this.calculateSeasonalFactor(dailyData);

    const projectedDaily: number[] = [];

    for (let i = 0; i < horizonDays; i++) {
      const projectedCost = Math.max(
        0,
        regression.intercept + regression.slope * (dailyData.length + i),
      );
      const seasonalAdjusted = projectedCost * seasonalFactor[i % 7];
      projectedDaily.push(seasonalAdjusted);
    }

    const projectedMonthly = projectedDaily.slice(0, 30).reduce((a, b) => a + b, 0);

    const variance =
      dailyCosts.reduce((sum, cost, idx) => {
        const predicted = regression.intercept + regression.slope * idx;
        return sum + (cost - predicted) ** 2;
      }, 0) / Math.max(1, dailyCosts.length - 1);

    const stdDev = Math.sqrt(variance);
    const confidenceInterval = 1.645 * stdDev;

    // Guard against divide-by-zero when starting cost is zero or near-zero
    const firstCost = dailyCosts[0];
    const lastCost = dailyCosts[dailyCosts.length - 1];
    const growthRate =
      dailyCosts.length >= 2 && firstCost > 0.0001
        ? ((lastCost - firstCost) / firstCost) * 100
        : 0;

    const budgetExceedDate = this.calculateBudgetExceedDate(
      projectedDaily,
      this.monthlyBudgetUsd,
    );

    const forecast: CostForecast = {
      projectedDailyCostUsd: projectedDaily,
      projectedMonthlyCostUsd: projectedMonthly,
      confidenceIntervalLow: Math.max(0, projectedMonthly - confidenceInterval),
      confidenceIntervalHigh: projectedMonthly + confidenceInterval,
      growthRatePercent: growthRate,
      projectedBudgetExceedDate: budgetExceedDate,
    };

    // Fire growth alert when daily growth rate exceeds configured threshold
    if (growthRate > this.growthThresholdPercent && this.onAlert) {
      this.onAlert({
        type: 'growth',
        growthRatePercent: growthRate,
        growthThresholdPercent: this.growthThresholdPercent,
      });
    }

    // Fire forecast alert when projected monthly cost exceeds budget
    if (this.monthlyBudgetUsd !== null && projectedMonthly > this.monthlyBudgetUsd && this.onAlert) {
      this.onAlert({
        type: 'forecast',
        projectedMonthlyCostUsd: projectedMonthly,
        monthlyBudgetUsd: this.monthlyBudgetUsd,
      });
    }

    this.cachedForecast = forecast;
    this.lastForecastTime = now;
    return forecast;
  }

  forecastByDimension(
    dimension: 'model' | 'feature' | 'team',
    horizonDays: number = 30,
  ): Record<string, CostForecast> {
    const result: Record<string, CostForecast> = {};
    const dailyData = this.aggregateToDaily();

    if (dailyData.length === 0) {
      return result;
    }

    const dimensionKey = `by${dimension.charAt(0).toUpperCase()}${dimension.slice(1)}` as
      | 'byModel'
      | 'byFeature'
      | 'byTeam';

    const dimensionNames = new Set<string>();
    for (const daily of dailyData) {
      for (const name of Object.keys(daily[dimensionKey])) {
        dimensionNames.add(name);
      }
    }

    for (const name of dimensionNames) {
      const dimensionCosts = dailyData.map((d) => d[dimensionKey][name] ?? 0);

      if (dimensionCosts.every((c) => c === 0)) {
        continue;
      }

      const regression = this.linearRegression(dimensionCosts);
      const projectedDaily: number[] = [];
      let monthlySum = 0;

      for (let i = 0; i < horizonDays; i++) {
        const projected = Math.max(
          0,
          regression.intercept + regression.slope * (dailyData.length + i),
        );
        projectedDaily.push(projected);
        if (i < 30) {
          monthlySum += projected;
        }
      }

      const variance =
        dimensionCosts.reduce((sum, cost, idx) => {
          const predicted = regression.intercept + regression.slope * idx;
          return sum + (cost - predicted) ** 2;
        }, 0) / Math.max(1, dimensionCosts.length - 1);

      const stdDev = Math.sqrt(variance);
      const confidenceInterval = 1.645 * stdDev;

      result[name] = {
        projectedDailyCostUsd: projectedDaily,
        projectedMonthlyCostUsd: monthlySum,
        confidenceIntervalLow: Math.max(0, monthlySum - confidenceInterval),
        confidenceIntervalHigh: monthlySum + confidenceInterval,
        growthRatePercent:
          dimensionCosts.length >= 2 && dimensionCosts[0] > 0.0001
            ? ((dimensionCosts[dimensionCosts.length - 1] - dimensionCosts[0]) /
                dimensionCosts[0]) *
              100
            : 0,
        projectedBudgetExceedDate: null,
      };
    }

    return result;
  }

  private aggregateToDaily(): DailyAggregate[] {
    const dailyMap = new Map<string, DailyAggregate>();

    for (const hourly of this.hourlyBuffer) {
      const date = this.getDateString(hourly.timestamp);

      if (!dailyMap.has(date)) {
        dailyMap.set(date, {
          date,
          totalCost: 0,
          byModel: {},
          byFeature: {},
          byTeam: {},
        });
      }

      const daily = dailyMap.get(date)!;
      daily.totalCost += hourly.totalCost;

      for (const [model, cost] of Object.entries(hourly.byModel)) {
        daily.byModel[model] ??= 0;
        daily.byModel[model] += cost;
      }

      for (const [feature, cost] of Object.entries(hourly.byFeature)) {
        daily.byFeature[feature] ??= 0;
        daily.byFeature[feature] += cost;
      }

      for (const [team, cost] of Object.entries(hourly.byTeam)) {
        daily.byTeam[team] ??= 0;
        daily.byTeam[team] += cost;
      }
    }

    const result = Array.from(dailyMap.values());
    result.sort((a, b) => a.date.localeCompare(b.date));
    return result;
  }

  private linearRegression(values: number[]): { slope: number; intercept: number } {
    if (values.length === 0) {
      return { slope: 0, intercept: 0 };
    }

    if (values.length === 1) {
      return { slope: 0, intercept: values[0] };
    }

    const n = values.length;
    const x = Array.from({ length: n }, (_, i) => i);
    const y = values;

    const xMean = x.reduce((a, b) => a + b, 0) / n;
    const yMean = y.reduce((a, b) => a + b, 0) / n;

    const numerator = x.reduce((sum, xi, i) => sum + (xi - xMean) * (y[i] - yMean), 0);
    const denominator = x.reduce((sum, xi) => sum + (xi - xMean) ** 2, 0);

    const slope = denominator !== 0 ? numerator / denominator : 0;
    const intercept = yMean - slope * xMean;

    return { slope, intercept };
  }

  private calculateSeasonalFactor(dailyData: DailyAggregate[]): number[] {
    const seasonalPattern = [1.0, 1.0, 1.0, 1.0, 1.0, 0.8, 0.8];
    const weekdayAverages = [0, 0, 0, 0, 0, 0, 0];
    const weekdayCounts = [0, 0, 0, 0, 0, 0, 0];

    for (const daily of dailyData) {
      const date = new Date(daily.date);
      const dayOfWeek = date.getDay();
      weekdayAverages[dayOfWeek] += daily.totalCost;
      weekdayCounts[dayOfWeek] += 1;
    }

    const overallAverage =
      dailyData.reduce((sum, d) => sum + d.totalCost, 0) / Math.max(1, dailyData.length);

    // Skip seasonal adjustment when all costs are zero to avoid Infinity factors
    if (overallAverage < 0.0001) {
      return seasonalPattern;
    }

    for (let i = 0; i < 7; i++) {
      if (weekdayCounts[i] > 0) {
        seasonalPattern[i] = (weekdayAverages[i] / weekdayCounts[i]) / overallAverage;
      }
    }

    return seasonalPattern;
  }

  private calculateBudgetExceedDate(
    projectedDaily: number[],
    budget: number | null,
  ): string | null {
    if (!budget) {
      return null;
    }

    let cumulative = 0;
    const now = Date.now();

    for (let i = 0; i < projectedDaily.length; i++) {
      cumulative += projectedDaily[i];
      if (cumulative >= budget) {
        const exceedDate = new Date(now + i * 24 * 60 * 60 * 1000);
        return exceedDate.toISOString().split('T')[0];
      }
    }

    return null;
  }

  private evictOldData(timestamp: number): void {
    const cutoffTime = timestamp - this.bufferDays * 24 * 60 * 60 * 1000;
    this.hourlyBuffer = this.hourlyBuffer.filter((e) => e.timestamp >= cutoffTime);
  }

  private getHourStart(timestamp: number): number {
    const date = new Date(timestamp);
    date.setMinutes(0, 0, 0);
    return date.getTime();
  }

  private getDateString(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toISOString().split('T')[0];
  }

  private getMonthlyBudgetFromEnv(): number | null {
    const envValue = process.env.NEW_RELIC_AI_MONTHLY_BUDGET_USD;
    if (envValue) {
      const parsed = parseFloat(envValue);
      return isNaN(parsed) ? null : parsed;
    }
    return null;
  }
}
