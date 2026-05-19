import { describe, it, expect, beforeEach } from '@jest/globals';
import { VercelAiTelemetryHandler, createTelemetryHandler } from './vercel-ai.js';

describe('VercelAiTelemetryHandler (Vercel AI Integration)', () => {
  let handler: VercelAiTelemetryHandler;

  beforeEach(() => {
    handler = new VercelAiTelemetryHandler();
    handler.clearEvents();
  });

  describe('generateText tracking', () => {
    it('tracks generateText start and end', () => {
      handler.onGenerateStart({ prompt: 'What is AI?' }, 'gpt-4');
      handler.onGenerateEnd({ text: 'AI is...' });

      const events = handler.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('generateText');
      expect(events[0].model).toBe('gpt-4');
    });

    it('tracks generateText end', () => {
      handler.onGenerateStart({ prompt: 'test' }, 'gpt-4');
      handler.onGenerateEnd({ text: 'AI is...' });

      const events = handler.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].finishTime).toBeGreaterThan(0);
    });

    it('captures generateText output', () => {
      handler.onGenerateStart({}, 'gpt-4');
      handler.onGenerateEnd({ text: 'response text' });

      const events = handler.getEvents();
      expect((events[0] as unknown as Record<string, unknown>).output).toEqual({ text: 'response text' });
    });

    it('does not emit event if not ended', () => {
      handler.onGenerateStart({}, 'gpt-4');
      let events = handler.getEvents();
      expect(events).toHaveLength(0);

      handler.onGenerateEnd({});
      events = handler.getEvents();
      expect(events).toHaveLength(1);
    });
  });

  describe('streamText tracking', () => {
    it('tracks streamText start', () => {
      handler.onStreamStart({ prompt: 'test' }, 'gpt-4');

      const events = handler.getEvents();
      expect(events).toHaveLength(0);
    });

    it('captures time to first token (TTFT)', () => {
      handler.onStreamStart({}, 'gpt-4');

      handler.onStreamFirstToken();
      handler.onStreamEnd({});

      const events = handler.getEvents();
      expect(events[0]).toHaveProperty('ttft');
      expect((events[0] as unknown as Record<string, unknown>).ttft as number).toBeGreaterThanOrEqual(0);
    });

    it('tracks streamText end', () => {
      handler.onStreamStart({}, 'gpt-4');
      handler.onStreamFirstToken();
      handler.onStreamEnd({ text: 'streamed response' });

      const events = handler.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('streamText');
    });
  });

  describe('tool call tracking', () => {
    it('tracks tool calls during generation', () => {
      handler.onGenerateStart({}, 'gpt-4');
      handler.onToolCall('calculator', { operation: 'add', a: 2, b: 2 });
      handler.onToolCall('search', { query: 'what is AI' });
      handler.onGenerateEnd({});

      const events = handler.getEvents();
      expect(events[0].toolCalls).toHaveLength(2);
      expect(events[0].toolCalls?.[0].name).toBe('calculator');
      expect(events[0].toolCalls?.[1].name).toBe('search');
    });

    it('captures tool call arguments', () => {
      handler.onGenerateStart({}, 'gpt-4');
      handler.onToolCall('calculator', { a: 5, b: 3, operation: 'multiply' });
      handler.onGenerateEnd({});

      const events = handler.getEvents();
      expect(events[0].toolCalls?.[0].args).toEqual({ a: 5, b: 3, operation: 'multiply' });
    });

    it('handles multiple tool calls in sequence', () => {
      handler.onGenerateStart({}, 'gpt-4');
      for (let i = 0; i < 5; i++) {
        handler.onToolCall(`tool_${i}`, { index: i });
      }
      handler.onGenerateEnd({});

      const events = handler.getEvents();
      expect(events[0].toolCalls).toHaveLength(5);
    });
  });

  describe('error handling', () => {
    it('captures errors with message', () => {
      handler.onGenerateStart({}, 'gpt-4');
      const error = new Error('Connection timeout');
      handler.onError(error);

      const events = handler.getEvents();
      expect(events).toHaveLength(1);
      expect((events[0] as unknown as Record<string, unknown>).error).toBe('Connection timeout');
    });

    it('clears active generation on error', () => {
      handler.onGenerateStart({}, 'gpt-4');
      handler.onError(new Error('test error'));

      handler.onGenerateStart({}, 'gpt-4');
      handler.onGenerateEnd({});

      const events = handler.getEvents();
      expect(events).toHaveLength(2);
    });
  });

  describe('event management', () => {
    it('clears all events', () => {
      handler.onGenerateStart({}, 'gpt-4');
      handler.onGenerateEnd({});
      expect(handler.getEvents()).toHaveLength(1);

      handler.clearEvents();
      expect(handler.getEvents()).toHaveLength(0);
    });

    it('returns copy of events', () => {
      handler.onGenerateStart({}, 'gpt-4');
      handler.onGenerateEnd({});

      const events1 = handler.getEvents();
      const events2 = handler.getEvents();

      expect(events1).not.toBe(events2);
      expect(events1).toEqual(events2);
    });
  });

  describe('multi-turn interactions', () => {
    it('tracks multiple separate generations', () => {
      handler.onGenerateStart({ prompt: 'first' }, 'gpt-4');
      handler.onGenerateEnd({ text: 'response 1' });

      handler.onGenerateStart({ prompt: 'second' }, 'gpt-4');
      handler.onGenerateEnd({ text: 'response 2' });

      const events = handler.getEvents();
      expect(events).toHaveLength(2);
    });

    it('tracks streaming followed by non-streaming', () => {
      handler.onStreamStart({}, 'gpt-4');
      handler.onStreamEnd({});

      handler.onGenerateStart({}, 'gpt-4');
      handler.onGenerateEnd({});

      const events = handler.getEvents();
      expect(events[0].type).toBe('streamText');
      expect(events[1].type).toBe('generateText');
    });
  });

  describe('factory function', () => {
    it('creates telemetry handler', () => {
      const handler1 = createTelemetryHandler();
      expect(handler1).toBeInstanceOf(VercelAiTelemetryHandler);
    });

    it('passes options to handler', () => {
      const handler1 = createTelemetryHandler({ captureStreamingMetrics: false });
      expect(handler1).toBeInstanceOf(VercelAiTelemetryHandler);
    });
  });

  describe('options', () => {
    it('initializes with options', () => {
      const handler1 = new VercelAiTelemetryHandler({ captureStreamingMetrics: false });
      expect(handler1).toBeInstanceOf(VercelAiTelemetryHandler);
    });

    it('defaults streaming metrics capture', () => {
      const handler1 = new VercelAiTelemetryHandler();
      handler1.onStreamStart({}, 'gpt-4');
      handler1.onStreamFirstToken();
      handler1.onStreamEnd({});

      const events = handler1.getEvents();
      expect(events[0]).toHaveProperty('ttft');
    });
  });
});
