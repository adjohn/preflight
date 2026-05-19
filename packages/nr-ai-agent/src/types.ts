import type { MultiModalMetrics } from './metrics/multimodal.js';
import type { ReasoningMetrics } from './metrics/reasoning.js';

export interface AiRequestRecord {
  readonly id: string;
  readonly timestamp: number;
  readonly provider: 'anthropic' | 'google' | 'openai' | 'bedrock' | 'mistral' | 'cohere';
  readonly model: string;
  readonly requestModel: string;
  readonly requestMethod: string;
  readonly streaming: boolean;

  // Request params
  readonly maxTokens: number | null;
  readonly temperature: number | null;
  readonly topP: number | null;
  readonly topK: number | null;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly toolNames: readonly string[];
  readonly thinkingEnabled: boolean;
  readonly thinkingBudgetTokens: number | null;
  readonly systemPromptLength: number | null;

  // Response data
  readonly durationMs: number;
  readonly timeToFirstTokenMs: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly thinkingTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly totalTokens: number;
  readonly stopReason: string | null;
  readonly contentBlockTypes: readonly string[];

  // Content (only if recordContent=true)
  readonly systemPrompt: string | null;
  readonly lastUserMessage: string | null;
  readonly responseText: string | null;

  // Per-request attribution metadata (extracted from metadata.nr.* before SDK forwarding)
  readonly requestMetadata?: Record<string, unknown> | null;

  // Multimodal input metrics
  readonly modalityMetrics?: MultiModalMetrics | null;

  // Reasoning metrics (extended thinking)
  readonly reasoningMetrics?: ReasoningMetrics | null;

  // Conversation tracking
  readonly conversationId?: string;
  readonly cost?: number;

  // Error info
  readonly error: {
    readonly type: string;
    readonly message: string;
    readonly statusCode: number | null;
  } | null;
}

export interface AiEmbeddingRecord {
  readonly id: string;
  readonly timestamp: number;
  readonly provider: 'anthropic' | 'google' | 'openai' | 'bedrock' | 'mistral' | 'cohere';
  readonly model: string;
  readonly requestModel: string;

  // Response data
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly embeddingDimensions: number;
  readonly embeddingCount: number;

  // Error info
  readonly error: {
    readonly type: string;
    readonly message: string;
    readonly statusCode: number | null;
  } | null;
}

export type EmbeddingRecordHandler = (record: AiEmbeddingRecord) => void;

export interface WrapperConfig {
  readonly enabled: boolean;
  readonly recordContent: boolean;
  readonly highSecurity: boolean;
  readonly contentMaxLength: number;
  readonly redactionPatterns: readonly RegExp[];
}

export type RecordHandler = (record: AiRequestRecord) => void;

export type { AttributionTags } from './metrics/cost-attribution.js';
