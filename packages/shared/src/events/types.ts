export type AiProvider = 'anthropic' | 'google' | 'openai' | 'bedrock' | 'mistral' | 'cohere';

export type AiRequestMethod =
  | 'messages.create'
  | 'messages.stream'
  | 'models.generateContent'
  | 'models.generateContentStream'
  | 'models.embedContent'
  | 'chat.completions.create'
  | 'converse'
  | 'converse-stream'
  | 'chat.complete'
  | 'chat.stream'
  | 'chat'
  | 'chatStream';

export interface AiRequest {
  id: string;
  timestamp: number;
  provider: AiProvider;
  model: string;
  requestMethod: AiRequestMethod;

  maxTokens: number | null;
  temperature: number | null;
  topP: number | null;
  systemPromptLength: number | null;
  messageCount: number;
  toolCount: number;
  toolNames: string[];
  thinkingEnabled: boolean;
  thinkingBudgetTokens: number | null;
  streamingEnabled: boolean;

  'nr.appName': string;
  'nr.entityGuid': string | null;
  customAttributes: Record<string, string | number>;
}

export interface AiResponse {
  id: string;
  timestamp: number;
  provider: AiProvider;
  model: string;

  durationMs: number;
  timeToFirstTokenMs: number | null;
  tokensPerSecond: number | null;

  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;

  costInputUsd: number | null;
  costOutputUsd: number | null;
  costThinkingUsd: number | null;
  costCacheReadUsd: number | null;
  costCacheCreationUsd: number | null;
  costTotalUsd: number | null;

  stopReason: string | null;
  contentBlockTypes: string[];

  error: { type: string; message: string; statusCode: number | null } | null;

  'nr.appName': string;
  customAttributes: Record<string, string | number>;
}

export type AiMessageRole = 'system' | 'user' | 'assistant';

export interface AiMessage {
  id: string;
  timestamp: number;
  role: AiMessageRole;
  content: string;
  contentLength: number;
  sequence: number;

  'nr.appName': string;
  customAttributes: Record<string, string | number>;
}

export type NrEventData = Record<string, string | number | boolean>;

export type SpanType = 'agent_task' | 'llm_call' | 'tool_call' | 'sub_agent' | 'planning';

export interface SpanAttributes {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly spanType: SpanType;
  readonly name: string;
  readonly startTime: number;
  readonly endTime: number | null;
  readonly durationMs: number | null;
  readonly success: boolean | null;
  readonly output?: string;
  readonly model?: string;
  readonly toolName?: string;
  readonly input?: string;
  readonly customAttributes: Record<string, string | number>;
}

export interface AiAgentTaskSummary {
  readonly id: string;
  readonly timestamp: number;
  readonly traceId: string;
  readonly spanId: string;
  readonly taskName: string;
  readonly durationMs: number;
  readonly totalLlmCalls: number;
  readonly totalToolCalls: number;
  readonly totalTokens: number;
  readonly totalCostUsd: number | null;
  readonly stepCount: number;
  readonly success: boolean;
  readonly delegationCount?: number;
  readonly spawnCount?: number;
  readonly delegationDepth?: number;
  readonly interAgentMessages?: number;
  readonly delegationOverheadMs?: number;
  readonly 'nr.appName': string;
  readonly customAttributes: Record<string, string | number>;
}

export type AntiPatternType = 'spinning_wheels' | 'overthinking' | 'underthinking' | 'context_stuffing' | 'token_explosion' | 'bail_out';

export interface AiAntiPattern {
  readonly id: string;
  readonly timestamp: number;
  readonly traceId: string;
  readonly patternType: AntiPatternType;
  readonly severity: 'low' | 'medium' | 'high';
  readonly description: string;
  readonly toolName?: string;
  readonly repeatCount?: number;
  readonly depthIndex?: number;
  readonly taskComplexity?: 'simple' | 'moderate' | 'complex';
  readonly contextPressure?: number;
  readonly tokenShare?: number;
  readonly attemptCount?: number;
  readonly 'nr.appName': string;
  readonly customAttributes: Record<string, string | number>;
}

export interface AiAgentMessage {
  readonly id: string;
  readonly timestamp: number;
  readonly traceId: string;
  readonly fromAgent: string;
  readonly toAgent: string;
  readonly messageType: string;
  readonly tokenCount?: number;
  readonly 'nr.appName': string;
  readonly customAttributes: Record<string, string | number>;
}

export interface AiContextReset {
  readonly id: string;
  readonly timestamp: number;
  readonly traceId: string;
  readonly conversationId: string;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly tokensRemoved: number;
  readonly compressionRatio: number;
  readonly reason: 'summarization' | 'truncation' | 'sliding_window' | 'manual';
  readonly turnsRemoved?: number;
  readonly 'nr.appName': string;
  readonly customAttributes: Record<string, string | number>;
}
