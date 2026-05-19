export interface DriftResult {
  readonly similarity: number;
  readonly drifted: boolean;
  readonly centroidDistance: number;
}

export interface DriftMetrics {
  readonly rollingAvgSimilarity: number;
  readonly driftEventCount: number;
  readonly baselineSize: number;
  readonly isBaselineFinalized: boolean;
}

export interface SemanticDriftOptions {
  readonly sampleRate?: number;
  readonly driftThreshold?: number;
  readonly baselineMaxSamples?: number;
  readonly rollingWindowSize?: number;
  readonly onDriftDetected?: (feature: string, result: DriftResult) => void;
}

interface FeatureState {
  baselineVectors: number[][];
  centroid: number[] | null;
  finalized: boolean;
  similarityWindow: number[];
  driftEventCount: number;
}

export class SemanticDriftDetector {
  private embeddingFn: ((text: string) => Promise<number[]>) | null = null;
  private sampleRate: number;
  private driftThreshold: number;
  private baselineMaxSamples: number;
  private rollingWindowSize: number;
  private onDriftDetected: ((feature: string, result: DriftResult) => void) | undefined;
  private featureStates: Map<string, FeatureState> = new Map();

  constructor(options?: SemanticDriftOptions) {
    const envSampleRate = process.env.NEW_RELIC_AI_DRIFT_SAMPLE_RATE
      ? parseFloat(process.env.NEW_RELIC_AI_DRIFT_SAMPLE_RATE)
      : null;

    this.sampleRate = envSampleRate ?? options?.sampleRate ?? 0.1;
    if (this.sampleRate <= 0 || this.sampleRate > 1) {
      this.sampleRate = 0.1;
    }

    this.driftThreshold = options?.driftThreshold ?? 0.85;
    this.baselineMaxSamples = options?.baselineMaxSamples ?? 1000;
    this.rollingWindowSize = options?.rollingWindowSize ?? 100;
    this.onDriftDetected = options?.onDriftDetected;
  }

  initialize(embeddingFn: (text: string) => Promise<number[]>): void {
    this.embeddingFn = embeddingFn;
  }

  isInitialized(): boolean {
    return this.embeddingFn !== null;
  }

  async recordBaseline(text: string, feature: string = 'default'): Promise<void> {
    if (!this.embeddingFn) {
      throw new Error('SemanticDriftDetector not initialized. Call initialize() first.');
    }

    let state = this.featureStates.get(feature);
    if (!state) {
      state = {
        baselineVectors: [],
        centroid: null,
        finalized: false,
        similarityWindow: [],
        driftEventCount: 0,
      };
      this.featureStates.set(feature, state);
    }

    if (state.finalized) {
      return;
    }

    if (state.baselineVectors.length >= this.baselineMaxSamples) {
      return;
    }

    const embedding = await this.embeddingFn(text);
    state.baselineVectors.push(embedding);
  }

  finalizeBaseline(feature: string = 'default'): void {
    let state = this.featureStates.get(feature);
    if (!state) {
      state = {
        baselineVectors: [],
        centroid: null,
        finalized: true,
        similarityWindow: [],
        driftEventCount: 0,
      };
      this.featureStates.set(feature, state);
      return;
    }

    if (state.baselineVectors.length === 0) {
      state.finalized = true;
      state.centroid = null;
      return;
    }

    state.centroid = this.computeCentroid(state.baselineVectors);
    state.finalized = true;
  }

  async checkDrift(text: string, feature: string = 'default'): Promise<DriftResult> {
    if (!this.embeddingFn) {
      throw new Error('SemanticDriftDetector not initialized. Call initialize() first.');
    }

    let state = this.featureStates.get(feature);
    if (!state) {
      state = {
        baselineVectors: [],
        centroid: null,
        finalized: false,
        similarityWindow: [],
        driftEventCount: 0,
      };
      this.featureStates.set(feature, state);
    }

    if (!state.finalized || !state.centroid) {
      return { similarity: 1.0, drifted: false, centroidDistance: 0 };
    }

    if (Math.random() >= this.sampleRate) {
      const lastSimilarity = state.similarityWindow[state.similarityWindow.length - 1] ?? 1.0;
      return {
        similarity: lastSimilarity,
        drifted: lastSimilarity < this.driftThreshold,
        centroidDistance: 1 - lastSimilarity,
      };
    }

    const embedding = await this.embeddingFn(text);
    const similarity = this.cosineSimilarity(embedding, state.centroid);
    const drifted = similarity < this.driftThreshold;

    state.similarityWindow.push(similarity);
    if (state.similarityWindow.length > this.rollingWindowSize) {
      state.similarityWindow.shift();
    }

    if (drifted) {
      state.driftEventCount += 1;
      if (this.onDriftDetected) {
        this.onDriftDetected(feature, {
          similarity,
          drifted,
          centroidDistance: 1 - similarity,
        });
      }
    }

    return {
      similarity,
      drifted,
      centroidDistance: 1 - similarity,
    };
  }

  getDriftMetrics(feature: string = 'default'): DriftMetrics {
    const state = this.featureStates.get(feature);

    if (!state) {
      return {
        rollingAvgSimilarity: 1.0,
        driftEventCount: 0,
        baselineSize: 0,
        isBaselineFinalized: false,
      };
    }

    const rollingAvgSimilarity =
      state.similarityWindow.length > 0
        ? state.similarityWindow.reduce((a, b) => a + b, 0) / state.similarityWindow.length
        : 1.0;

    return {
      rollingAvgSimilarity,
      driftEventCount: state.driftEventCount,
      baselineSize: state.baselineVectors.length,
      isBaselineFinalized: state.finalized,
    };
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || b.length === 0) {
      return 1.0;
    }

    const dotProduct = a.reduce((sum, ai, i) => sum + ai * (b[i] ?? 0), 0);
    const normA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
    const normB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0));

    if (normA === 0 || normB === 0) {
      return 1.0;
    }

    return dotProduct / (normA * normB);
  }

  private computeCentroid(vectors: number[][]): number[] {
    if (vectors.length === 0) {
      return [];
    }

    const dimensionality = vectors[0].length;
    const centroid: number[] = new Array(dimensionality).fill(0);

    for (const vector of vectors) {
      for (let i = 0; i < dimensionality; i++) {
        centroid[i] += vector[i] ?? 0;
      }
    }

    for (let i = 0; i < dimensionality; i++) {
      centroid[i] /= vectors.length;
    }

    return centroid;
  }
}
