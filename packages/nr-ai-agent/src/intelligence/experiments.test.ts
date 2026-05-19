import { ExperimentTracker } from './experiments.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('ExperimentTracker', () => {
  it('defines experiment and tags requests', () => {
    const tracker = new ExperimentTracker();
    tracker.defineExperiment({
      name: 'test-exp',
      variants: ['a', 'b'],
      metrics: ['metric1'],
      startDate: new Date(),
    });

    tracker.tagRequest('test-exp', 'a');
    expect(tracker.getCurrentVariant('test-exp')).toBe('a');

    tracker.tagRequest('test-exp', 'b');
    expect(tracker.getCurrentVariant('test-exp')).toBe('b');
  });

  it('getActiveVariants returns all tagged experiments in current context', () => {
    const tracker = new ExperimentTracker();
    tracker.defineExperiment({
      name: 'exp-x',
      variants: ['control', 'treatment'],
      metrics: ['m'],
      startDate: new Date(),
    });
    tracker.defineExperiment({
      name: 'exp-y',
      variants: ['v1', 'v2'],
      metrics: ['m'],
      startDate: new Date(),
    });

    expect(tracker.getActiveVariants().size).toBe(0);

    tracker.tagRequest('exp-x', 'treatment');
    tracker.tagRequest('exp-y', 'v2');

    const active = tracker.getActiveVariants();
    expect(active.get('exp-x')).toBe('treatment');
    expect(active.get('exp-y')).toBe('v2');
  });

  it('records metric values', () => {
    const tracker = new ExperimentTracker();
    tracker.defineExperiment({
      name: 'metrics-test',
      variants: ['control', 'variant'],
      metrics: ['cost'],
      startDate: new Date(),
    });

    for (let i = 0; i < 50; i++) {
      tracker.recordMetricValue('metrics-test', 'control', 'cost', 100);
      tracker.recordMetricValue('metrics-test', 'variant', 'cost', 80);
    }

    const results = tracker.getExperimentResults('metrics-test');
    expect(results.metrics.length).toBeGreaterThan(0);
  });

  it('computes statistical metrics', () => {
    const tracker = new ExperimentTracker();
    tracker.defineExperiment({
      name: 'stats',
      variants: ['a'],
      metrics: ['m'],
      startDate: new Date(),
    });

    for (let i = 0; i < 100; i++) {
      tracker.recordMetricValue('stats', 'a', 'm', 100);
    }

    const results = tracker.getExperimentResults('stats');
    const stats = results.metrics[0].variantStats[0];

    expect(stats.sampleCount).toBe(100);
    expect(stats.mean).toBe(100);
    expect(stats.median).toBe(100);
    expect(stats.p95).toBe(100);
    expect(stats.stdDev).toBe(0);
  });

  it('performs pairwise comparisons', () => {
    const tracker = new ExperimentTracker();
    tracker.defineExperiment({
      name: 'comparison',
      variants: ['cheap', 'expensive'],
      metrics: ['cost'],
      startDate: new Date(),
    });

    for (let i = 0; i < 100; i++) {
      tracker.recordMetricValue('comparison', 'cheap', 'cost', 50);
      tracker.recordMetricValue('comparison', 'expensive', 'cost', 100);
    }

    const results = tracker.getExperimentResults('comparison');
    const comparisons = results.metrics[0].pairwiseComparisons;

    expect(comparisons.length).toBe(1);
    expect(comparisons[0].isSignificant).toBe(true);
    expect(comparisons[0].pValue).toBeLessThan(0.05);
  });

  it('returns winner with statistical significance', () => {
    const tracker = new ExperimentTracker();
    tracker.defineExperiment({
      name: 'winner',
      variants: ['control', 'variant'],
      metrics: ['metric'],
      startDate: new Date(),
    });

    for (let i = 0; i < 100; i++) {
      tracker.recordMetricValue('winner', 'control', 'metric', 100);
      tracker.recordMetricValue('winner', 'variant', 'metric', 50);
    }

    const results = tracker.getExperimentResults('winner');
    expect(results.recommendedWinner).toBe('variant');
  });

  it('returns null winner without statistical significance', () => {
    const tracker = new ExperimentTracker();
    tracker.defineExperiment({
      name: 'no-winner',
      variants: ['a', 'b'],
      metrics: ['m'],
      startDate: new Date(),
    });

    for (let i = 0; i < 50; i++) {
      tracker.recordMetricValue('no-winner', 'a', 'm', 100);
      tracker.recordMetricValue('no-winner', 'b', 'm', 100);
    }

    const results = tracker.getExperimentResults('no-winner');
    expect(results.recommendedWinner).toBeNull();
  });

  it('handles multiple metrics', () => {
    const tracker = new ExperimentTracker();
    tracker.defineExperiment({
      name: 'multi-metric',
      variants: ['a'],
      metrics: ['m1', 'm2', 'm3'],
      startDate: new Date(),
    });

    for (let i = 0; i < 50; i++) {
      tracker.recordMetricValue('multi-metric', 'a', 'm1', 100);
      tracker.recordMetricValue('multi-metric', 'a', 'm2', 200);
      tracker.recordMetricValue('multi-metric', 'a', 'm3', 300);
    }

    const results = tracker.getExperimentResults('multi-metric');
    expect(results.metrics.length).toBe(3);
    expect(results.metrics[0].metric).toBe('m1');
    expect(results.metrics[1].metric).toBe('m2');
    expect(results.metrics[2].metric).toBe('m3');
  });

  it('handles three-way variant comparisons', () => {
    const tracker = new ExperimentTracker();
    tracker.defineExperiment({
      name: 'three-way',
      variants: ['a', 'b', 'c'],
      metrics: ['m'],
      startDate: new Date(),
    });

    for (let i = 0; i < 50; i++) {
      tracker.recordMetricValue('three-way', 'a', 'm', 100);
      tracker.recordMetricValue('three-way', 'b', 'm', 150);
      tracker.recordMetricValue('three-way', 'c', 'm', 200);
    }

    const results = tracker.getExperimentResults('three-way');
    const comparisons = results.metrics[0].pairwiseComparisons;

    expect(comparisons.length).toBe(3);
    expect(comparisons.every((c) => c.pValue >= 0 && c.pValue <= 1)).toBe(true);
  });

  it('returns null winner without sufficient data', () => {
    const tracker = new ExperimentTracker();
    tracker.defineExperiment({
      name: 'small-sample',
      variants: ['a', 'b'],
      metrics: ['m'],
      startDate: new Date(),
    });

    tracker.recordMetricValue('small-sample', 'a', 'm', 100);
    tracker.recordMetricValue('small-sample', 'b', 'm', 50);

    const results = tracker.getExperimentResults('small-sample');
    expect(results.recommendedWinner).toBeNull();
  });

  it('includes timestamp in results', () => {
    const tracker = new ExperimentTracker();
    tracker.defineExperiment({
      name: 'timestamp',
      variants: ['a'],
      metrics: ['m'],
      startDate: new Date(),
    });

    const before = Date.now();
    const results = tracker.getExperimentResults('timestamp');
    const after = Date.now();

    expect(results.timestamp).toBeGreaterThanOrEqual(before);
    expect(results.timestamp).toBeLessThanOrEqual(after);
  });

  it('handles nonexistent experiments', () => {
    const tracker = new ExperimentTracker();
    const results = tracker.getExperimentResults('nonexistent');

    expect(results.experimentName).toBe('nonexistent');
    expect(results.metrics).toEqual([]);
    expect(results.recommendedWinner).toBeNull();
  });

  it('tracks multiple independent experiments', () => {
    const tracker = new ExperimentTracker();

    tracker.defineExperiment({
      name: 'exp1',
      variants: ['a'],
      metrics: ['m'],
      startDate: new Date(),
    });

    tracker.defineExperiment({
      name: 'exp2',
      variants: ['x'],
      metrics: ['n'],
      startDate: new Date(),
    });

    tracker.recordMetricValue('exp1', 'a', 'm', 100);
    tracker.recordMetricValue('exp2', 'x', 'n', 200);

    const results1 = tracker.getExperimentResults('exp1');
    const results2 = tracker.getExperimentResults('exp2');

    expect(results1.experimentName).toBe('exp1');
    expect(results2.experimentName).toBe('exp2');
  });

  it('ignores invalid variant tags', () => {
    const tracker = new ExperimentTracker();
    tracker.defineExperiment({
      name: 'invalid',
      variants: ['a', 'b'],
      metrics: ['m'],
      startDate: new Date(),
    });

    tracker.tagRequest('invalid', 'nonexistent');
    expect(tracker.getCurrentVariant('invalid')).toBeNull();
  });

  it('ensures p-values are in valid range', () => {
    const tracker = new ExperimentTracker();
    tracker.defineExperiment({
      name: 'pvalue-range',
      variants: ['a', 'b'],
      metrics: ['m'],
      startDate: new Date(),
    });

    for (let i = 0; i < 50; i++) {
      tracker.recordMetricValue('pvalue-range', 'a', 'm', 100 + Math.random() * 50);
      tracker.recordMetricValue('pvalue-range', 'b', 'm', 150 + Math.random() * 50);
    }

    const results = tracker.getExperimentResults('pvalue-range');
    results.metrics[0].pairwiseComparisons.forEach((comp) => {
      expect(comp.pValue).toBeGreaterThanOrEqual(0);
      expect(comp.pValue).toBeLessThanOrEqual(1);
    });
  });

  it('computes relative difference correctly', () => {
    const tracker = new ExperimentTracker();
    tracker.defineExperiment({
      name: 'relative-diff',
      variants: ['baseline', 'variant'],
      metrics: ['cost'],
      startDate: new Date(),
    });

    for (let i = 0; i < 100; i++) {
      tracker.recordMetricValue('relative-diff', 'baseline', 'cost', 100);
      tracker.recordMetricValue('relative-diff', 'variant', 'cost', 80);
    }

    const results = tracker.getExperimentResults('relative-diff');
    const comparison = results.metrics[0].pairwiseComparisons[0];

    expect(comparison.relativeDifference).toBeCloseTo(-20, 0);
  });

  it('skips empty variants in results', () => {
    const tracker = new ExperimentTracker();
    tracker.defineExperiment({
      name: 'empty-variant',
      variants: ['recorded', 'empty'],
      metrics: ['m'],
      startDate: new Date(),
    });

    for (let i = 0; i < 50; i++) {
      tracker.recordMetricValue('empty-variant', 'recorded', 'm', 100);
    }

    const results = tracker.getExperimentResults('empty-variant');
    expect(results.metrics[0].variantStats.length).toBe(1);
    expect(results.metrics[0].variantStats[0].variant).toBe('recorded');
  });

  it('computes p95 correctly with varying data', () => {
    const tracker = new ExperimentTracker();
    tracker.defineExperiment({
      name: 'p95-test',
      variants: ['a'],
      metrics: ['latency'],
      startDate: new Date(),
    });

    // 100 values from 1..100; p95 should be 95
    for (let i = 1; i <= 100; i++) {
      tracker.recordMetricValue('p95-test', 'a', 'latency', i);
    }

    const results = tracker.getExperimentResults('p95-test');
    const stats = results.metrics[0].variantStats[0];

    // p95 of [1..100] is the 95th value = 95
    expect(stats.p95).toBe(95);
    expect(stats.mean).toBeCloseTo(50.5, 1);
  });

  it('variant context propagates across async boundaries via AsyncLocalStorage', async () => {
    const tracker = new ExperimentTracker();
    tracker.defineExperiment({
      name: 'async-test',
      variants: ['control', 'variant'],
      metrics: ['m'],
      startDate: new Date(),
    });

    tracker.tagRequest('async-test', 'control');

    const variant = await Promise.resolve().then(() => tracker.getCurrentVariant('async-test'));
    expect(variant).toBe('control');
  });

  it('does not recommend a variant that wins one metric but loses another', () => {
    const tracker = new ExperimentTracker();
    tracker.defineExperiment({
      name: 'mixed-results',
      variants: ['a', 'b'],
      metrics: ['latency', 'quality'],
      startDate: new Date(),
    });

    // winner = variant with lower mean (relativeDifference > 0 means variant1 wins)
    // 'a' wins latency (50 < 100), 'b' wins quality-cost (60 < 90)
    for (let i = 0; i < 50; i++) {
      tracker.recordMetricValue('mixed-results', 'a', 'latency', 50);
      tracker.recordMetricValue('mixed-results', 'b', 'latency', 100);
      tracker.recordMetricValue('mixed-results', 'a', 'quality', 90);
      tracker.recordMetricValue('mixed-results', 'b', 'quality', 60);
    }

    const results = tracker.getExperimentResults('mixed-results');
    // 'a' wins latency but loses quality; 'b' wins quality but loses latency.
    // Neither variant has zero losses, so no winner should be declared.
    expect(results.recommendedWinner).toBeNull();
  });

  it('recommends the variant that wins all metrics with no losses', () => {
    const tracker = new ExperimentTracker();
    tracker.defineExperiment({
      name: 'clear-winner',
      variants: ['control', 'treatment'],
      metrics: ['latency', 'cost'],
      startDate: new Date(),
    });

    // treatment is better (lower) on both metrics
    for (let i = 0; i < 50; i++) {
      tracker.recordMetricValue('clear-winner', 'control', 'latency', 200);
      tracker.recordMetricValue('clear-winner', 'treatment', 'latency', 100);
      tracker.recordMetricValue('clear-winner', 'control', 'cost', 0.10);
      tracker.recordMetricValue('clear-winner', 'treatment', 'cost', 0.05);
    }

    const results = tracker.getExperimentResults('clear-winner');
    // treatment wins both metrics with no losses
    expect(results.recommendedWinner).toBe('treatment');
  });

  it('handles large sample sizes', () => {
    const tracker = new ExperimentTracker();
    tracker.defineExperiment({
      name: 'large-sample',
      variants: ['a', 'b'],
      metrics: ['m'],
      startDate: new Date(),
    });

    for (let i = 0; i < 1000; i++) {
      tracker.recordMetricValue('large-sample', 'a', 'm', 100);
      tracker.recordMetricValue('large-sample', 'b', 'm', 99);
    }

    const results = tracker.getExperimentResults('large-sample');
    expect(results.metrics[0].variantStats[0].sampleCount).toBe(1000);
  });

  it('persists experiment configs to disk and reloads them', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'exp-persist-'));
    const persistPath = join(tmpDir, 'experiments.json');

    try {
      const tracker1 = new ExperimentTracker({ persistPath });
      tracker1.defineExperiment({
        name: 'persisted-exp',
        variants: ['a', 'b'],
        metrics: ['latency'],
        startDate: new Date('2025-01-01'),
        endDate: new Date('2025-12-31'),
      });

      // New tracker instance loading from same path
      const tracker2 = new ExperimentTracker({ persistPath });
      expect(tracker2.getExperimentNames()).toContain('persisted-exp');

      const config = tracker2.getExperimentConfig('persisted-exp');
      expect(config?.variants).toEqual(['a', 'b']);
      expect(config?.metrics).toEqual(['latency']);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
