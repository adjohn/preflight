import { createHash } from 'node:crypto';
import { createLogger } from '@nr-ai-observatory/shared';

const logger = createLogger('conversation-tracker');

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_CONTEXT_LIMIT = 200_000; // Conservative default context window

export interface ConversationState {
  readonly conversationId: string;
  readonly turnCount: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalThinkingTokens: number;
  readonly totalTokens: number;
  readonly totalCostUsd: number;
  readonly contextGrowthRate: number;
  readonly estimatedTurnsRemaining: number | null;
  readonly systemPromptTokenShare: number | null;
  readonly contextPressure: number;
  readonly durationMs: number;
  readonly userWaitTimeMs: number;
  readonly firstTurnTimestamp: number;
  readonly lastTurnTimestamp: number;
}

interface ConversationRecord {
  state: ConversationState;
  lastActivityMs: number;
}

export function generateConversationIdFromMessages(messages: unknown[]): string {
  // Hash the messages array excluding the last message to produce a stable fingerprint
  const prior = Array.isArray(messages) ? messages.slice(0, -1) : messages;
  const hash = createHash('sha256');
  hash.update(JSON.stringify(prior));
  return hash.digest('hex').slice(0, 16);
}

function getModelContextLimit(model: string): number {
  // Map of known model context limits
  const contextLimits: Record<string, number> = {
    'claude-opus-4': 200_000,
    'claude-opus-4-20250805': 200_000,
    'claude-opus-4-7': 200_000,
    'claude-sonnet-4': 200_000,
    'claude-sonnet-4-20250514': 200_000,
    'claude-sonnet-4-6': 200_000,
    'claude-haiku-4': 100_000,
    'claude-haiku-4-5-20251001': 100_000,
    'gpt-4': 128_000,
    'gpt-4-turbo': 128_000,
    'gpt-4o': 128_000,
    'gemini-pro': 32_000,
    'gemini-1.5-pro': 1_000_000,
    'gemini-2-flash': 1_000_000,
  };

  // Try exact match
  if (contextLimits[model]) {
    return contextLimits[model];
  }

  // Try prefix match
  for (const [modelKey, limit] of Object.entries(contextLimits)) {
    if (model.startsWith(modelKey)) {
      return limit;
    }
  }

  return DEFAULT_CONTEXT_LIMIT;
}

export class ConversationStore {
  private store = new Map<string, ConversationRecord>();
  private ttlMs: number;
  private cleanupIntervalId: NodeJS.Timeout | null = null;
  private onConversationEnd: ((state: ConversationState) => void) | null;

  constructor(
    ttlMs: number = DEFAULT_TTL_MS,
    cleanupIntervalMs: number = 60_000,
    onConversationEnd?: (state: ConversationState) => void,
  ) {
    this.ttlMs = ttlMs;
    this.onConversationEnd = onConversationEnd ?? null;

    // Start cleanup interval
    this.cleanupIntervalId = setInterval(() => {
      this.evictStaleConversations();
    }, cleanupIntervalMs);
  }

  private evictStaleConversations(): void {
    const now = Date.now();
    const staleConversationIds: string[] = [];

    for (const [conversationId, record] of this.store.entries()) {
      if (now - record.lastActivityMs > this.ttlMs) {
        staleConversationIds.push(conversationId);
      }
    }

    for (const conversationId of staleConversationIds) {
      const record = this.store.get(conversationId);
      if (record) {
        logger.info('Evicting stale conversation', {
          conversationId,
          idleDurationMs: now - record.lastActivityMs,
          turnCount: record.state.turnCount,
        });
        this.store.delete(conversationId);
        this.onConversationEnd?.(record.state);
      }
    }
  }

  getOrCreate(conversationId: string, _model: string): ConversationState {
    const existing = this.store.get(conversationId);
    if (existing) {
      return existing.state;
    }

    const now = Date.now();

    const state: ConversationState = {
      conversationId,
      turnCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalThinkingTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      contextGrowthRate: 0,
      estimatedTurnsRemaining: null,
      systemPromptTokenShare: null,
      contextPressure: 0,
      durationMs: 0,
      userWaitTimeMs: 0,
      firstTurnTimestamp: now,
      lastTurnTimestamp: now,
    };

    this.store.set(conversationId, { state, lastActivityMs: now });
    return state;
  }

  recordTurn(
    conversationId: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    thinkingTokens: number,
    costUsd: number,
    durationMs: number,
    systemPromptTokens: number | null,
  ): ConversationState {
    const existing = this.store.get(conversationId);
    if (!existing) {
      return this.getOrCreate(conversationId, model);
    }

    const now = Date.now();
    const record = existing;
    const prevState = record.state;
    const contextLimit = getModelContextLimit(model);

    const turnCount = prevState.turnCount + 1;
    const totalInputTokens = prevState.totalInputTokens + inputTokens;
    const totalOutputTokens = prevState.totalOutputTokens + outputTokens;
    const totalThinkingTokens = prevState.totalThinkingTokens + thinkingTokens;
    const totalTokens = totalInputTokens + totalOutputTokens + totalThinkingTokens;
    const totalCostUsd = prevState.totalCostUsd + costUsd;
    const userWaitTimeMs = prevState.userWaitTimeMs + durationMs;
    const durationFromFirstTurn = now - prevState.firstTurnTimestamp;

    // Context growth rate: average tokens added per turn
    const contextGrowthRate = turnCount > 0 ? totalInputTokens / turnCount : 0;

    // Estimated turns remaining
    let estimatedTurnsRemaining: number | null = null;
    if (contextGrowthRate > 0) {
      const remainingTokens = Math.max(0, contextLimit - totalInputTokens);
      estimatedTurnsRemaining = Math.ceil(remainingTokens / contextGrowthRate);
    }

    // System prompt token share: track per-turn
    let systemPromptTokenShare: number | null = null;
    if (systemPromptTokens !== null && totalInputTokens > 0) {
      systemPromptTokenShare = systemPromptTokens / totalInputTokens;
    }

    // Context pressure: current input tokens / context limit
    const contextPressure = Math.min(totalInputTokens / contextLimit, 1.0);

    const newState: ConversationState = {
      conversationId,
      turnCount,
      totalInputTokens,
      totalOutputTokens,
      totalThinkingTokens,
      totalTokens,
      totalCostUsd,
      contextGrowthRate,
      estimatedTurnsRemaining,
      systemPromptTokenShare,
      contextPressure,
      durationMs: durationFromFirstTurn,
      userWaitTimeMs,
      firstTurnTimestamp: prevState.firstTurnTimestamp,
      lastTurnTimestamp: now,
    };

    this.store.set(conversationId, { state: newState, lastActivityMs: now });
    return newState;
  }

  getState(conversationId: string): ConversationState | null {
    const record = this.store.get(conversationId);
    return record ? record.state : null;
  }

  end(conversationId: string): ConversationState | null {
    const record = this.store.get(conversationId);
    if (record) {
      this.store.delete(conversationId);
      this.onConversationEnd?.(record.state);
      return record.state;
    }
    return null;
  }

  shutdown(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
    this.store.clear();
  }
}

export function conversationStateToCustomAttributes(state: ConversationState): Record<string, string | number> {
  const attrs: Record<string, string | number> = {
    'ai.conversation.id': state.conversationId,
    'ai.conversation.turn_count': state.turnCount,
    'ai.conversation.total_tokens': state.totalTokens,
    'ai.conversation.total_input_tokens': state.totalInputTokens,
    'ai.conversation.total_output_tokens': state.totalOutputTokens,
    'ai.conversation.context_pressure': Math.round(state.contextPressure * 1000) / 1000,
    'ai.conversation.context_growth_rate': Math.round(state.contextGrowthRate * 100) / 100,
    'ai.conversation.duration_ms': state.durationMs,
    'ai.conversation.user_wait_time_ms': state.userWaitTimeMs,
  };

  if (state.totalCostUsd !== 0) {
    attrs['ai.conversation.total_cost_usd'] = Math.round(state.totalCostUsd * 1000000) / 1000000;
  }

  if (state.estimatedTurnsRemaining !== null) {
    attrs['ai.conversation.estimated_turns_remaining'] = state.estimatedTurnsRemaining;
  }

  if (state.systemPromptTokenShare !== null) {
    attrs['ai.conversation.system_prompt_token_share'] = Math.round(state.systemPromptTokenShare * 1000) / 1000;
  }

  return attrs;
}

export interface ContextManagementStats {
  readonly contextResetsCount: number;
  readonly avgTokensBetweenResets: number;
  readonly contextEfficiency: number;
}

export function conversationStateToNrEvent(
  state: ConversationState,
  appName: string,
  contextStats?: ContextManagementStats,
): Record<string, string | number> {
  const event: Record<string, string | number> = {
    eventType: 'AiConversationSummary',
    'nr.appName': appName,
    conversationId: state.conversationId,
    turnCount: state.turnCount,
    totalInputTokens: state.totalInputTokens,
    totalOutputTokens: state.totalOutputTokens,
    totalThinkingTokens: state.totalThinkingTokens,
    totalTokens: state.totalTokens,
    totalCostUsd: Math.round(state.totalCostUsd * 1000000) / 1000000,
    durationMs: state.durationMs,
    userWaitTimeMs: state.userWaitTimeMs,
    contextPressure: Math.round(state.contextPressure * 10000) / 10000,
    contextGrowthRate: Math.round(state.contextGrowthRate * 100) / 100,
  };
  if (state.estimatedTurnsRemaining !== null) {
    event.estimatedTurnsRemaining = state.estimatedTurnsRemaining;
  }
  if (state.systemPromptTokenShare !== null) {
    event.systemPromptTokenShare = Math.round(state.systemPromptTokenShare * 10000) / 10000;
  }
  if (contextStats) {
    event.contextResetsCount = contextStats.contextResetsCount;
    event.avgTokensBetweenResets = Math.round(contextStats.avgTokensBetweenResets);
    event.contextEfficiency = Math.round(contextStats.contextEfficiency * 10000) / 10000;
  }
  return event;
}
