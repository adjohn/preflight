import { randomUUID } from 'node:crypto';
import type { AiContextReset } from '@nr-ai-observatory/shared';

export interface ContextResetDetails {
  readonly reason: 'summarization' | 'truncation' | 'sliding_window' | 'manual';
  readonly turnsRemoved?: number;
}

export interface ContextManagementMetrics {
  readonly contextResetsCount: number;
  readonly avgTokensBetweenResets: number;
  readonly contextEfficiency: number;
}

interface ConversationContextTrack {
  tokenHistory: number[];
  resetEvents: Array<{ tokensBefore: number; tokensAfter: number; timestamp: number }>;
  outputTokensTotal: number;
  inputTokensTotal: number;
}

const CONTEXT_RESET_THRESHOLD = 0.5;

export class ContextManagementTracker {
  private conversationTracks = new Map<string, ConversationContextTrack>();
  private traceId: string;

  constructor(traceId: string = '') {
    this.traceId = traceId;
  }

  recordTurn(conversationId: string, inputTokens: number, outputTokens: number): void {
    const track = this.getOrCreateTrack(conversationId);
    track.tokenHistory.push(inputTokens);
    track.inputTokensTotal += inputTokens;
    track.outputTokensTotal += outputTokens;

    // Auto-detect context reset
    if (track.tokenHistory.length >= 2) {
      const prevTokens = track.tokenHistory[track.tokenHistory.length - 2];
      const currentTokens = inputTokens;

      const tokenDropRatio = (prevTokens - currentTokens) / prevTokens;
      if (tokenDropRatio > CONTEXT_RESET_THRESHOLD) {
        this.recordContextReset(conversationId, {
          reason: 'summarization',
          tokensBefore: prevTokens,
          tokensAfter: currentTokens,
        });
      }
    }
  }

  recordContextReset(
    conversationId: string,
    details: ContextResetDetails & { tokensBefore?: number; tokensAfter?: number }
  ): void {
    const track = this.getOrCreateTrack(conversationId);
    const tokensBefore = details.tokensBefore || (track.tokenHistory[track.tokenHistory.length - 1] || 0);
    const tokensAfter = details.tokensAfter || 0;

    const contextReset: AiContextReset = {
      id: randomUUID(),
      timestamp: Date.now(),
      traceId: this.traceId,
      conversationId,
      tokensBefore,
      tokensAfter,
      tokensRemoved: Math.max(0, tokensBefore - tokensAfter),
      compressionRatio: tokensAfter / Math.max(1, tokensBefore),
      reason: details.reason,
      turnsRemoved: details.turnsRemoved,
      'nr.appName': 'nr-ai-agent',
      customAttributes: {},
    };

    track.resetEvents.push({
      tokensBefore,
      tokensAfter,
      timestamp: Date.now(),
    });

    this.emitContextResetEvent(contextReset);
  }

  getMetrics(conversationId: string): ContextManagementMetrics {
    const track = this.conversationTracks.get(conversationId);

    if (!track) {
      return {
        contextResetsCount: 0,
        avgTokensBetweenResets: 0,
        contextEfficiency: 0,
      };
    }

    const contextResetsCount = track.resetEvents.length;
    const avgTokensBetweenResets =
      track.resetEvents.length > 0
        ? track.resetEvents.reduce((sum, evt) => sum + evt.tokensBefore, 0) / track.resetEvents.length
        : 0;

    const contextEfficiency =
      track.inputTokensTotal > 0 ? track.outputTokensTotal / track.inputTokensTotal : 0;

    return {
      contextResetsCount,
      avgTokensBetweenResets,
      contextEfficiency,
    };
  }

  private getOrCreateTrack(conversationId: string): ConversationContextTrack {
    if (!this.conversationTracks.has(conversationId)) {
      this.conversationTracks.set(conversationId, {
        tokenHistory: [],
        resetEvents: [],
        outputTokensTotal: 0,
        inputTokensTotal: 0,
      });
    }

    return this.conversationTracks.get(conversationId)!;
  }

  private emitContextResetEvent(event: AiContextReset): void {
    globalThis.dispatchEvent?.(
      new CustomEvent('ai-context-reset', {
        detail: event,
      })
    );
  }

  reset(): void {
    this.conversationTracks.clear();
  }
}
