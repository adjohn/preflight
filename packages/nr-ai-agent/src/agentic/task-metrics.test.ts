import { describe, it, expect, beforeEach } from '@jest/globals';
import { TaskMetricsCalculator, TaskMetricsAggregator } from './task-metrics.js';
import type { SpanData } from './tracer.js';

describe('TaskMetricsCalculator', () => {
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

  const createMockChildSpan = (type: string, model?: string): SpanData & { children: SpanData[] } => {
    const data = {
      traceId: 'trace-123',
      spanId: `span-${Math.random()}`,
      parentSpanId: 'span-456',
      spanType: type,
      name: type === 'tool_call' ? 'Tool' : 'LLM',
      startTime: 1500,
      endTime: 1600,
      durationMs: 100,
      customAttributes: {},
      children: [] as unknown as SpanData[],
      success: true,
      model,
    } as unknown as SpanData & { children: SpanData[] };
    return data;
  };

  describe('computePerTaskMetrics', () => {
    it('calculates correct metrics for task with 3 LLM calls and 4 tool calls', () => {
      const taskSpan = createMockSpanData();
      taskSpan.children = [
        createMockChildSpan('llm_call', 'gpt-4'),
        createMockChildSpan('llm_call', 'gpt-4'),
        createMockChildSpan('llm_call', 'gpt-4'),
        createMockChildSpan('tool_call'),
        createMockChildSpan('tool_call'),
        createMockChildSpan('tool_call'),
        createMockChildSpan('tool_call'),
      ];

      const metrics = TaskMetricsCalculator.computePerTaskMetrics(taskSpan);

      expect(metrics.llmCallsPerTask).toBe(3);
      expect(metrics.toolCallsPerTask).toBe(4);
      expect(metrics.totalSteps).toBe(7);
      expect(metrics.taskDurationMs).toBe(1000);
      expect(metrics.success).toBe(true);
    });

    it('calculates toolCallChainDepth correctly for flat task', () => {
      const taskSpan = createMockSpanData();
      taskSpan.children = [
        createMockChildSpan('llm_call'),
        createMockChildSpan('tool_call'),
        createMockChildSpan('llm_call'),
      ];

      const metrics = TaskMetricsCalculator.computePerTaskMetrics(taskSpan);

      expect(metrics.toolCallChainDepth).toBe(1);
    });

    it('calculates toolCallChainDepth correctly for nested task', () => {
      const taskSpan = createMockSpanData();
      const subAgent = createMockChildSpan('sub_agent') as unknown as SpanData;
      const subAgentTool = createMockChildSpan('tool_call') as unknown as SpanData;
      const subAgentLlm = createMockChildSpan('llm_call') as unknown as SpanData;

      (subAgent as unknown as { children: SpanData[] }).children = [subAgentTool, subAgentLlm];
      taskSpan.children = [subAgent];

      const metrics = TaskMetricsCalculator.computePerTaskMetrics(taskSpan);

      expect(metrics.toolCallChainDepth).toBeGreaterThan(1);
    });

    it('handles task with zero tool calls', () => {
      const taskSpan = createMockSpanData();
      taskSpan.children = [
        createMockChildSpan('llm_call'),
        createMockChildSpan('llm_call'),
      ];

      const metrics = TaskMetricsCalculator.computePerTaskMetrics(taskSpan);

      expect(metrics.toolCallsPerTask).toBe(0);
      expect(metrics.llmCallsPerTask).toBe(2);
      expect(metrics.totalSteps).toBe(2);
    });

    it('handles task with zero LLM calls', () => {
      const taskSpan = createMockSpanData();
      taskSpan.children = [
        createMockChildSpan('tool_call'),
        createMockChildSpan('tool_call'),
      ];

      const metrics = TaskMetricsCalculator.computePerTaskMetrics(taskSpan);

      expect(metrics.llmCallsPerTask).toBe(0);
      expect(metrics.toolCallsPerTask).toBe(2);
      expect(metrics.totalSteps).toBe(2);
    });

    it('records success status correctly', () => {
      const successTask = createMockSpanData({ success: true });
      const failedTask = createMockSpanData({ success: false });

      const successMetrics = TaskMetricsCalculator.computePerTaskMetrics(successTask);
      const failedMetrics = TaskMetricsCalculator.computePerTaskMetrics(failedTask);

      expect(successMetrics.success).toBe(true);
      expect(failedMetrics.success).toBe(false);
    });
  });
});

describe('TaskMetricsAggregator', () => {
  let aggregator: TaskMetricsAggregator;

  beforeEach(() => {
    aggregator = new TaskMetricsAggregator();
  });

  it('starts with zero aggregates', () => {
    const stats = aggregator.getAggregateStats();

    expect(stats.completedTaskCount).toBe(0);
    expect(stats.avgCostPerTask).toBe(0);
    expect(stats.p95CostPerTask).toBe(0);
    expect(stats.avgStepsPerTask).toBe(0);
    expect(stats.completionRate).toBe(0);
  });

  it('calculates correct average cost after recording metrics', () => {
    aggregator.recordTaskMetrics({
      taskDurationMs: 1000,
      totalSteps: 5,
      llmCallsPerTask: 2,
      toolCallsPerTask: 3,
      tokensPerTask: 100,
      costPerTaskUsd: 0.1,
      toolCallChainDepth: 2,
      success: true,
    });

    aggregator.recordTaskMetrics({
      taskDurationMs: 1500,
      totalSteps: 7,
      llmCallsPerTask: 3,
      toolCallsPerTask: 4,
      tokensPerTask: 200,
      costPerTaskUsd: 0.2,
      toolCallChainDepth: 2,
      success: true,
    });

    const stats = aggregator.getAggregateStats();

    expect(stats.completedTaskCount).toBe(2);
    expect(stats.avgCostPerTask).toBe(0.15);
    expect(stats.avgStepsPerTask).toBe(6);
    expect(stats.avgDurationMs).toBe(1250);
  });

  it('calculates completion rate correctly', () => {
    aggregator.recordTaskMetrics({
      taskDurationMs: 1000,
      totalSteps: 5,
      llmCallsPerTask: 2,
      toolCallsPerTask: 3,
      tokensPerTask: 100,
      costPerTaskUsd: 0.1,
      toolCallChainDepth: 2,
      success: true,
    });

    aggregator.recordTaskMetrics({
      taskDurationMs: 1000,
      totalSteps: 5,
      llmCallsPerTask: 2,
      toolCallsPerTask: 3,
      tokensPerTask: 100,
      costPerTaskUsd: 0.1,
      toolCallChainDepth: 2,
      success: true,
    });

    aggregator.recordTaskMetrics({
      taskDurationMs: 1000,
      totalSteps: 5,
      llmCallsPerTask: 2,
      toolCallsPerTask: 3,
      tokensPerTask: 100,
      costPerTaskUsd: 0.1,
      toolCallChainDepth: 2,
      success: false,
    });

    const stats = aggregator.getAggregateStats();

    expect(stats.completionRate).toBeCloseTo(0.6667, 4);
  });

  it('calculates p95 cost correctly', () => {
    const costs = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.1];

    costs.forEach((cost) => {
      aggregator.recordTaskMetrics({
        taskDurationMs: 1000,
        totalSteps: 5,
        llmCallsPerTask: 2,
        toolCallsPerTask: 3,
        tokensPerTask: 100,
        costPerTaskUsd: cost,
        toolCallChainDepth: 2,
        success: true,
      });
    });

    const stats = aggregator.getAggregateStats();

    expect(stats.p95CostPerTask).toBeGreaterThanOrEqual(0.09);
    expect(stats.p95CostPerTask).toBeLessThanOrEqual(0.1);
  });

  it('maintains rolling window of 100 tasks', () => {
    for (let i = 0; i < 150; i++) {
      aggregator.recordTaskMetrics({
        taskDurationMs: 1000,
        totalSteps: 5,
        llmCallsPerTask: 2,
        toolCallsPerTask: 3,
        tokensPerTask: 100,
        costPerTaskUsd: 0.1,
        toolCallChainDepth: 2,
        success: true,
      });
    }

    expect(aggregator.getTaskCount()).toBe(100);
  });

  it('calculates average tool and LLM calls per task', () => {
    aggregator.recordTaskMetrics({
      taskDurationMs: 1000,
      totalSteps: 5,
      llmCallsPerTask: 2,
      toolCallsPerTask: 3,
      tokensPerTask: 100,
      costPerTaskUsd: 0.1,
      toolCallChainDepth: 2,
      success: true,
    });

    aggregator.recordTaskMetrics({
      taskDurationMs: 1000,
      totalSteps: 7,
      llmCallsPerTask: 3,
      toolCallsPerTask: 4,
      tokensPerTask: 100,
      costPerTaskUsd: 0.1,
      toolCallChainDepth: 2,
      success: true,
    });

    const stats = aggregator.getAggregateStats();

    expect(stats.avgLlmCallsPerTask).toBe(2.5);
    expect(stats.avgToolCallsPerTask).toBe(3.5);
  });

  it('resets all metrics on reset()', () => {
    aggregator.recordTaskMetrics({
      taskDurationMs: 1000,
      totalSteps: 5,
      llmCallsPerTask: 2,
      toolCallsPerTask: 3,
      tokensPerTask: 100,
      costPerTaskUsd: 0.1,
      toolCallChainDepth: 2,
      success: true,
    });

    expect(aggregator.getTaskCount()).toBe(1);

    aggregator.reset();

    expect(aggregator.getTaskCount()).toBe(0);
    const stats = aggregator.getAggregateStats();
    expect(stats.completedTaskCount).toBe(0);
  });

  it('returns copy of metrics list', () => {
    aggregator.recordTaskMetrics({
      taskDurationMs: 1000,
      totalSteps: 5,
      llmCallsPerTask: 2,
      toolCallsPerTask: 3,
      tokensPerTask: 100,
      costPerTaskUsd: 0.1,
      toolCallChainDepth: 2,
      success: true,
    });

    const metrics = aggregator.getMetrics();
    metrics.push({
      taskDurationMs: 2000,
      totalSteps: 10,
      llmCallsPerTask: 5,
      toolCallsPerTask: 5,
      tokensPerTask: 200,
      costPerTaskUsd: 0.2,
      toolCallChainDepth: 3,
      success: true,
    });

    expect(aggregator.getTaskCount()).toBe(1);
  });

  it('handles zero duration tasks', () => {
    aggregator.recordTaskMetrics({
      taskDurationMs: 0,
      totalSteps: 1,
      llmCallsPerTask: 1,
      toolCallsPerTask: 0,
      tokensPerTask: 0,
      costPerTaskUsd: 0,
      toolCallChainDepth: 1,
      success: true,
    });

    const stats = aggregator.getAggregateStats();

    expect(stats.avgDurationMs).toBe(0);
    expect(stats.completedTaskCount).toBe(1);
  });

  it('calculates correct averages with mixed success/failure', () => {
    for (let i = 0; i < 8; i++) {
      aggregator.recordTaskMetrics({
        taskDurationMs: 1000,
        totalSteps: 5,
        llmCallsPerTask: 2,
        toolCallsPerTask: 3,
        tokensPerTask: 100,
        costPerTaskUsd: 0.1,
        toolCallChainDepth: 2,
        success: true,
      });
    }

    for (let i = 0; i < 2; i++) {
      aggregator.recordTaskMetrics({
        taskDurationMs: 1000,
        totalSteps: 5,
        llmCallsPerTask: 2,
        toolCallsPerTask: 3,
        tokensPerTask: 100,
        costPerTaskUsd: 0.1,
        toolCallChainDepth: 2,
        success: false,
      });
    }

    const stats = aggregator.getAggregateStats();

    expect(stats.completionRate).toBe(0.8);
    expect(stats.completedTaskCount).toBe(10);
  });

  describe('getSpinningWheelsRate()', () => {
    it('returns 0 when no tasks have been recorded', () => {
      expect(aggregator.getSpinningWheelsRate()).toBe(0);
    });

    it('returns correct rate after recording tasks with spinning wheels', () => {
      aggregator.recordSpinningWheels();
      for (let i = 0; i < 2; i++) {
        aggregator.recordTaskMetrics({
          taskDurationMs: 1000,
          totalSteps: 2,
          llmCallsPerTask: 1,
          toolCallsPerTask: 1,
          tokensPerTask: 50,
          costPerTaskUsd: 0.01,
          toolCallChainDepth: 1,
          success: true,
        });
      }
      expect(aggregator.getSpinningWheelsRate()).toBe(0.5);
    });
  });
});
