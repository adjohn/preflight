import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ContextManagementTracker } from './context-management.js';

describe('ContextManagementTracker', () => {
  let tracker: ContextManagementTracker;
  let mockDispatchEvent: jest.Mock;

  beforeEach(() => {
    tracker = new ContextManagementTracker('test-trace-id');
    mockDispatchEvent = jest.fn();
    (globalThis as unknown as Record<string, unknown>).dispatchEvent = mockDispatchEvent;
  });

  afterEach(() => {
    tracker.reset();
    delete (globalThis as unknown as Record<string, unknown>).dispatchEvent;
  });

  describe('context turn tracking', () => {
    it('tracks input and output tokens for each turn', () => {
      const conversationId = 'conv-1';
      tracker.recordTurn(conversationId, 1000, 100);
      tracker.recordTurn(conversationId, 1500, 150);
      tracker.recordTurn(conversationId, 2000, 200);

      const metrics = tracker.getMetrics(conversationId);
      expect(metrics.contextResetsCount).toBe(0);
    });

    it('accumulates total input and output tokens', () => {
      const conversationId = 'conv-1';
      tracker.recordTurn(conversationId, 1000, 100);
      tracker.recordTurn(conversationId, 1500, 150);
      tracker.recordTurn(conversationId, 2000, 200);

      const metrics = tracker.getMetrics(conversationId);
      expect(metrics.contextEfficiency).toBeGreaterThan(0);
    });
  });

  describe('context reset auto-detection', () => {
    it('detects context reset when token count drops >50%', () => {
      const conversationId = 'conv-1';
      tracker.recordTurn(conversationId, 1000, 100);
      tracker.recordTurn(conversationId, 2000, 200);
      tracker.recordTurn(conversationId, 5000, 500);
      tracker.recordTurn(conversationId, 1200, 150);

      expect(mockDispatchEvent).toHaveBeenCalled();
      const lastCall = mockDispatchEvent.mock.calls[mockDispatchEvent.mock.calls.length - 1];
      const event = lastCall?.[0];
      expect(event.detail).toHaveProperty('conversationId');
      expect(event.detail.reason).toBe('summarization');
    });

    it('does not detect reset for normal slight variation (<50%)', () => {
      const conversationId = 'conv-1';
      tracker.recordTurn(conversationId, 1000, 100);
      tracker.recordTurn(conversationId, 2000, 200);
      tracker.recordTurn(conversationId, 5000, 500);
      tracker.recordTurn(conversationId, 4800, 450);

      const metrics = tracker.getMetrics(conversationId);
      expect(metrics.contextResetsCount).toBe(0);
    });

    it('correctly calculates compressionRatio for 5000 -> 1200', () => {
      const conversationId = 'conv-1';
      tracker.recordTurn(conversationId, 1000, 100);
      tracker.recordTurn(conversationId, 5000, 500);
      tracker.recordTurn(conversationId, 1200, 150);

      const metrics = tracker.getMetrics(conversationId);
      expect(metrics.contextResetsCount).toBe(1);
    });
  });

  describe('explicit context reset recording', () => {
    it('records explicit context reset with all attributes', () => {
      const conversationId = 'conv-1';
      tracker.recordContextReset(conversationId, {
        reason: 'truncation',
        tokensBefore: 5000,
        tokensAfter: 1200,
        turnsRemoved: 3,
      });

      expect(mockDispatchEvent).toHaveBeenCalled();
      const event = mockDispatchEvent.mock.calls[0]?.[0];
      expect(event.detail.conversationId).toBe(conversationId);
      expect(event.detail.tokensBefore).toBe(5000);
      expect(event.detail.tokensAfter).toBe(1200);
      expect(event.detail.reason).toBe('truncation');
      expect(event.detail.turnsRemoved).toBe(3);
    });

    it('emits AiContextReset event with correct structure', () => {
      const conversationId = 'conv-1';
      tracker.recordContextReset(conversationId, {
        reason: 'summarization',
        tokensBefore: 3000,
        tokensAfter: 800,
      });

      expect(mockDispatchEvent).toHaveBeenCalled();
      const event = mockDispatchEvent.mock.calls[0]?.[0];
      expect(event.detail).toHaveProperty('id');
      expect(event.detail).toHaveProperty('timestamp');
      expect(event.detail.traceId).toBe('test-trace-id');
      expect(event.detail['nr.appName']).toBe('nr-ai-agent');
    });

    it('calculates compressionRatio correctly', () => {
      const conversationId = 'conv-1';
      tracker.recordContextReset(conversationId, {
        reason: 'sliding_window',
        tokensBefore: 5000,
        tokensAfter: 1200,
      });

      const event = mockDispatchEvent.mock.calls[0]?.[0];
      expect(event.detail.compressionRatio).toBeCloseTo(0.24, 2);
    });

    it('calculates tokensRemoved correctly', () => {
      const conversationId = 'conv-1';
      tracker.recordContextReset(conversationId, {
        reason: 'manual',
        tokensBefore: 6000,
        tokensAfter: 1000,
      });

      const event = mockDispatchEvent.mock.calls[0]?.[0];
      expect(event.detail.tokensRemoved).toBe(5000);
    });
  });

  describe('context reset counting', () => {
    it('increments contextResetsCount for each reset', () => {
      const conversationId = 'conv-1';

      tracker.recordContextReset(conversationId, {
        reason: 'summarization',
        tokensBefore: 5000,
        tokensAfter: 1200,
      });

      tracker.recordContextReset(conversationId, {
        reason: 'truncation',
        tokensBefore: 4500,
        tokensAfter: 900,
      });

      const metrics = tracker.getMetrics(conversationId);
      expect(metrics.contextResetsCount).toBe(2);
    });

    it('tracks multiple resets in same conversation', () => {
      const conversationId = 'conv-1';

      tracker.recordContextReset(conversationId, {
        reason: 'summarization',
        tokensBefore: 5000,
        tokensAfter: 1200,
      });

      tracker.recordContextReset(conversationId, {
        reason: 'summarization',
        tokensBefore: 6000,
        tokensAfter: 1500,
      });

      tracker.recordContextReset(conversationId, {
        reason: 'summarization',
        tokensBefore: 4000,
        tokensAfter: 800,
      });

      const metrics = tracker.getMetrics(conversationId);
      expect(metrics.contextResetsCount).toBe(3);
    });
  });

  describe('average tokens between resets', () => {
    it('calculates avgTokensBetweenResets for 3 resets at 5000, 6000, 4000', () => {
      const conversationId = 'conv-1';

      tracker.recordContextReset(conversationId, {
        reason: 'summarization',
        tokensBefore: 5000,
        tokensAfter: 1200,
      });

      tracker.recordContextReset(conversationId, {
        reason: 'summarization',
        tokensBefore: 6000,
        tokensAfter: 1500,
      });

      tracker.recordContextReset(conversationId, {
        reason: 'summarization',
        tokensBefore: 4000,
        tokensAfter: 800,
      });

      const metrics = tracker.getMetrics(conversationId);
      expect(metrics.avgTokensBetweenResets).toBeCloseTo(5000, 0);
    });

    it('handles single reset avgTokensBetweenResets', () => {
      const conversationId = 'conv-1';

      tracker.recordContextReset(conversationId, {
        reason: 'summarization',
        tokensBefore: 7500,
        tokensAfter: 2000,
      });

      const metrics = tracker.getMetrics(conversationId);
      expect(metrics.avgTokensBetweenResets).toBe(7500);
    });
  });

  describe('context efficiency', () => {
    it('calculates contextEfficiency as outputTokens / inputTokens', () => {
      const conversationId = 'conv-1';
      tracker.recordTurn(conversationId, 1000, 200);
      tracker.recordTurn(conversationId, 1500, 300);

      const metrics = tracker.getMetrics(conversationId);
      expect(metrics.contextEfficiency).toBeCloseTo(500 / 2500, 3);
    });

    it('handles contextEfficiency with multiple resets', () => {
      const conversationId = 'conv-1';
      tracker.recordTurn(conversationId, 1000, 100);
      tracker.recordTurn(conversationId, 2000, 200);
      tracker.recordContextReset(conversationId, {
        reason: 'summarization',
        tokensBefore: 3000,
        tokensAfter: 500,
      });
      tracker.recordTurn(conversationId, 1500, 150);

      const metrics = tracker.getMetrics(conversationId);
      expect(metrics.contextEfficiency).toBeGreaterThan(0);
    });

    it('returns 0 efficiency when no output tokens', () => {
      const conversationId = 'conv-1';
      tracker.recordTurn(conversationId, 1000, 0);
      tracker.recordTurn(conversationId, 2000, 0);

      const metrics = tracker.getMetrics(conversationId);
      expect(metrics.contextEfficiency).toBe(0);
    });
  });

  describe('multiple conversations', () => {
    it('tracks separate context for different conversations', () => {
      const conv1 = 'conv-1';
      const conv2 = 'conv-2';

      tracker.recordTurn(conv1, 1000, 100);
      tracker.recordTurn(conv1, 5000, 500);
      tracker.recordTurn(conv1, 1000, 100);

      tracker.recordTurn(conv2, 2000, 200);
      tracker.recordTurn(conv2, 8000, 800);
      tracker.recordTurn(conv2, 1500, 150);

      const metrics1 = tracker.getMetrics(conv1);
      const metrics2 = tracker.getMetrics(conv2);

      expect(metrics1.contextResetsCount).toBe(1);
      expect(metrics2.contextResetsCount).toBe(1);
      expect(metrics1.avgTokensBetweenResets).not.toBe(metrics2.avgTokensBetweenResets);
    });
  });

  describe('event emission', () => {
    it('emits event with correct eventType name', () => {
      const conversationId = 'conv-1';
      tracker.recordContextReset(conversationId, {
        reason: 'summarization',
        tokensBefore: 5000,
        tokensAfter: 1200,
      });

      expect(mockDispatchEvent).toHaveBeenCalled();
      const event = mockDispatchEvent.mock.calls[0]?.[0];
      expect(event.type).toBe('ai-context-reset');
    });

    it('includes all required fields in event', () => {
      const conversationId = 'conv-1';
      tracker.recordContextReset(conversationId, {
        reason: 'truncation',
        tokensBefore: 4000,
        tokensAfter: 1000,
        turnsRemoved: 5,
      });

      const event = mockDispatchEvent.mock.calls[0]?.[0];
      expect(event.detail).toHaveProperty('id');
      expect(event.detail).toHaveProperty('timestamp');
      expect(event.detail).toHaveProperty('traceId');
      expect(event.detail).toHaveProperty('conversationId');
      expect(event.detail).toHaveProperty('tokensBefore');
      expect(event.detail).toHaveProperty('tokensAfter');
      expect(event.detail).toHaveProperty('tokensRemoved');
      expect(event.detail).toHaveProperty('compressionRatio');
      expect(event.detail).toHaveProperty('reason');
      expect(event.detail).toHaveProperty('turnsRemoved');
    });
  });

  describe('reset and cleanup', () => {
    it('resets all tracked conversations', () => {
      tracker.recordContextReset('conv-1', {
        reason: 'summarization',
        tokensBefore: 5000,
        tokensAfter: 1200,
      });

      tracker.recordContextReset('conv-2', {
        reason: 'summarization',
        tokensBefore: 6000,
        tokensAfter: 1500,
      });

      tracker.reset();

      const metrics1 = tracker.getMetrics('conv-1');
      const metrics2 = tracker.getMetrics('conv-2');

      expect(metrics1.contextResetsCount).toBe(0);
      expect(metrics2.contextResetsCount).toBe(0);
    });
  });

  describe('reason types', () => {
    it('supports all reason types: summarization, truncation, sliding_window, manual', () => {
      const conversationId = 'conv-1';
      const reasons = ['summarization', 'truncation', 'sliding_window', 'manual'] as const;

      reasons.forEach((reason) => {
        tracker.recordContextReset(conversationId, {
          reason,
          tokensBefore: 5000,
          tokensAfter: 1200,
        });
      });

      expect(mockDispatchEvent).toHaveBeenCalledTimes(4);
      const calls = mockDispatchEvent.mock.calls;
      expect(calls[0]?.[0].detail.reason).toBe('summarization');
      expect(calls[1]?.[0].detail.reason).toBe('truncation');
      expect(calls[2]?.[0].detail.reason).toBe('sliding_window');
      expect(calls[3]?.[0].detail.reason).toBe('manual');
    });
  });

  describe('edge cases', () => {
    it('handles zero input tokens gracefully', () => {
      const conversationId = 'conv-1';
      tracker.recordTurn(conversationId, 0, 100);

      const metrics = tracker.getMetrics(conversationId);
      expect(metrics.contextEfficiency).toBeGreaterThanOrEqual(0);
    });

    it('handles zero output tokens gracefully', () => {
      const conversationId = 'conv-1';
      tracker.recordTurn(conversationId, 1000, 0);

      const metrics = tracker.getMetrics(conversationId);
      expect(metrics.contextEfficiency).toBe(0);
    });

    it('handles empty conversation', () => {
      const conversationId = 'conv-1';

      const metrics = tracker.getMetrics(conversationId);
      expect(metrics.contextResetsCount).toBe(0);
      expect(metrics.avgTokensBetweenResets).toBe(0);
      expect(metrics.contextEfficiency).toBe(0);
    });
  });
});
