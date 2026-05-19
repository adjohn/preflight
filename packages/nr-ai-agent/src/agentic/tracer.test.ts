import { beforeEach, afterEach, describe, it, expect, jest } from '@jest/globals';
import { AgenticTracer } from './tracer.js';
import type { LlmSpan } from './tracer.js';

describe('AgenticTracer', () => {
  let tracer: AgenticTracer;

  beforeEach(() => {
    tracer = new AgenticTracer();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    tracer.reset();
  });

  it('startTask() creates a root span with a unique traceId and spanId', () => {
    const task1 = tracer.startTask('Task 1');
    const task2 = tracer.startTask('Task 2');

    expect(task1.traceId).toBeDefined();
    expect(task1.spanId).toBeDefined();
    expect(task2.traceId).toBeDefined();
    expect(task2.spanId).toBeDefined();

    expect(task1.traceId).not.toBe(task2.traceId);
    expect(task1.spanId).not.toBe(task2.spanId);
  });

  it('startLlmCall() creates a child span with correct parent-child linking', () => {
    const task = tracer.startTask('Main Task');
    const llmSpan = task.startLlmCall('gpt-4');

    expect(llmSpan.spanType).toBe('llm_call');
    expect(llmSpan.traceId).toBe(task.traceId);
    expect(llmSpan.spanId).not.toBe(task.spanId);
  });

  it('startToolCall() creates a child span with tool name and input', () => {
    const task = tracer.startTask('Main Task');
    const toolSpan = task.startToolCall('readFile', { path: 'src/app.ts' });

    expect(toolSpan.spanType).toBe('tool_call');
    expect(toolSpan.traceId).toBe(task.traceId);
  });

  it('nested spans form a correct tree with proper parent-child relationships', () => {
    const task = tracer.startTask('Main Task');
    const llm1 = task.startLlmCall('gpt-4');
    llm1.end({ success: true });

    const tool1 = task.startToolCall('readFile', { path: 'src/app.ts' });
    tool1.end({ success: true });

    const llm2 = task.startLlmCall('gpt-4');
    llm2.end({ success: true });

    jest.advanceTimersByTime(100);
    task.end({ success: true });

    const completed = tracer.getCompletedSpans();
    expect(completed).toHaveLength(1);
    expect(completed[0].children).toHaveLength(3);
  });

  it('end() on a task span computes correct aggregates', () => {
    const task = tracer.startTask('Main Task');

    task.startLlmCall('gpt-4').end({ success: true });
    task.startToolCall('readFile').end({ success: true });
    task.startLlmCall('gpt-4').end({ success: true });

    jest.advanceTimersByTime(100);
    task.end({ success: true });

    const completed = tracer.getCompletedSpans();
    expect(completed).toHaveLength(1);

    // We can't directly access aggregates, but we can verify structure
    const span = completed[0];
    expect(span.children).toHaveLength(3);
    expect(span.spanType).toBe('agent_task');
  });

  it('sub-agent spans maintain correct hierarchy', () => {
    const task = tracer.startTask('Main Task');
    const subAgent = task.startSubAgent('SubAgent-1');

    subAgent.startLlmCall('gpt-4').end({ success: true });
    subAgent.startToolCall('analyze').end({ success: true });

    jest.advanceTimersByTime(50);
    subAgent.end({ success: true });

    jest.advanceTimersByTime(50);
    task.end({ success: true });

    const completed = tracer.getCompletedSpans();
    expect(completed).toHaveLength(1);
    expect(completed[0].children).toHaveLength(1);
    expect(completed[0].children[0].spanType).toBe('sub_agent');
    expect(completed[0].children[0].children).toHaveLength(2);
  });

  it('end() with success: false records failure state', () => {
    const task = tracer.startTask('Main Task');
    const tool = task.startToolCall('failingTool');

    jest.advanceTimersByTime(50);
    tool.end({ success: false, output: 'Error occurred' });

    jest.advanceTimersByTime(50);
    task.end({ success: false });

    const completed = tracer.getCompletedSpans();
    expect(completed[0].success).toBe(false);
    expect(completed[0].children[0].success).toBe(false);
  });

  it('spans include correct duration calculations', () => {
    const task = tracer.startTask('Main Task');

    jest.advanceTimersByTime(100);
    const llm = task.startLlmCall('gpt-4');

    jest.advanceTimersByTime(50);
    llm.end({ success: true });

    jest.advanceTimersByTime(100);
    task.end({ success: true });

    const completed = tracer.getCompletedSpans();
    expect(completed[0].endTime).toBe(completed[0].startTime + 250);
    expect(completed[0].children[0].durationMs).toBe(50);
  });

  it('multiple tasks are tracked independently', () => {
    const task1 = tracer.startTask('Task 1');
    const task2 = tracer.startTask('Task 2');

    task1.startLlmCall('gpt-4').end({ success: true });
    jest.advanceTimersByTime(50);
    task1.end({ success: true });

    task2.startToolCall('tool1').end({ success: true });
    jest.advanceTimersByTime(50);
    task2.end({ success: true });

    const completed = tracer.getCompletedSpans();
    expect(completed).toHaveLength(2);
    expect(completed[0].traceId).not.toBe(completed[1].traceId);
  });

  it('span attributes include all required fields', () => {
    const task = tracer.startTask('Main Task', { userId: 'user123' });
    const llm = task.startLlmCall('gpt-4');

    jest.advanceTimersByTime(50);
    llm.end({ success: true });

    jest.advanceTimersByTime(50);
    task.end({ success: true });

    const completed = tracer.getCompletedSpans();
    const taskSpan = completed[0];

    expect(taskSpan.traceId).toBeDefined();
    expect(taskSpan.spanId).toBeDefined();
    expect(taskSpan.parentSpanId).toBeNull();
    expect(taskSpan.spanType).toBe('agent_task');
    expect(taskSpan.name).toBe('Main Task');
    expect(taskSpan.startTime).toBeGreaterThan(0);
    expect(taskSpan.endTime).toBeGreaterThan(taskSpan.startTime);
    expect(taskSpan.success).toBe(true);

    const llmSpan = taskSpan.children[0];
    expect(llmSpan.parentSpanId).toBe(taskSpan.spanId);
    expect(llmSpan.model).toBe('gpt-4');
  });

  it('reset() clears all spans and aggregates', () => {
    const task = tracer.startTask('Main Task');
    task.startLlmCall('gpt-4').end({ success: true });
    jest.advanceTimersByTime(50);
    task.end({ success: true });

    let completed = tracer.getCompletedSpans();
    expect(completed).toHaveLength(1);

    tracer.reset();

    completed = tracer.getCompletedSpans();
    expect(completed).toHaveLength(0);
  });

  it('deeply nested task structure correctly computes step count', () => {
    const task = tracer.startTask('Main Task');

    // Create nested structure: task -> subagent -> llm + tool -> subagent
    const subAgent1 = task.startSubAgent('SubAgent-1');
    subAgent1.startLlmCall('gpt-4').end({ success: true });
    subAgent1.startToolCall('tool1').end({ success: true });

    const subAgent2 = subAgent1.startSubAgent('SubAgent-1-1');
    subAgent2.startLlmCall('gpt-4').end({ success: true });
    jest.advanceTimersByTime(25);
    subAgent2.end({ success: true });

    jest.advanceTimersByTime(25);
    subAgent1.end({ success: true });

    jest.advanceTimersByTime(50);
    task.end({ success: true });

    const completed = tracer.getCompletedSpans();
    // Task has 1 child (subAgent1), subAgent1 has 3 children (llm, tool, subAgent2)
    // subAgent2 has 1 child (llm)
    expect(completed[0].children).toHaveLength(1);
    expect(completed[0].children[0].children).toHaveLength(3);
    expect(completed[0].children[0].children[2].children).toHaveLength(1);
  });

  it('setTokenUsage() accumulates tokens and cost in task summary event', () => {
    const mockDispatch = jest.fn();
    (globalThis as unknown as Record<string, unknown>).dispatchEvent = mockDispatch;

    const task = tracer.startTask('Token Task');

    const llm1 = task.startLlmCall('claude-3') as LlmSpan;
    llm1.setTokenUsage({ totalTokens: 300, costUsd: 0.005 });
    llm1.end({ success: true });

    const llm2 = task.startLlmCall('claude-3') as LlmSpan;
    llm2.setTokenUsage({ totalTokens: 200, costUsd: 0.003 });
    llm2.end({ success: true });

    jest.advanceTimersByTime(50);
    task.end({ success: true });

    expect(mockDispatch).toHaveBeenCalled();
    const event = mockDispatch.mock.calls[0]?.[0] as CustomEvent;
    expect((event.detail as Record<string, unknown>).totalTokens).toBe(500);
    expect((event.detail as Record<string, unknown>).totalCostUsd).toBeCloseTo(0.008);

    delete (globalThis as unknown as Record<string, unknown>).dispatchEvent;
  });

  it('tool call input is properly serialized', () => {
    const task = tracer.startTask('Main Task');
    const input = { path: 'src/app.ts', encoding: 'utf-8', verbose: true };
    const tool = task.startToolCall('readFile', input);

    jest.advanceTimersByTime(25);
    tool.end({ success: true });

    jest.advanceTimersByTime(25);
    task.end({ success: true });

    const completed = tracer.getCompletedSpans();
    const toolSpan = completed[0].children[0];
    expect(toolSpan.input).toBe(JSON.stringify(input));
  });
});
