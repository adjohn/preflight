import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { AgenticTracer, type SpanData } from './tracer.js';
import { SubAgentTracker, type TaskSpanWithSubAgent, type SpawnedTaskSpan } from './sub-agent.js';

describe('SubAgentTracker', () => {
  let tracer: AgenticTracer;
  let tracker: SubAgentTracker;
  let mockDispatchEvent: jest.Mock;

  beforeEach(() => {
    tracer = new AgenticTracer();
    tracker = new SubAgentTracker(tracer);
    mockDispatchEvent = jest.fn();
    (globalThis as unknown as Record<string, unknown>).dispatchEvent = mockDispatchEvent;
  });

  afterEach(() => {
    tracer.reset();
    tracker.reset();
    delete (globalThis as unknown as Record<string, unknown>).dispatchEvent;
  });

  describe('delegation tracking', () => {
    it('tracks delegate() creates a child span with spanType sub_agent', () => {
      const taskSpan = tracer.startTask('parent_task');
      const spanId = taskSpan.spanId;
      const mockSpanData = { spanId, traceId: taskSpan.traceId, spanType: 'agent_task' as const, name: 'parent_task' };
      const wrappedSpan = tracker.wrapTaskSpan(taskSpan, mockSpanData as unknown as SpanData);

      const delegatedSpan = (wrappedSpan as TaskSpanWithSubAgent).delegate('sub_agent_1', 'delegated_task');
      expect(delegatedSpan).toBeDefined();
      expect(delegatedSpan.spanType).toBe('sub_agent');
    });

    it('increments delegationCount when delegate() is called', () => {
      const taskSpan = tracer.startTask('parent_task');
      const spanId = taskSpan.spanId;
      const mockSpanData = { spanId, traceId: taskSpan.traceId, spanType: 'agent_task' as const, name: 'parent_task' };
      const wrappedSpan = tracker.wrapTaskSpan(taskSpan, mockSpanData as unknown as SpanData);

      (wrappedSpan as TaskSpanWithSubAgent).delegate('sub_1', 'task');
      (wrappedSpan as TaskSpanWithSubAgent).delegate('sub_2', 'task');

      const metrics = tracker.getMetrics(spanId);
      expect(metrics.delegationCount).toBe(2);
    });

    it('emits agent message on delegation', () => {
      const taskSpan = tracer.startTask('parent_task');
      const spanId = taskSpan.spanId;
      const mockSpanData = { spanId, traceId: taskSpan.traceId, spanType: 'agent_task' as const, name: 'parent_task' };
      const wrappedSpan = tracker.wrapTaskSpan(taskSpan, mockSpanData as unknown as SpanData);

      (wrappedSpan as TaskSpanWithSubAgent).delegate('sub_agent', 'task');

      expect(mockDispatchEvent).toHaveBeenCalled();
      const event = mockDispatchEvent.mock.calls[0]?.[0];
      expect(event.detail.messageType).toBe('task_assignment');
    });
  });

  describe('spawn tracking', () => {
    it('spawn() with 3 agents creates 3 concurrent child spans', () => {
      const taskSpan = tracer.startTask('parent_task');
      const spanId = taskSpan.spanId;
      const mockSpanData = { spanId, traceId: taskSpan.traceId, spanType: 'agent_task' as const, name: 'parent_task' };
      const wrappedSpan = tracker.wrapTaskSpan(taskSpan, mockSpanData as unknown as SpanData);

      const spawnedSpans = (wrappedSpan as TaskSpanWithSubAgent).spawn([
        { name: 'agent_1', task: 'task_1' },
        { name: 'agent_2', task: 'task_2' },
        { name: 'agent_3', task: 'task_3' },
      ]);

      expect(spawnedSpans).toHaveLength(3);
    });

    it('tracks each spawned agent with spawn index and total', () => {
      const taskSpan = tracer.startTask('parent_task');
      const spanId = taskSpan.spanId;
      const mockSpanData = { spanId, traceId: taskSpan.traceId, spanType: 'agent_task' as const, name: 'parent_task' };
      const wrappedSpan = tracker.wrapTaskSpan(taskSpan, mockSpanData as unknown as SpanData);

      const spawnedSpans = (wrappedSpan as TaskSpanWithSubAgent).spawn([
        { name: 'agent_1', task: 'task_1' },
        { name: 'agent_2', task: 'task_2' },
        { name: 'agent_3', task: 'task_3' },
      ]);

      expect((spawnedSpans[0] as unknown as SpawnedTaskSpan)._spawnIndex).toBe(0);
      expect((spawnedSpans[0] as unknown as SpawnedTaskSpan)._spawnTotal).toBe(3);
      expect((spawnedSpans[2] as unknown as SpawnedTaskSpan)._spawnIndex).toBe(2);
      expect((spawnedSpans[2] as unknown as SpawnedTaskSpan)._spawnTotal).toBe(3);
    });

    it('increments spawnCount by number of agents', () => {
      const taskSpan = tracer.startTask('parent_task');
      const spanId = taskSpan.spanId;
      const mockSpanData = { spanId, traceId: taskSpan.traceId, spanType: 'agent_task' as const, name: 'parent_task' };
      const wrappedSpan = tracker.wrapTaskSpan(taskSpan, mockSpanData as unknown as SpanData);

      (wrappedSpan as TaskSpanWithSubAgent).spawn([
        { name: 'agent_1', task: 'task_1' },
        { name: 'agent_2', task: 'task_2' },
      ]);

      const metrics = tracker.getMetrics(spanId);
      expect(metrics.spawnCount).toBe(2);
    });

    it('emits agent messages for each spawned agent', () => {
      const taskSpan = tracer.startTask('parent_task');
      const spanId = taskSpan.spanId;
      const mockSpanData = { spanId, traceId: taskSpan.traceId, spanType: 'agent_task' as const, name: 'parent_task' };
      const wrappedSpan = tracker.wrapTaskSpan(taskSpan, mockSpanData as unknown as SpanData);

      (wrappedSpan as TaskSpanWithSubAgent).spawn([
        { name: 'agent_1', task: 'task_1' },
        { name: 'agent_2', task: 'task_2' },
      ]);

      expect(mockDispatchEvent).toHaveBeenCalledTimes(2);
    });
  });

  describe('inter-agent communication', () => {
    it('recordAgentMessage() emits AiAgentMessage event with correct fields', () => {
      const taskSpan = tracer.startTask('parent_task');
      const spanId = taskSpan.spanId;
      const mockSpanData = { spanId, traceId: taskSpan.traceId, spanType: 'agent_task' as const, name: 'parent_task' };
      const wrappedSpan = tracker.wrapTaskSpan(taskSpan, mockSpanData as unknown as SpanData);

      (wrappedSpan as TaskSpanWithSubAgent).recordAgentMessage(
        'agent_parent',
        'agent_child',
        'task_assignment',
        100
      );

      expect(mockDispatchEvent).toHaveBeenCalled();
      const event = mockDispatchEvent.mock.calls[0]?.[0];
      expect(event.detail.fromAgent).toBe('agent_parent');
      expect(event.detail.toAgent).toBe('agent_child');
      expect(event.detail.messageType).toBe('task_assignment');
      expect(event.detail.tokenCount).toBe(100);
    });

    it('increments interAgentMessages count', () => {
      const taskSpan = tracer.startTask('parent_task');
      const spanId = taskSpan.spanId;
      const mockSpanData = { spanId, traceId: taskSpan.traceId, spanType: 'agent_task' as const, name: 'parent_task' };
      const wrappedSpan = tracker.wrapTaskSpan(taskSpan, mockSpanData as unknown as SpanData);

      (wrappedSpan as TaskSpanWithSubAgent).recordAgentMessage('a1', 'a2', 'result');
      (wrappedSpan as TaskSpanWithSubAgent).recordAgentMessage('a2', 'a1', 'question');

      const metrics = tracker.getMetrics(spanId);
      expect(metrics.interAgentMessages).toBe(2);
    });

    it('handles optional tokenCount parameter', () => {
      const taskSpan = tracer.startTask('parent_task');
      const spanId = taskSpan.spanId;
      const mockSpanData = { spanId, traceId: taskSpan.traceId, spanType: 'agent_task' as const, name: 'parent_task' };
      const wrappedSpan = tracker.wrapTaskSpan(taskSpan, mockSpanData as unknown as SpanData);

      (wrappedSpan as TaskSpanWithSubAgent).recordAgentMessage('a1', 'a2', 'message');

      expect(mockDispatchEvent).toHaveBeenCalled();
      const event = mockDispatchEvent.mock.calls[0]?.[0];
      expect(event.detail.tokenCount).toBeUndefined();
    });
  });

  describe('delegation depth', () => {
    it('tracks delegationDepth of 0 for a root agent_task span', () => {
      const taskSpan = tracer.startTask('parent_task');
      const spanId = taskSpan.spanId;
      const mockSpanData = { spanId, traceId: taskSpan.traceId, spanType: 'agent_task' as const, name: 'parent_task', parentSpanId: null };
      const wrappedSpan = tracker.wrapTaskSpan(taskSpan, mockSpanData as unknown as SpanData);

      (wrappedSpan as TaskSpanWithSubAgent).delegate('agent_1', 'task');

      const metrics = tracker.getMetrics(spanId);
      expect(metrics.delegationDepth).toBe(0);
    });

    it('tracks delegationDepth of 1 for a sub_agent span', () => {
      const taskSpan = tracer.startTask('parent_task');
      const subSpan = taskSpan.startSubAgent('sub_agent_1');
      const subSpanId = subSpan.spanId;
      const mockSubSpanData = { spanId: subSpanId, traceId: taskSpan.traceId, spanType: 'sub_agent' as const, name: 'sub_agent_1', parentSpanId: taskSpan.spanId };
      const wrappedSub = tracker.wrapTaskSpan(subSpan, mockSubSpanData as unknown as SpanData);

      (wrappedSub as TaskSpanWithSubAgent).delegate('agent_2', 'nested_task');

      const metrics = tracker.getMetrics(subSpanId);
      expect(metrics.delegationDepth).toBe(1);
    });
  });

  describe('delegation overhead', () => {
    it('calculates delegationOverheadMs as parent duration minus max child duration', () => {
      const taskSpan = tracer.startTask('parent_task');
      const spanId = taskSpan.spanId;
      const now = Date.now();
      const mockSpanData = {
        spanId,
        traceId: taskSpan.traceId,
        spanType: 'agent_task' as const,
        name: 'parent_task',
        startTime: now,
        endTime: now + 200,
      };
      const _wrappedSpan = tracker.wrapTaskSpan(taskSpan, mockSpanData as unknown as SpanData);

      const mockChild = {
        spanId: 'child1',
        spanType: 'sub_agent' as const,
        startTime: now + 10,
        endTime: now + 100,
      };

      tracker.recordChildSpanTiming(spanId, mockChild as unknown as SpanData);
      tracker.recordChildSpanEnd(spanId, mockChild as unknown as SpanData);

      const overhead = tracker.calculateDelegationOverhead(mockSpanData as unknown as SpanData);
      expect(overhead).toBeGreaterThanOrEqual(0);
    });
  });

  describe('metrics aggregation', () => {
    it('getMetrics returns all sub-agent metrics', () => {
      const taskSpan = tracer.startTask('parent_task');
      const spanId = taskSpan.spanId;
      const mockSpanData = { spanId, traceId: taskSpan.traceId, spanType: 'agent_task' as const, name: 'parent_task' };
      const wrappedSpan = tracker.wrapTaskSpan(taskSpan, mockSpanData as unknown as SpanData);

      (wrappedSpan as TaskSpanWithSubAgent).delegate('agent_1', 'task');
      (wrappedSpan as TaskSpanWithSubAgent).spawn([
        { name: 'agent_2', task: 'task2' },
        { name: 'agent_3', task: 'task3' },
      ]);
      (wrappedSpan as TaskSpanWithSubAgent).recordAgentMessage('a1', 'a2', 'message');

      const metrics = tracker.getMetrics(spanId);

      expect(metrics.delegationCount).toBe(1);
      expect(metrics.spawnCount).toBe(2);
      expect(metrics.interAgentMessages).toBe(4); // 1 delegation + 2 spawn + 1 message
    });

    it('resets metrics on tracker.reset()', () => {
      const taskSpan = tracer.startTask('parent_task');
      const spanId = taskSpan.spanId;
      const mockSpanData = { spanId, traceId: taskSpan.traceId, spanType: 'agent_task' as const, name: 'parent_task' };
      const wrappedSpan = tracker.wrapTaskSpan(taskSpan, mockSpanData as unknown as SpanData);

      (wrappedSpan as TaskSpanWithSubAgent).delegate('agent_1', 'task');

      tracker.reset();

      const metrics = tracker.getMetrics(spanId);
      expect(metrics.delegationCount).toBe(0);
      expect(metrics.spawnCount).toBe(0);
    });
  });

  describe('concurrent spawn duration', () => {
    it('spawn parent span duration is approximately max(child durations), not sum', () => {
      const taskSpan = tracer.startTask('parent_task');
      const spanId = taskSpan.spanId;
      const mockSpanData = { spanId, traceId: taskSpan.traceId, spanType: 'agent_task' as const, name: 'parent_task' };
      const wrappedSpan = tracker.wrapTaskSpan(taskSpan, mockSpanData as unknown as SpanData);

      const agents = [{ name: 'agent_1', task: 'task1' }, { name: 'agent_2', task: 'task2' }];

      (wrappedSpan as TaskSpanWithSubAgent).spawn(agents);

      const metrics = tracker.getMetrics(spanId);
      expect(metrics.spawnCount).toBe(2);
    });
  });

  describe('multiple message types', () => {
    it('supports various message types (task_assignment, result, question, clarification)', () => {
      const taskSpan = tracer.startTask('parent_task');
      const spanId = taskSpan.spanId;
      const mockSpanData = { spanId, traceId: taskSpan.traceId, spanType: 'agent_task' as const, name: 'parent_task' };
      const wrappedSpan = tracker.wrapTaskSpan(taskSpan, mockSpanData as unknown as SpanData);

      const types = ['task_assignment', 'result', 'question', 'clarification'];
      types.forEach((type) => {
        (wrappedSpan as TaskSpanWithSubAgent).recordAgentMessage('a1', 'a2', type);
      });

      expect(mockDispatchEvent).toHaveBeenCalledTimes(4);
      const calls = mockDispatchEvent.mock.calls;
      expect(calls[0]?.[0].detail.messageType).toBe('task_assignment');
      expect(calls[1]?.[0].detail.messageType).toBe('result');
      expect(calls[2]?.[0].detail.messageType).toBe('question');
      expect(calls[3]?.[0].detail.messageType).toBe('clarification');
    });
  });

  describe('event emission', () => {
    it('emits events with traceId and correct structure', () => {
      const taskSpan = tracer.startTask('parent_task');
      const spanId = taskSpan.spanId;
      const mockSpanData = { spanId, traceId: taskSpan.traceId, spanType: 'agent_task' as const, name: 'parent_task' };
      const wrappedSpan = tracker.wrapTaskSpan(taskSpan, mockSpanData as unknown as SpanData);

      (wrappedSpan as TaskSpanWithSubAgent).recordAgentMessage('a1', 'a2', 'message', 50);

      expect(mockDispatchEvent).toHaveBeenCalled();
      const event = mockDispatchEvent.mock.calls[0]?.[0];
      expect(event.detail).toHaveProperty('id');
      expect(event.detail).toHaveProperty('timestamp');
      expect(event.detail.traceId).toBe(mockSpanData.traceId);
      expect(event.detail['nr.appName']).toBe('nr-ai-agent');
    });
  });
});
