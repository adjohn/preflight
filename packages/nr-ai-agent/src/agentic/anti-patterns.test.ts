import { describe, it, expect, beforeEach } from '@jest/globals';
import { AntiPatternDetector, emitAntiPatternEvent } from './anti-patterns.js';
import type { SpanData } from './tracer.js';

describe('AntiPatternDetector', () => {
  let detector: AntiPatternDetector;

  const createMockSpanData = (overrides?: Partial<SpanData>): SpanData & { children: SpanData[] } => {
    const data = {
      traceId: 'trace-123',
      spanId: 'span-456',
      parentSpanId: null,
      spanType: 'agent_task' as const,
      name: 'Test Task',
      startTime: 1000,
      endTime: 2000,
      durationMs: 1000,
      customAttributes: {},
      children: [] as unknown as SpanData[],
      success: true,
      ...overrides,
    } as unknown as SpanData & { children: SpanData[] };
    return data;
  };

  const createMockChildSpan = (type: string, toolName?: string, input?: string): SpanData & { children: SpanData[] } => {
    const data = {
      traceId: 'trace-123',
      spanId: `span-${Math.random()}`,
      parentSpanId: 'span-456',
      spanType: type,
      name: type === 'tool_call' ? `Tool: ${toolName}` : 'LLM',
      startTime: 1500,
      endTime: 1600,
      durationMs: 100,
      customAttributes: {},
      children: [] as unknown as SpanData[],
      success: true,
      toolName,
      input,
    } as unknown as SpanData & { children: SpanData[] };
    return data;
  };

  beforeEach(() => {
    detector = new AntiPatternDetector();
  });

  describe('Spinning Wheels Detection', () => {
    it('detects spinning wheels with 4 identical tool calls', () => {
      const taskSpan = createMockSpanData();
      taskSpan.children = [
        createMockChildSpan('tool_call', 'readFile', 'src/auth.ts'),
        createMockChildSpan('tool_call', 'readFile', 'src/auth.ts'),
        createMockChildSpan('tool_call', 'readFile', 'src/auth.ts'),
        createMockChildSpan('tool_call', 'readFile', 'src/auth.ts'),
      ];

      const patterns = detector.analyze(taskSpan);
      expect(patterns).toContainEqual(expect.objectContaining({
        type: 'spinning_wheels',
        severity: 'high',
      }));
    });

    it('does not detect spinning wheels with 3 different tool calls', () => {
      const taskSpan = createMockSpanData();
      taskSpan.children = [
        createMockChildSpan('tool_call', 'readFile', 'src/app.ts'),
        createMockChildSpan('tool_call', 'analyzeCode', 'output'),
        createMockChildSpan('tool_call', 'writeFile', 'test.ts'),
      ];

      const patterns = detector.analyze(taskSpan);
      const spinningWheels = patterns.filter((p) => p.type === 'spinning_wheels');
      expect(spinningWheels).toHaveLength(0);
    });

    it('does not detect spinning wheels with different inputs', () => {
      const taskSpan = createMockSpanData();
      taskSpan.children = [
        createMockChildSpan('tool_call', 'readFile', 'src/auth.ts'),
        createMockChildSpan('tool_call', 'readFile', 'src/auth.test.ts'),
        createMockChildSpan('tool_call', 'readFile', 'src/auth.types.ts'),
        createMockChildSpan('tool_call', 'readFile', 'src/auth.utils.ts'),
      ];

      const patterns = detector.analyze(taskSpan);
      const spinningWheels = patterns.filter((p) => p.type === 'spinning_wheels');
      expect(spinningWheels).toHaveLength(0);
    });

    it('respects configurable spin threshold', () => {
      const customDetector = new AntiPatternDetector({ spinThreshold: 5 });
      const taskSpan = createMockSpanData();
      taskSpan.children = [
        createMockChildSpan('tool_call', 'readFile', 'src/auth.ts'),
        createMockChildSpan('tool_call', 'readFile', 'src/auth.ts'),
        createMockChildSpan('tool_call', 'readFile', 'src/auth.ts'),
        createMockChildSpan('tool_call', 'readFile', 'src/auth.ts'),
      ];

      const patterns = customDetector.analyze(taskSpan);
      const spinningWheels = patterns.filter((p) => p.type === 'spinning_wheels');
      expect(spinningWheels).toHaveLength(0);
    });
  });

  describe('Overthinking Detection', () => {
    it('detects overthinking with high depth on simple task', () => {
      const taskSpan = createMockSpanData();
      taskSpan.children = [
        createMockChildSpan('llm_call', undefined, 'short output'),
        createMockChildSpan('tool_call', 'analyze'),
      ];

      const patterns = detector.analyze(taskSpan, { reasoningDepth: 0.95 });
      expect(patterns).toContainEqual(expect.objectContaining({
        type: 'overthinking',
        severity: 'medium',
      }));
    });

    it('does not detect overthinking below threshold', () => {
      const taskSpan = createMockSpanData();
      taskSpan.children = [
        createMockChildSpan('llm_call', undefined, 'short output'),
        createMockChildSpan('tool_call', 'analyze'),
      ];

      const patterns = detector.analyze(taskSpan, { reasoningDepth: 0.5 });
      const overthinking = patterns.filter((p) => p.type === 'overthinking');
      expect(overthinking).toHaveLength(0);
    });
  });

  describe('Underthinking Detection', () => {
    it('detects underthinking with low depth on complex task', () => {
      const taskSpan = createMockSpanData();
      taskSpan.children = [
        createMockChildSpan('llm_call', undefined, 'x'.repeat(8000)),
        createMockChildSpan('tool_call', 'tool1'),
        createMockChildSpan('tool_call', 'tool2'),
        createMockChildSpan('tool_call', 'tool3'),
        createMockChildSpan('tool_call', 'tool4'),
        createMockChildSpan('tool_call', 'tool5'),
        createMockChildSpan('tool_call', 'tool6'),
        createMockChildSpan('tool_call', 'tool7'),
      ];

      const patterns = detector.analyze(taskSpan, { reasoningDepth: 0.1 });
      expect(patterns).toContainEqual(expect.objectContaining({
        type: 'underthinking',
        severity: 'medium',
      }));
    });

    it('does not detect underthinking above threshold', () => {
      const taskSpan = createMockSpanData();
      taskSpan.children = [
        createMockChildSpan('llm_call', undefined, 'x'.repeat(8000)),
        createMockChildSpan('tool_call', 'tool1'),
        createMockChildSpan('tool_call', 'tool2'),
        createMockChildSpan('tool_call', 'tool3'),
        createMockChildSpan('tool_call', 'tool4'),
        createMockChildSpan('tool_call', 'tool5'),
        createMockChildSpan('tool_call', 'tool6'),
      ];

      const patterns = detector.analyze(taskSpan, { reasoningDepth: 0.5 });
      const underthinking = patterns.filter((p) => p.type === 'underthinking');
      expect(underthinking).toHaveLength(0);
    });
  });

  describe('Context Stuffing Detection', () => {
    it('detects context stuffing at 85% pressure', () => {
      const taskSpan = createMockSpanData();

      const patterns = detector.analyze(taskSpan, { contextPressure: 0.85 });
      expect(patterns).toContainEqual(expect.objectContaining({
        type: 'context_stuffing',
        severity: 'high',
      }));
    });

    it('does not detect context stuffing below threshold', () => {
      const taskSpan = createMockSpanData();

      const patterns = detector.analyze(taskSpan, { contextPressure: 0.75 });
      const stuffing = patterns.filter((p) => p.type === 'context_stuffing');
      expect(stuffing).toHaveLength(0);
    });
  });

  describe('Token Explosion Detection', () => {
    it('detects token explosion at 55% of context window', () => {
      const taskSpan = createMockSpanData();

      const patterns = detector.analyze(taskSpan, {
        inputTokens: 40000,
        outputTokens: 30000,
      });
      expect(patterns).toContainEqual(expect.objectContaining({
        type: 'token_explosion',
        severity: 'high',
      }));
    });

    it('does not detect token explosion below threshold', () => {
      const taskSpan = createMockSpanData();

      const patterns = detector.analyze(taskSpan, {
        inputTokens: 30000,
        outputTokens: 20000,
      });
      const explosion = patterns.filter((p) => p.type === 'token_explosion');
      expect(explosion).toHaveLength(0);
    });
  });

  describe('Bail-Out Pattern Detection', () => {
    it('detects bail-out after 1 attempt with escalation', () => {
      const taskSpan = createMockSpanData();
      taskSpan.children = [createMockChildSpan('tool_call', 'analyze')];

      const patterns = detector.analyze(taskSpan, {
        stopReason: 'end_turn',
        responseText: "I apologize, I'm unable to complete this task",
      });
      expect(patterns).toContainEqual(expect.objectContaining({
        type: 'bail_out',
        severity: 'medium',
      }));
    });

    it('does not detect bail-out with 5 attempts', () => {
      const taskSpan = createMockSpanData();
      taskSpan.children = [
        createMockChildSpan('tool_call', 'tool1'),
        createMockChildSpan('tool_call', 'tool2'),
        createMockChildSpan('tool_call', 'tool3'),
        createMockChildSpan('tool_call', 'tool4'),
        createMockChildSpan('tool_call', 'tool5'),
      ];

      const patterns = detector.analyze(taskSpan, {
        stopReason: 'end_turn',
        responseText: "I apologize, I'm unable to complete this task",
      });
      const bailOut = patterns.filter((p) => p.type === 'bail_out');
      expect(bailOut).toHaveLength(0);
    });

    it('does not detect bail-out without escalation phrases', () => {
      const taskSpan = createMockSpanData();
      taskSpan.children = [createMockChildSpan('tool_call', 'analyze')];

      const patterns = detector.analyze(taskSpan, {
        stopReason: 'end_turn',
        responseText: 'Task completed successfully',
      });
      const bailOut = patterns.filter((p) => p.type === 'bail_out');
      expect(bailOut).toHaveLength(0);
    });
  });

  describe('Clean task analysis', () => {
    it('returns empty array for clean task span', () => {
      const taskSpan = createMockSpanData();
      taskSpan.children = [
        createMockChildSpan('llm_call', undefined, 'response'),
        createMockChildSpan('tool_call', 'readFile', 'src/app.ts'),
        createMockChildSpan('llm_call', undefined, 'analysis'),
      ];

      const patterns = detector.analyze(taskSpan, { reasoningDepth: 0.5 });
      expect(patterns).toHaveLength(0);
    });
  });

  describe('emitAntiPatternEvent', () => {
    it('creates valid AiAntiPattern event', () => {
      const pattern = {
        type: 'spinning_wheels',
        severity: 'high' as const,
        description: 'Test pattern',
        details: { repeatCount: 5 },
      };

      const event = emitAntiPatternEvent(pattern, 'trace-123', 'test-app');

      expect(event.id).toBeDefined();
      expect(event.timestamp).toBeGreaterThan(0);
      expect(event.traceId).toBe('trace-123');
      expect(event.patternType).toBe('spinning_wheels');
      expect(event.severity).toBe('high');
      expect(event['nr.appName']).toBe('test-app');
    });
  });
});
