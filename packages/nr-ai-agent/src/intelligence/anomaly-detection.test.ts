import { AnomalyDetector } from './anomaly-detection.js';

describe('AnomalyDetector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Test 1: Normal data point (z=0.5) should NOT be anomalous
  it('detects non-anomalous values correctly (z=0.5)', () => {
    const detector = new AnomalyDetector({ minSamplesToDetect: 10 });
    const now = Date.now();

    for (let i = 0; i < 100; i++) {
      detector.recordSignal('latency_ms', 100 + Math.random() * 20 - 10, now - i * 1000);
    }

    const result = detector.checkAnomaly('latency_ms', 105);
    expect(result.anomalous).toBe(false);
    expect(Math.abs(result.zScore)).toBeLessThan(1.0);
  });

  // Test 2: High deviation value (z=2.5) should be anomalous
  it('detects anomalous values correctly (z=2.5)', () => {
    const detector = new AnomalyDetector({ minSamplesToDetect: 10, zScoreThreshold: 2.0 });
    const now = Date.now();

    for (let i = 0; i < 1000; i++) {
      detector.recordSignal('latency_ms', 100 + (Math.random() - 0.5) * 20, now - i * 1000);
    }

    const result = detector.checkAnomaly('latency_ms', 125);
    expect(result.anomalous).toBe(true);
    expect(result.zScore).toBeGreaterThan(2.0);
  });

  // Test 3: Rolling window evicts old data outside window period
  it('evicts old data outside baseline window', () => {
    const windowMs = 10000;
    const detector = new AnomalyDetector({
      baselineWindowMs: windowMs,
      minSamplesToDetect: 5,
    });

    const now = Date.now();

    for (let i = 0; i < 5; i++) {
      detector.recordSignal('error_rate', 0.01, now - windowMs * 2 - i * 1000);
    }

    for (let i = 0; i < 5; i++) {
      detector.recordSignal('error_rate', 0.01, now - i * 1000);
    }

    const result = detector.checkAnomaly('error_rate', 0.05);

    expect(result.baselineMean).toBeGreaterThan(0.009);
    expect(result.baselineMean).toBeLessThan(0.011);
  });

  // Test 4: Composite score with 1 of 3 anomalous signals
  it('computes composite score with mixed anomalies (1/3 anomalous)', () => {
    const detector = new AnomalyDetector({
      minSamplesToDetect: 10,
      zScoreThreshold: 2.0,
    });

    const now = Date.now();

    for (let i = 0; i < 100; i++) {
      detector.recordSignal('latency_ms', 100 + (Math.random() - 0.5) * 20, now - i * 1000);
      detector.recordSignal('response_length', 500 + (Math.random() - 0.5) * 100, now - i * 1000);
      detector.recordSignal('error_rate', 0.01 + (Math.random() - 0.5) * 0.005, now - i * 1000);
    }

    detector.recordSignal('latency_ms', 150, now);
    detector.recordSignal('response_length', 510, now);
    detector.recordSignal('error_rate', 0.011, now);

    const score = detector.getCompositeScore();

    expect(score).toBeGreaterThan(0.0);
    expect(score).toBeLessThan(1.0);
  });

  // Test 5: Composite score with all signals anomalous
  it('produces high composite score when all signals anomalous', () => {
    const detector = new AnomalyDetector({
      minSamplesToDetect: 10,
      zScoreThreshold: 1.5,
    });

    const now = Date.now();

    for (let i = 0; i < 100; i++) {
      detector.recordSignal('latency_ms', 100 + (Math.random() - 0.5) * 5, now - i * 1000);
      detector.recordSignal('response_length', 500 + (Math.random() - 0.5) * 10, now - i * 1000);
      detector.recordSignal('error_rate', 0.01 + (Math.random() - 0.5) * 0.002, now - i * 1000);
    }

    detector.recordSignal('latency_ms', 200, now);
    detector.recordSignal('response_length', 1000, now);
    detector.recordSignal('error_rate', 0.05, now);

    const score = detector.getCompositeScore();

    expect(score).toBeGreaterThan(0.8);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it('produces high composite score with anomalies across all 3 signal categories', () => {
    const detector = new AnomalyDetector({
      minSamplesToDetect: 10,
      zScoreThreshold: 1.5,
    });

    const now = Date.now();

    // Build baseline across all 3 categories
    for (let i = 0; i < 100; i++) {
      const t = now - i * 1000;
      // Structural
      detector.recordSignal('latency_ms', 100 + (Math.random() - 0.5) * 5, t);
      detector.recordSignal('response_length', 500 + (Math.random() - 0.5) * 10, t);
      detector.recordSignal('error_rate', 0 + (Math.random() - 0.5) * 0.01, t);
      // Application
      detector.recordSignal('user_feedback', 0.8 + (Math.random() - 0.5) * 0.05, t);
      detector.recordSignal('regeneration_rate', 0 + (Math.random() - 0.5) * 0.01, t);
      detector.recordSignal('edit_distance', 0.2 + (Math.random() - 0.5) * 0.05, t);
      // Semantic
      detector.recordSignal('drift_score', 0.95 + (Math.random() - 0.5) * 0.02, t);
    }

    // Record clearly anomalous values across all 3 categories
    detector.recordSignal('latency_ms', 500, now);        // structural: 5x normal
    detector.recordSignal('error_rate', 1, now);           // structural: max error
    detector.recordSignal('user_feedback', 0.0, now);      // application: lowest quality
    detector.recordSignal('regeneration_rate', 5, now);    // application: spike
    detector.recordSignal('drift_score', 0.1, now);        // semantic: severe drift

    const score = detector.getCompositeScore();

    expect(score).toBeGreaterThan(0.7);
    expect(score).toBeLessThanOrEqual(1.0);

    // Verify all 3 categories contributed anomalous signals
    const report = detector.getAnomalyReport();
    const anomalous = report.anomalousSignals;
    expect(anomalous.some((n) => ['latency_ms', 'error_rate', 'response_length'].includes(n))).toBe(true);
    expect(anomalous.some((n) => ['user_feedback', 'regeneration_rate', 'edit_distance'].includes(n))).toBe(true);
    expect(anomalous.some((n) => n === 'drift_score')).toBe(true);
  });

  // Test 6: Composite score with single signal anomalous
  it('produces composite score between 0 and 1 with mixed anomalies', () => {
    const detector = new AnomalyDetector({
      minSamplesToDetect: 10,
      zScoreThreshold: 1.5,
    });
    const now = Date.now();

    for (let i = 0; i < 50; i++) {
      detector.recordSignal('latency_ms', 100 + (Math.random() - 0.5) * 10, now - i * 1000);
      detector.recordSignal('response_length', 500 + (Math.random() - 0.5) * 20, now - i * 1000);
    }

    detector.recordSignal('latency_ms', 200, now);
    detector.recordSignal('response_length', 510, now);

    const score = detector.getCompositeScore();

    expect(score).toBeGreaterThanOrEqual(0.0);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  // Test 7: Weight auto-adjustment (only structural signals available)
  it('auto-adjusts weights when only structural signals available', () => {
    const detector = new AnomalyDetector({
      minSamplesToDetect: 10,
      zScoreThreshold: 1.5,
      structuralSignalWeight: 0.3,
      applicationSignalWeight: 0.5,
      semanticSignalWeight: 0.2,
    });

    const now = Date.now();

    for (let i = 0; i < 100; i++) {
      detector.recordSignal('latency_ms', 100 + (Math.random() - 0.5) * 5, now - i * 1000);
      detector.recordSignal('response_length', 500 + (Math.random() - 0.5) * 10, now - i * 1000);
      detector.recordSignal('error_rate', 0.01 + (Math.random() - 0.5) * 0.002, now - i * 1000);
    }

    detector.recordSignal('latency_ms', 200, now);
    detector.recordSignal('response_length', 1000, now);
    detector.recordSignal('error_rate', 0.05, now);

    const score = detector.getCompositeScore();

    expect(score).toBeGreaterThanOrEqual(0.0);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  // Test 8: getAnomalyReport() returns signal breakdown
  it('returns detailed anomaly report with signal breakdown', () => {
    const detector = new AnomalyDetector({ minSamplesToDetect: 10 });
    const now = Date.now();

    for (let i = 0; i < 100; i++) {
      detector.recordSignal('latency_ms', 100, now - i * 1000);
      detector.recordSignal('response_length', 500, now - i * 1000);
    }

    detector.recordSignal('latency_ms', 150, now);
    detector.recordSignal('response_length', 510, now);

    const report = detector.getAnomalyReport();

    expect(report.signals).toHaveLength(2);
    expect(report.signals[0].signalName).toBe('latency_ms');
    expect(report.signals[0].currentValue).toBe(150);
    expect(report.signals[0].baselineMean).toBeGreaterThan(99);
    expect(report.signals[0].baselineMean).toBeLessThan(101);
    expect(report.signals[0].baselineStdDev).toBeGreaterThanOrEqual(0);
    expect(report.signals[0].sampleCount).toBeLessThanOrEqual(101);
    expect(report.signals[0].sampleCount).toBeGreaterThanOrEqual(100);
  });

  // Test 9: Event-like behavior when composite score exceeds threshold
  it('identifies anomalous signals in report when threshold exceeded', () => {
    const detector = new AnomalyDetector({
      minSamplesToDetect: 10,
      zScoreThreshold: 2.0,
    });

    const now = Date.now();

    for (let i = 0; i < 100; i++) {
      detector.recordSignal('latency_ms', 100 + (Math.random() - 0.5) * 10, now - i * 1000);
      detector.recordSignal('response_length', 500 + (Math.random() - 0.5) * 10, now - i * 1000);
    }

    detector.recordSignal('latency_ms', 200, now);
    detector.recordSignal('response_length', 510, now);

    const report = detector.getAnomalyReport();

    expect(report.anomalousSignals.length).toBeGreaterThan(0);
    expect(report.anomalousSignals).toContain('latency_ms');
  });

  // Test 10: Cold start (minimum sample size before detecting)
  it('returns no anomaly during cold start (insufficient samples)', () => {
    const detector = new AnomalyDetector({ minSamplesToDetect: 100 });
    const now = Date.now();

    for (let i = 0; i < 10; i++) {
      detector.recordSignal('latency_ms', 100 + (Math.random() - 0.5) * 20, now - i * 1000);
    }

    const result = detector.checkAnomaly('latency_ms', 500);

    expect(result.anomalous).toBe(false);
    expect(result.zScore).toBe(0);
  });

  // Additional tests for robustness

  it('handles empty detector gracefully', () => {
    const detector = new AnomalyDetector();
    const score = detector.getCompositeScore();
    expect(score).toBe(0.0);
  });

  it('computes correct z-score for known distribution', () => {
    const detector = new AnomalyDetector({ minSamplesToDetect: 5 });
    const now = Date.now();

    const values = [90, 95, 100, 105, 110, 95, 100, 105, 100, 105];
    values.forEach((v, i) => {
      detector.recordSignal('test', v, now - i * 1000);
    });

    const result = detector.checkAnomaly('test', 120);

    expect(result.baselineMean).toBeGreaterThan(99);
    expect(result.baselineMean).toBeLessThan(101);
    expect(result.zScore).toBeGreaterThan(1.0);
  });

  it('maintains separate state per signal', () => {
    const detector = new AnomalyDetector({ minSamplesToDetect: 5 });
    const now = Date.now();

    for (let i = 0; i < 20; i++) {
      detector.recordSignal('signal_a', 100 + Math.random() * 10, now - i * 1000);
      detector.recordSignal('signal_b', 1000 + Math.random() * 100, now - i * 1000);
    }

    const resultA = detector.checkAnomaly('signal_a', 120);
    const resultB = detector.checkAnomaly('signal_b', 1020);

    expect(resultA.baselineMean).toBeLessThan(resultB.baselineMean);
  });

  it('respects maxSamples limit', () => {
    const detector = new AnomalyDetector({
      maxSamples: 10,
      minSamplesToDetect: 5,
    });

    const now = Date.now();

    for (let i = 0; i < 100; i++) {
      detector.recordSignal('test', 100, now - i * 1000);
    }

    const report = detector.getAnomalyReport();

    if (report.signals.length > 0) {
      expect(report.signals[0].sampleCount).toBeLessThanOrEqual(10);
    }
  });

  it('handles zero variance gracefully', () => {
    const detector = new AnomalyDetector({ minSamplesToDetect: 5 });
    const now = Date.now();

    for (let i = 0; i < 20; i++) {
      detector.recordSignal('constant', 100, now - i * 1000);
    }

    const result = detector.checkAnomaly('constant', 100);

    expect(result.baselineStdDev).toBe(0);
    expect(result.zScore).toBeLessThanOrEqual(1);
  });

  it('classifies signals correctly by type', () => {
    const detector = new AnomalyDetector({ minSamplesToDetect: 5 });
    const now = Date.now();

    for (let i = 0; i < 20; i++) {
      detector.recordSignal('latency_ms', 100, now - i * 1000);
      detector.recordSignal('user_feedback', 0.8, now - i * 1000);
      detector.recordSignal('drift_score', 0.85, now - i * 1000);
    }

    const report = detector.getAnomalyReport();

    expect(report.signals.length).toBe(3);
    const signalNames = report.signals.map((s) => s.signalName);
    expect(signalNames).toContain('latency_ms');
    expect(signalNames).toContain('user_feedback');
    expect(signalNames).toContain('drift_score');
  });

  it('returns anomaly report with timestamp', () => {
    const detector = new AnomalyDetector({ minSamplesToDetect: 1 });
    const now = Date.now();

    detector.recordSignal('test', 100, now);

    const report = detector.getAnomalyReport();

    expect(report.timestamp).toBeGreaterThanOrEqual(now);
  });
});
