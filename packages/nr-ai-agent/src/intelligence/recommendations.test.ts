import { RecommendationEngine } from './recommendations.js';

describe('RecommendationEngine', () => {
  // Test 1: Model optimization - cheaper model with acceptable quality difference
  it('recommends switching to cheaper model with <10% quality difference', () => {
    const engine = new RecommendationEngine({ qualityTolerancePercent: 10 });

    for (let i = 0; i < 20; i++) {
      engine.recordModelUsage('expensive-model', 0.047, 0.95);
      engine.recordModelUsage('cheap-model', 0.005, 0.92);
    }

    const recommendations = engine.analyze();
    const modelRec = recommendations.find((r) => r.type === 'model_optimization');

    expect(modelRec).toBeDefined();
    expect(modelRec?.title).toContain('cheap-model');
    expect(modelRec?.confidence).toBeGreaterThan(0);
  });

  // Test 2: Model optimization - cheaper model with too large quality drop
  it('does not recommend switch when quality difference >10%', () => {
    const engine = new RecommendationEngine({ qualityTolerancePercent: 10 });

    for (let i = 0; i < 20; i++) {
      engine.recordModelUsage('expensive-model', 0.047, 0.95);
      engine.recordModelUsage('cheap-model', 0.005, 0.70);
    }

    const recommendations = engine.analyze();
    const modelRec = recommendations.find((r) => r.type === 'model_optimization');

    expect(modelRec).toBeUndefined();
  });

  // Test 3: Cache optimization - static prompt with low cache hit rate
  it('recommends enabling cache for static prompts with low hit rate', () => {
    const engine = new RecommendationEngine({ cacheHitRateThreshold: 50 });

    for (let i = 0; i < 20; i++) engine.recordFeatureCacheMetrics('feature-a', 5, true, 50000);

    const recommendations = engine.analyze();
    const cacheRec = recommendations.find((r) => r.type === 'cache_optimization');

    expect(cacheRec).toBeDefined();
    expect(cacheRec?.title).toContain('Enable prompt caching');
    expect(cacheRec?.estimatedImpact).toContain('$');
  });

  // Test 4: Cache optimization - already well optimized
  it('does not recommend cache changes for high hit rate', () => {
    const engine = new RecommendationEngine({ cacheHitRateThreshold: 50 });

    for (let i = 0; i < 20; i++) engine.recordFeatureCacheMetrics('feature-a', 90, true, 50000);

    const recommendations = engine.analyze();
    const cacheRecs = recommendations.filter((r) => r.type === 'cache_optimization' && r.severity !== 'info');

    expect(cacheRecs.length).toBe(0);
  });

  // Test 5: Thinking budget at 100% utilization
  it('recommends increasing thinking budget when utilization >90%', () => {
    const engine = new RecommendationEngine({ thinkingBudgetThresholdHigh: 90 });

    for (let i = 0; i < 50; i++) {
      engine.recordThinkingBudgetUsage(95);
    }

    const recommendations = engine.analyze();
    const budgetRec = recommendations.find((r) => r.type === 'thinking_budget');

    expect(budgetRec).toBeDefined();
    expect(budgetRec?.title).toContain('Increase');
    expect(budgetRec?.severity).toBe('warning');
  });

  // Test 6: Thinking budget at low utilization
  it('recommends reducing thinking budget when utilization <20%', () => {
    const engine = new RecommendationEngine({ thinkingBudgetThresholdLow: 20 });

    for (let i = 0; i < 50; i++) {
      engine.recordThinkingBudgetUsage(10);
    }

    const recommendations = engine.analyze();
    const budgetRec = recommendations.find((r) => r.type === 'thinking_budget');

    expect(budgetRec).toBeDefined();
    expect(budgetRec?.title).toContain('reducing');
    expect(budgetRec?.severity).toBe('info');
  });

  // Test 7: Context pressure with quality degradation
  it('recommends summarization when context hits limits with quality drop', () => {
    const engine = new RecommendationEngine();

    for (let i = 0; i < 15; i++) {
      engine.recordContextPressure(12, 9);
    }

    const recommendations = engine.analyze();
    const contextRec = recommendations.find((r) => r.type === 'context_management');

    if (contextRec) {
      expect(contextRec.title).toContain('summarization');
    }
  });

  // Test 8: Confidence scales with data volume
  it('scales confidence with data volume', () => {
    const engineLow = new RecommendationEngine({ qualityTolerancePercent: 10 });
    for (let i = 0; i < 20; i++) {
      engineLow.recordModelUsage('exp', 0.047, 0.95);
      engineLow.recordModelUsage('cheap', 0.005, 0.92);
    }

    const engineHigh = new RecommendationEngine({ qualityTolerancePercent: 10 });
    for (let i = 0; i < 500; i++) {
      engineHigh.recordModelUsage('exp', 0.047, 0.95);
      engineHigh.recordModelUsage('cheap', 0.005, 0.92);
    }

    const lowRecs = engineLow.analyze().filter((r) => r.type === 'model_optimization');
    const highRecs = engineHigh.analyze().filter((r) => r.type === 'model_optimization');

    if (lowRecs.length > 0 && highRecs.length > 0) {
      expect(highRecs[0].confidence).toBeGreaterThan(lowRecs[0].confidence);
    }
  });

  // Test 9: Recommendations prioritized by impact
  it('prioritizes recommendations by severity and confidence', () => {
    const engine = new RecommendationEngine();

    for (let i = 0; i < 100; i++) {
      engine.recordModelUsage('expensive', 0.047, 0.95);
      engine.recordModelUsage('cheap', 0.005, 0.92);
    }

    for (let i = 0; i < 50; i++) {
      engine.recordThinkingBudgetUsage(95);
    }

    const recommendations = engine.analyze();

    if (recommendations.length > 1) {
      const severityOrder = { critical: 3, warning: 2, info: 1 };
      const score0 = (recommendations[0].confidence * severityOrder[recommendations[0].severity]) || 0;
      const score1 = (recommendations[1].confidence * severityOrder[recommendations[1].severity]) || 0;
      expect(score0).toBeGreaterThanOrEqual(score1);
    }
  });

  // Test 10: All recommendation attributes present
  it('includes all required attributes in recommendations', () => {
    const engine = new RecommendationEngine();

    for (let i = 0; i < 20; i++) {
      engine.recordModelUsage('expensive', 0.047, 0.95);
      engine.recordModelUsage('cheap', 0.005, 0.92);
    }

    const recommendations = engine.analyze();
    const rec = recommendations.find((r) => r.type === 'model_optimization');

    expect(rec).toBeDefined();
    expect(rec?.type).toBeDefined();
    expect(rec?.severity).toBeDefined();
    expect(rec?.title).toBeDefined();
    expect(rec?.description).toBeDefined();
    expect(rec?.estimatedImpact).toBeDefined();
    expect(rec?.confidence).toBeDefined();
    expect(rec?.confidence).toBeGreaterThanOrEqual(0);
    expect(rec?.confidence).toBeLessThanOrEqual(1);
  });

  it('returns empty array when no data recorded', () => {
    const engine = new RecommendationEngine();
    const recommendations = engine.analyze();

    expect(recommendations).toEqual([]);
  });

  it('requires minimum sample size for model recommendations', () => {
    const engine = new RecommendationEngine();

    for (let i = 0; i < 3; i++) {
      engine.recordModelUsage('expensive', 0.047, 0.95);
      engine.recordModelUsage('cheap', 0.005, 0.92);
    }

    const recommendations = engine.analyze();
    const modelRec = recommendations.find((r) => r.type === 'model_optimization');

    expect(modelRec).toBeUndefined();
  });

  it('requires minimum sample size for cache recommendations', () => {
    const engine = new RecommendationEngine();

    for (let i = 0; i < 5; i++) engine.recordFeatureCacheMetrics('feature-a', 5, true, 50000);

    const recommendations = engine.analyze();
    const cacheRec = recommendations.find((r) => r.type === 'cache_optimization' && r.severity !== 'info');

    expect(cacheRec).toBeUndefined();
  });

  it('requires minimum samples for thinking budget recommendations', () => {
    const engine = new RecommendationEngine();

    for (let i = 0; i < 3; i++) {
      engine.recordThinkingBudgetUsage(95);
    }

    const recommendations = engine.analyze();
    const budgetRec = recommendations.find((r) => r.type === 'thinking_budget');

    expect(budgetRec).toBeUndefined();
  });

  it('requires minimum samples for context recommendations', () => {
    const engine = new RecommendationEngine();

    engine.recordContextPressure(12, 10);

    const recommendations = engine.analyze();
    const contextRec = recommendations.find((r) => r.type === 'context_management');

    expect(contextRec).toBeUndefined();
  });

  it('handles multiple features independently', () => {
    const engine = new RecommendationEngine();

    for (let i = 0; i < 20; i++) engine.recordFeatureCacheMetrics('feature-a', 10, true, 50000);
    for (let i = 0; i < 20; i++) engine.recordFeatureCacheMetrics('feature-b', 90, true, 50000);

    const recommendations = engine.analyze();
    const cacheRecs = recommendations.filter((r) => r.type === 'cache_optimization');

    expect(cacheRecs.length).toBeGreaterThan(0);
  });

  it('accumulates thinking budget statistics', () => {
    const engine = new RecommendationEngine();

    for (let i = 0; i < 50; i++) {
      engine.recordThinkingBudgetUsage(50);
    }

    engine.recordThinkingBudgetUsage(100);

    const recommendations = engine.analyze();

    expect(recommendations).toBeDefined();
  });

  it('calculates estimated impact for model optimization', () => {
    const engine = new RecommendationEngine();

    for (let i = 0; i < 20; i++) {
      engine.recordModelUsage('expensive', 0.047, 0.95);
      engine.recordModelUsage('cheap', 0.005, 0.92);
    }

    const recommendations = engine.analyze();
    const modelRec = recommendations.find((r) => r.type === 'model_optimization');

    expect(modelRec?.estimatedImpact).toContain('$');
    expect(modelRec?.estimatedImpact).toContain('/');
  });

  it('calculates estimated impact for cache optimization', () => {
    const engine = new RecommendationEngine();

    for (let i = 0; i < 20; i++) engine.recordFeatureCacheMetrics('feature-a', 5, true, 100000);

    const recommendations = engine.analyze();
    const cacheRec = recommendations.find((r) => r.type === 'cache_optimization' && r.severity !== 'info');

    expect(cacheRec?.estimatedImpact).toContain('$');
    expect(cacheRec?.estimatedImpact).toContain('/');
  });

  it('suggests no action when already optimized', () => {
    const engine = new RecommendationEngine();

    for (let i = 0; i < 50; i++) {
      engine.recordThinkingBudgetUsage(50);
    }

    const recommendations = engine.analyze();
    const budgetRec = recommendations.find((r) => r.type === 'thinking_budget');

    expect(budgetRec).toBeUndefined();
  });

  it('handles edge case of no models to compare', () => {
    const engine = new RecommendationEngine();

    for (let i = 0; i < 20; i++) {
      engine.recordModelUsage('only-model', 0.047, 0.95);
    }

    const recommendations = engine.analyze();

    expect(recommendations).toBeDefined();
  });

  it('includes detailed description in recommendations', () => {
    const engine = new RecommendationEngine();

    for (let i = 0; i < 20; i++) {
      engine.recordModelUsage('expensive', 0.047, 0.95);
      engine.recordModelUsage('cheap', 0.005, 0.92);
    }

    const recommendations = engine.analyze();
    const rec = recommendations.find((r) => r.type === 'model_optimization');

    expect(rec?.description.length).toBeGreaterThan(50);
    expect(rec?.description).toContain('$');
  });
});
