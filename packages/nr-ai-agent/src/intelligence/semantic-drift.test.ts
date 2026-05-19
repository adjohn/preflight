import { SemanticDriftDetector } from './semantic-drift.js';

describe('SemanticDriftDetector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.NEW_RELIC_AI_DRIFT_SAMPLE_RATE;
  });

  afterEach(() => {
    delete process.env.NEW_RELIC_AI_DRIFT_SAMPLE_RATE;
  });

  // Test 1: recordBaseline() with 100 similar embeddings → centroid is close to each
  it('computes centroid close to individual baseline vectors', async () => {
    const detector = new SemanticDriftDetector();
    const baseVector = [1, 0, 0, 0, 0];
    const similarVectors = Array.from({ length: 100 }, (_) => {
      const noise = Array.from({ length: 5 }, () => (Math.random() - 0.5) * 0.01);
      return baseVector.map((v, idx) => v + (noise[idx] ?? 0));
    });

    const embeddingFn = jest.fn(async () => {
      const vec = similarVectors.shift();
      return vec || [1, 0, 0, 0, 0];
    });

    detector.initialize(embeddingFn);

    for (let i = 0; i < 100; i++) {
      await detector.recordBaseline('similar response');
    }

    detector.finalizeBaseline();

    const result = await detector.checkDrift('similar response');

    expect(result.similarity).toBeGreaterThan(0.99);
    expect(result.drifted).toBe(false);
  });

  // Test 2: checkDrift() with similar response → similarity > 0.85, drifted = false
  it('returns high similarity and not drifted for similar responses', async () => {
    const detector = new SemanticDriftDetector({ sampleRate: 1.0 });
    const baselineEmbedding = [0.5, 0.5, 0.5, 0.5];
    const similarEmbedding = [0.49, 0.51, 0.49, 0.51];

    let callCount = 0;
    const embeddingFn = jest.fn(async () => {
      callCount += 1;
      return callCount <= 1 ? baselineEmbedding : similarEmbedding;
    });

    detector.initialize(embeddingFn);
    await detector.recordBaseline('baseline response');
    detector.finalizeBaseline();

    const result = await detector.checkDrift('similar response');

    expect(result.similarity).toBeGreaterThan(0.85);
    expect(result.drifted).toBe(false);
  });

  // Test 3: checkDrift() with very different response → similarity < 0.85, drifted = true
  it('returns low similarity and drifted for different responses', async () => {
    const detector = new SemanticDriftDetector({ sampleRate: 1.0 });
    const baselineEmbedding = [1, 0, 0, 0];
    const differentEmbedding = [0, 1, 0, 0];

    let callCount = 0;
    const embeddingFn = jest.fn(async () => {
      callCount += 1;
      return callCount <= 1 ? baselineEmbedding : differentEmbedding;
    });

    detector.initialize(embeddingFn);
    await detector.recordBaseline('baseline');
    detector.finalizeBaseline();

    const result = await detector.checkDrift('different response');

    expect(result.similarity).toBeLessThan(0.85);
    expect(result.drifted).toBe(true);
  });

  // Test 4: finalizeBaseline() switches to monitoring mode → subsequent recordBaseline() ignored
  it('ignores recordBaseline calls after finalization', async () => {
    const detector = new SemanticDriftDetector();
    const embeddingFn = jest.fn(async () => [1, 0, 0]);

    detector.initialize(embeddingFn);

    await detector.recordBaseline('first');
    expect(embeddingFn).toHaveBeenCalledTimes(1);

    detector.finalizeBaseline();
    const metricsBefore = detector.getDriftMetrics();

    await detector.recordBaseline('second');
    expect(embeddingFn).toHaveBeenCalledTimes(1);

    const metricsAfter = detector.getDriftMetrics();
    expect(metricsAfter.baselineSize).toBe(metricsBefore.baselineSize);
    expect(metricsAfter.isBaselineFinalized).toBe(true);
  });

  // Test 5: Cosine similarity math is correct
  it('computes cosine similarity correctly for known vectors', async () => {
    const detector = new SemanticDriftDetector({ sampleRate: 1.0 });

    let embeddingIndex = 0;
    const testVectors = [
      [1, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [1, 0],
      [1, 1],
      [1, 0],
    ];

    const embeddingFn = jest.fn(async () => testVectors[embeddingIndex++] || [1, 0]);

    detector.initialize(embeddingFn);
    await detector.recordBaseline('baseline');
    detector.finalizeBaseline();

    embeddingIndex = 2;
    let result = await detector.checkDrift('[0,1]');
    expect(Math.abs(result.similarity - 0.0)).toBeLessThan(0.001);

    embeddingIndex = 4;
    result = await detector.checkDrift('[1,0]');
    expect(Math.abs(result.similarity - 1.0)).toBeLessThan(0.001);

    embeddingIndex = 6;
    result = await detector.checkDrift('[1,0]');
    expect(Math.abs(result.similarity - 1.0)).toBeLessThan(0.001);
  });

  // Test 6: Sampling rate 0.1 → ~10% of calls actually embed
  it('respects sampleRate configuration (approximately 10% sampling)', async () => {
    const detector = new SemanticDriftDetector({ sampleRate: 0.1 });
    const embeddingFn = jest.fn(async () => [1, 0]);

    detector.initialize(embeddingFn);
    await detector.recordBaseline('baseline');
    detector.finalizeBaseline();

    const NUM_CHECKS = 500;
    for (let i = 0; i < NUM_CHECKS; i++) {
      await detector.checkDrift('check');
    }

    const totalCalls = embeddingFn.mock.calls.length;
    const sampledCount = totalCalls - 1;
    const samplePercentage = sampledCount / NUM_CHECKS;

    expect(samplePercentage).toBeGreaterThan(0.07);
    expect(samplePercentage).toBeLessThan(0.13);
  });

  // Test 7: Feature-scoped baselines maintain independent centroids
  it('maintains separate baselines per feature', async () => {
    const detector = new SemanticDriftDetector({ sampleRate: 1.0 });

    const embeddingFn = jest.fn(async (text: string) => {
      if (text === 'baseline-a') return [1, 0, 0];
      if (text === 'baseline-b') return [0, 1, 0];
      return [1, 0, 0];
    });

    detector.initialize(embeddingFn);

    await detector.recordBaseline('baseline-a', 'featureA');
    detector.finalizeBaseline('featureA');

    await detector.recordBaseline('baseline-b', 'featureB');
    detector.finalizeBaseline('featureB');

    const resultA = await detector.checkDrift('test', 'featureA');
    const resultB = await detector.checkDrift('test', 'featureB');

    expect(Math.abs(resultA.similarity - resultB.similarity)).toBeGreaterThan(0.1);
  });

  // Test 8: onDriftDetected callback invoked when drifted = true
  it('invokes onDriftDetected callback when drift is detected', async () => {
    const onDriftDetected = jest.fn();
    const detector = new SemanticDriftDetector({ sampleRate: 1.0, onDriftDetected });

    const embeddingFn = jest.fn(async (text: string) => {
      if (text === 'baseline') {
        return [1, 0, 0, 0];
      }
      return [0, 1, 0, 0];
    });

    detector.initialize(embeddingFn);
    await detector.recordBaseline('baseline');
    detector.finalizeBaseline();

    const result = await detector.checkDrift('different');

    expect(result.drifted).toBe(true);
    expect(onDriftDetected).toHaveBeenCalledWith('default', expect.objectContaining({
      similarity: expect.any(Number),
      drifted: true,
      centroidDistance: expect.any(Number),
    }));
  });

  // Test 9: Rolling window evicts old entries
  it('maintains rolling window size and evicts oldest entries', async () => {
    const rollingWindowSize = 10;
    const detector = new SemanticDriftDetector({
      sampleRate: 1.0,
      rollingWindowSize,
    });

    const embeddingFn = jest.fn(async (text: string) => {
      const index = parseInt(text.split('-')[1] ?? '0', 10);
      return [Math.cos((index * Math.PI) / 180), Math.sin((index * Math.PI) / 180)];
    });

    detector.initialize(embeddingFn);
    await detector.recordBaseline('angle-0');
    detector.finalizeBaseline();

    const metricsAfterZeroCalls = detector.getDriftMetrics();
    expect(metricsAfterZeroCalls.rollingAvgSimilarity).toBe(1.0);

    for (let i = 1; i <= 20; i++) {
      await detector.checkDrift(`angle-${i}`);
    }

    const metricsAfter20 = detector.getDriftMetrics();
    expect(metricsAfter20.rollingAvgSimilarity).toBeLessThan(1.0);
    expect(metricsAfter20.rollingAvgSimilarity).toBeGreaterThan(0.0);
  });

  it('throws error if initialize not called before recordBaseline', async () => {
    const detector = new SemanticDriftDetector();

    await expect(detector.recordBaseline('text')).rejects.toThrow(
      'SemanticDriftDetector not initialized',
    );
  });

  it('throws error if initialize not called before checkDrift', async () => {
    const detector = new SemanticDriftDetector();

    await expect(detector.checkDrift('text')).rejects.toThrow(
      'SemanticDriftDetector not initialized',
    );
  });

  it('respects NEW_RELIC_AI_DRIFT_SAMPLE_RATE env var', () => {
    process.env.NEW_RELIC_AI_DRIFT_SAMPLE_RATE = '0.2';
    const detector = new SemanticDriftDetector();

    const metrics = detector.getDriftMetrics();
    expect(metrics).toBeDefined();
  });

  it('returns default metrics for uninitialized feature', () => {
    const detector = new SemanticDriftDetector();

    const metrics = detector.getDriftMetrics('unknown-feature');

    expect(metrics.rollingAvgSimilarity).toBe(1.0);
    expect(metrics.driftEventCount).toBe(0);
    expect(metrics.baselineSize).toBe(0);
    expect(metrics.isBaselineFinalized).toBe(false);
  });

  it('returns similarity from window if sampling gate skips embedding', async () => {
    const detector = new SemanticDriftDetector({ sampleRate: 0.01 });
    const embeddingFn = jest.fn(async () => [0.5, 0.5]);

    detector.initialize(embeddingFn);
    await detector.recordBaseline('baseline');
    detector.finalizeBaseline();

    jest.spyOn(Math, 'random').mockReturnValueOnce(0.99);
    const result1 = await detector.checkDrift('skipped');

    jest.spyOn(Math, 'random').mockReturnValueOnce(0.99);
    const result2 = await detector.checkDrift('also skipped');

    expect(result1.similarity).toBe(result2.similarity);
  });

  it('returns 1.0 similarity if no baseline finalized', async () => {
    const detector = new SemanticDriftDetector({ sampleRate: 1.0 });
    const embeddingFn = jest.fn(async () => [1, 0]);

    detector.initialize(embeddingFn);

    const result = await detector.checkDrift('no baseline');

    expect(result.similarity).toBe(1.0);
    expect(result.drifted).toBe(false);
  });

  it('handles empty baseline vectors', () => {
    const detector = new SemanticDriftDetector();
    const embeddingFn = jest.fn(async () => []);

    detector.initialize(embeddingFn);
    detector.finalizeBaseline();

    const metrics = detector.getDriftMetrics();

    expect(metrics.baselineSize).toBe(0);
    expect(metrics.isBaselineFinalized).toBe(true);
  });

  it('stops accepting baseline after baselineMaxSamples reached', async () => {
    const detector = new SemanticDriftDetector({ baselineMaxSamples: 5 });
    const embeddingFn = jest.fn(async () => [1, 0]);

    detector.initialize(embeddingFn);

    for (let i = 0; i < 10; i++) {
      await detector.recordBaseline('text');
    }

    const metrics = detector.getDriftMetrics();
    expect(metrics.baselineSize).toBe(5);
  });

  it('isInitialized returns false before initialize() and true after', () => {
    const detector = new SemanticDriftDetector();
    expect(detector.isInitialized()).toBe(false);
    detector.initialize(async () => [1, 0]);
    expect(detector.isInitialized()).toBe(true);
  });
});
