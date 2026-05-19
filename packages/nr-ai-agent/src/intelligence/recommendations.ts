export type RecommendationType =
  | 'model_optimization'
  | 'cache_optimization'
  | 'thinking_budget'
  | 'context_management';

export type RecommendationSeverity = 'info' | 'warning' | 'critical';

export interface Recommendation {
  readonly type: RecommendationType;
  readonly severity: RecommendationSeverity;
  readonly title: string;
  readonly description: string;
  readonly estimatedImpact: string;
  readonly confidence: number;
}

export interface RecommendationEngineOptions {
  readonly qualityTolerancePercent?: number;
  readonly thinkingBudgetThresholdHigh?: number;
  readonly thinkingBudgetThresholdLow?: number;
  readonly cacheHitRateThreshold?: number;
}

interface ModelStats {
  model: string;
  costPerRequest: number;
  averageQuality: number;
  sampleCount: number;
}

interface FeatureCacheStats {
  feature: string;
  cacheHitRate: number;
  totalRequests: number;
  hasStaticPrompt: boolean;
  tokensUsed: number;
}

interface ThinkingBudgetStats {
  utilizationPercent: number;
  utilizationSamples: number;
  currentBudgetTokens: number;
}

interface ContextPressureStats {
  maxTurnsBeforeLimit: number;
  qualityDegradationTurn: number | null;
  sampleConversations: number;
}

export class RecommendationEngine {
  private qualityTolerancePercent: number;
  private thinkingBudgetThresholdHigh: number;
  private thinkingBudgetThresholdLow: number;
  private cacheHitRateThreshold: number;

  private modelStats: Map<string, ModelStats> = new Map();
  private featureStats: Map<string, FeatureCacheStats> = new Map();
  private thinkingBudgetStats: ThinkingBudgetStats | null = null;
  private contextStats: ContextPressureStats | null = null;

  constructor(options?: RecommendationEngineOptions) {
    this.qualityTolerancePercent = options?.qualityTolerancePercent ?? 10;
    this.thinkingBudgetThresholdHigh = options?.thinkingBudgetThresholdHigh ?? 90;
    this.thinkingBudgetThresholdLow = options?.thinkingBudgetThresholdLow ?? 20;
    this.cacheHitRateThreshold = options?.cacheHitRateThreshold ?? 50;
  }

  recordModelUsage(
    model: string,
    costPerRequest: number,
    qualityScore: number,
    _feature?: string,
  ): void {
    let stats = this.modelStats.get(model);
    if (!stats) {
      stats = {
        model,
        costPerRequest,
        averageQuality: 0,
        sampleCount: 0,
      };
      this.modelStats.set(model, stats);
    }

    stats.costPerRequest = costPerRequest;
    stats.averageQuality = (stats.averageQuality * stats.sampleCount + qualityScore) / (stats.sampleCount + 1);
    stats.sampleCount += 1;
  }

  recordFeatureCacheMetrics(
    feature: string,
    cacheHitRate: number,
    hasStaticPrompt: boolean,
    tokensUsed: number,
  ): void {
    const existing = this.featureStats.get(feature);
    const count = (existing?.totalRequests ?? 0) + 1;
    // Rolling average so the hit rate reflects all requests seen so far
    const rollingHitRate = existing
      ? (existing.cacheHitRate * existing.totalRequests + cacheHitRate) / count
      : cacheHitRate;
    this.featureStats.set(feature, {
      feature,
      cacheHitRate: rollingHitRate,
      totalRequests: count,
      hasStaticPrompt,
      tokensUsed,
    });
  }

  recordThinkingBudgetUsage(utilizationPercent: number): void {
    if (!this.thinkingBudgetStats) {
      this.thinkingBudgetStats = {
        utilizationPercent: 0,
        utilizationSamples: 0,
        currentBudgetTokens: 4000,
      };
    }

    const stats = this.thinkingBudgetStats;
    stats.utilizationPercent =
      (stats.utilizationPercent * stats.utilizationSamples + utilizationPercent) /
      (stats.utilizationSamples + 1);
    stats.utilizationSamples += 1;
  }

  recordContextPressure(
    maxTurnsBeforeLimit: number,
    qualityDegradationTurn: number | null,
    _sampleConversations?: number,
  ): void {
    this.contextStats = {
      maxTurnsBeforeLimit,
      qualityDegradationTurn,
      sampleConversations: (_sampleConversations ?? 1) + (this.contextStats?.sampleConversations ?? 0),
    };
  }

  analyze(): Recommendation[] {
    const recommendations: Recommendation[] = [];

    recommendations.push(...this.analyzeModelOptimization());
    recommendations.push(...this.analyzeCacheOptimization());
    recommendations.push(...this.analyzeThinkingBudget());
    recommendations.push(...this.analyzeContextManagement());

    recommendations.sort((a, b) => {
      const impactScore = (rec: Recommendation) => {
        const severityScore = { critical: 3, warning: 2, info: 1 }[rec.severity];
        return severityScore * rec.confidence;
      };
      return impactScore(b) - impactScore(a);
    });

    return recommendations;
  }

  private analyzeModelOptimization(): Recommendation[] {
    const recommendations: Recommendation[] = [];

    if (this.modelStats.size < 2) {
      return recommendations;
    }

    const models = Array.from(this.modelStats.values());
    models.sort((a, b) => a.costPerRequest - b.costPerRequest);

    for (let i = 1; i < models.length; i++) {
      const cheaper = models[0];
      const expensive = models[i];

      if (expensive.sampleCount < 10 || cheaper.sampleCount < 10) {
        continue;
      }

      const qualityDiff = ((expensive.averageQuality - cheaper.averageQuality) / expensive.averageQuality) * 100;
      const costRatio = expensive.costPerRequest / cheaper.costPerRequest;

      if (
        qualityDiff <= this.qualityTolerancePercent &&
        costRatio > 1.5
      ) {
        const costSavings = (expensive.costPerRequest - cheaper.costPerRequest) * 1000;
        const confidence = Math.min(
          1.0,
          (expensive.sampleCount + cheaper.sampleCount) / 1000,
        );

        recommendations.push({
          type: 'model_optimization',
          severity: costRatio > 3 ? 'critical' : 'warning',
          title: `Switch from ${expensive.model} to ${cheaper.model}`,
          description: `${expensive.model} costs $${expensive.costPerRequest.toFixed(4)}/request with quality ${expensive.averageQuality.toFixed(2)}, while ${cheaper.model} costs $${cheaper.costPerRequest.toFixed(4)}/request with quality ${cheaper.averageQuality.toFixed(2)} (${qualityDiff.toFixed(1)}% lower). For 1000 requests, ${cheaper.model} saves approximately $${costSavings.toFixed(0)}.`,
          estimatedImpact: `$${costSavings.toFixed(0)}/1K requests`,
          confidence,
        });
      }
    }

    return recommendations;
  }

  private analyzeCacheOptimization(): Recommendation[] {
    const recommendations: Recommendation[] = [];

    for (const stats of this.featureStats.values()) {
      if (stats.totalRequests < 20) {
        continue;
      }

      if (stats.hasStaticPrompt && stats.cacheHitRate < this.cacheHitRateThreshold) {
        const estimatedDailySavings = (stats.tokensUsed * 0.0001) * 0.25;
        const confidence = Math.min(1.0, stats.totalRequests / 500);

        recommendations.push({
          type: 'cache_optimization',
          severity: 'warning',
          title: `Enable prompt caching for ${stats.feature}`,
          description: `Feature "${stats.feature}" has a static system prompt but only ${stats.cacheHitRate.toFixed(0)}% cache hit rate. Enabling prompt caching could save approximately $${estimatedDailySavings.toFixed(2)}/day.`,
          estimatedImpact: `$${estimatedDailySavings.toFixed(2)}/day`,
          confidence,
        });
      } else if (stats.cacheHitRate > 85) {
        recommendations.push({
          type: 'cache_optimization',
          severity: 'info',
          title: `${stats.feature} is well-optimized for caching`,
          description: `Feature "${stats.feature}" has a ${stats.cacheHitRate.toFixed(0)}% cache hit rate, which is excellent. No action needed.`,
          estimatedImpact: 'Already optimized',
          confidence: 0.95,
        });
      }
    }

    return recommendations;
  }

  private analyzeThinkingBudget(): Recommendation[] {
    const recommendations: Recommendation[] = [];

    if (!this.thinkingBudgetStats || this.thinkingBudgetStats.utilizationSamples < 10) {
      return recommendations;
    }

    const stats = this.thinkingBudgetStats;
    const confidence = Math.min(1.0, stats.utilizationSamples / 500);

    if (stats.utilizationPercent > this.thinkingBudgetThresholdHigh) {
      const newBudget = Math.ceil((stats.currentBudgetTokens * stats.utilizationPercent) / 100 / 500) * 500;
      const costIncrease = ((newBudget - stats.currentBudgetTokens) / stats.currentBudgetTokens) * 100;

      recommendations.push({
        type: 'thinking_budget',
        severity: 'warning',
        title: `Increase thinking budget from ${stats.currentBudgetTokens} to ${newBudget} tokens`,
        description: `Thinking budget utilization is consistently at ${stats.utilizationPercent.toFixed(0)}%, indicating your workload frequently hits the limit. Consider increasing the budget to ${newBudget} tokens. This will increase costs by approximately ${costIncrease.toFixed(0)}%, but may improve response quality for complex tasks.`,
        estimatedImpact: `+${costIncrease.toFixed(0)}% cost`,
        confidence,
      });
    } else if (stats.utilizationPercent < this.thinkingBudgetThresholdLow) {
      const savings = ((stats.currentBudgetTokens - stats.currentBudgetTokens * 0.5) / stats.currentBudgetTokens) * 100;

      recommendations.push({
        type: 'thinking_budget',
        severity: 'info',
        title: `Consider reducing thinking budget from ${stats.currentBudgetTokens} tokens`,
        description: `Thinking budget utilization averages only ${stats.utilizationPercent.toFixed(0)}%, suggesting your workload rarely benefits from extended thinking. Reducing the budget to ${Math.round(stats.currentBudgetTokens * 0.5)} tokens could save approximately ${savings.toFixed(0)}% on thinking-related costs.`,
        estimatedImpact: `${savings.toFixed(0)}% savings`,
        confidence,
      });
    }

    return recommendations;
  }

  private analyzeContextManagement(): Recommendation[] {
    const recommendations: Recommendation[] = [];

    if (!this.contextStats || this.contextStats.sampleConversations < 5) {
      return recommendations;
    }

    const stats = this.contextStats;
    const confidence = Math.min(1.0, stats.sampleConversations / 100);

    if (
      stats.maxTurnsBeforeLimit < 20 &&
      stats.qualityDegradationTurn !== null &&
      stats.qualityDegradationTurn < stats.maxTurnsBeforeLimit - 2
    ) {
      const summarizeAfterTurn = Math.max(2, stats.qualityDegradationTurn - 2);

      recommendations.push({
        type: 'context_management',
        severity: 'warning',
        title: `Implement summarization to maintain quality`,
        description: `Average conversations reach context limits after ${stats.maxTurnsBeforeLimit} turns, with quality degradation starting at turn ${stats.qualityDegradationTurn}. Implementing conversation summarization after turn ${summarizeAfterTurn} can help maintain quality and extend conversation length.`,
        estimatedImpact: 'Better quality preservation',
        confidence,
      });
    }

    return recommendations;
  }
}
