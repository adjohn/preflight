import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SpanType, AiAgentTaskSummary } from '@nr-ai-observatory/shared';

interface SubAgentTimingTracker {
  recordChildSpanTiming(parentSpanId: string, childSpan: SpanData): void;
  recordChildSpanEnd(parentSpanId: string, childSpan: SpanData): void;
}

export interface SpanContext {
  readonly traceId: string;
  readonly spanId: string;
}

export interface SpanResult {
  readonly success: boolean;
  readonly output?: string;
}

export interface SpanData {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly spanType: SpanType;
  readonly name: string;
  readonly startTime: number;
  endTime: number | null;
  durationMs: number | null;
  readonly customAttributes: Record<string, string | number>;
  readonly model?: string;
  readonly toolName?: string;
  readonly input?: string;
  success: boolean | null;
  output?: string;
  readonly children: SpanData[];
  totalTokens?: number;
  costUsd?: number;
}

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly spanType: SpanType;
  end(result?: SpanResult): void;
}

export interface LlmSpan extends Span {
  setTokenUsage(usage: { inputTokens?: number; outputTokens?: number; thinkingTokens?: number; totalTokens?: number; costUsd?: number }): void;
}

export interface TaskSpan extends Span {
  startLlmCall(model: string): LlmSpan;
  startToolCall(toolName: string, input?: Record<string, unknown>): Span;
  startSubAgent(name: string): TaskSpan;
}

export interface TaskAggregates {
  readonly totalDurationMs: number;
  readonly totalLlmCalls: number;
  readonly totalToolCalls: number;
  readonly totalTokens: number;
  readonly totalCostUsd: number;
  readonly stepCount: number;
  readonly success: boolean;
}

const spanContextStorage = new AsyncLocalStorage<SpanContext>();

export class AgenticTracer {
  private spans: Map<string, SpanData> = new Map();
  private completedSpans: SpanData[] = [];
  private aggregates: Map<string, TaskAggregates> = new Map();
  private subAgentTimingTracker: SubAgentTimingTracker | null = null;

  setSubAgentTracker(tracker: SubAgentTimingTracker): void {
    this.subAgentTimingTracker = tracker;
  }

  startTask(name: string, metadata?: Record<string, string>): TaskSpan {
    const traceId = randomUUID();
    const spanId = randomUUID();

    const spanData: SpanData = {
      traceId,
      spanId,
      parentSpanId: null,
      spanType: 'agent_task',
      name,
      startTime: Date.now(),
      endTime: null,
      durationMs: null,
      customAttributes: metadata || {},
      children: [],
      success: null,
    };

    this.spans.set(spanId, spanData);

    spanContextStorage.enterWith({ traceId, spanId });

    return this.createTaskSpan(spanData);
  }

  private createTaskSpan(spanData: SpanData): TaskSpan {
    return {
      traceId: spanData.traceId,
      spanId: spanData.spanId,
      spanType: spanData.spanType,

      startLlmCall: (model: string): LlmSpan => {
        return this.createLlmChildSpan(spanData, model);
      },

      startToolCall: (toolName: string, input?: Record<string, unknown>): Span => {
        return this.createChildSpan(spanData, 'tool_call', `Tool: ${toolName}`, {
          toolName,
          input: input ? JSON.stringify(input) : undefined,
        });
      },

      startSubAgent: (subAgentName: string): TaskSpan => {
        const subSpanData = this.createChildSpanData(spanData, 'sub_agent', subAgentName);
        return this.createTaskSpan(subSpanData);
      },

      end: (result?: SpanResult): void => {
        this.endSpan(spanData, result);
      },
    };
  }

  private createLlmChildSpan(parentSpan: SpanData, model: string): LlmSpan {
    const spanId = randomUUID();

    const childSpan: SpanData = {
      traceId: parentSpan.traceId,
      spanId,
      parentSpanId: parentSpan.spanId,
      spanType: 'llm_call',
      name: `LLM: ${model}`,
      startTime: Date.now(),
      endTime: null,
      durationMs: null,
      customAttributes: {},
      model,
      children: [],
      success: null,
    };

    this.spans.set(spanId, childSpan);
    parentSpan.children.push(childSpan);

    return {
      traceId: childSpan.traceId,
      spanId: childSpan.spanId,
      spanType: childSpan.spanType,
      setTokenUsage: (usage): void => {
        if (usage.totalTokens !== undefined) childSpan.totalTokens = usage.totalTokens;
        if (usage.costUsd !== undefined) childSpan.costUsd = usage.costUsd;
      },
      end: (result?: SpanResult): void => {
        this.endSpan(childSpan, result);
      },
    };
  }

  private createChildSpan(parentSpan: SpanData, spanType: SpanType, name: string, attrs: Record<string, unknown>): Span {
    const spanId = randomUUID();

    const childSpan: SpanData = {
      traceId: parentSpan.traceId,
      spanId,
      parentSpanId: parentSpan.spanId,
      spanType,
      name,
      startTime: Date.now(),
      endTime: null,
      durationMs: null,
      customAttributes: {},
      model: attrs.model as string | undefined,
      toolName: attrs.toolName as string | undefined,
      input: attrs.input as string | undefined,
      children: [],
      success: null,
    };

    this.spans.set(spanId, childSpan);
    parentSpan.children.push(childSpan);

    return {
      traceId: childSpan.traceId,
      spanId: childSpan.spanId,
      spanType: childSpan.spanType,
      end: (result?: SpanResult): void => {
        this.endSpan(childSpan, result);
      },
    };
  }

  private createChildSpanData(parentSpan: SpanData, spanType: SpanType, name: string): SpanData {
    const spanId = randomUUID();

    const childSpan: SpanData = {
      traceId: parentSpan.traceId,
      spanId,
      parentSpanId: parentSpan.spanId,
      spanType,
      name,
      startTime: Date.now(),
      endTime: null,
      durationMs: null,
      customAttributes: {},
      children: [],
      success: null,
    };

    this.spans.set(spanId, childSpan);
    parentSpan.children.push(childSpan);

    if (spanType === 'sub_agent' && this.subAgentTimingTracker) {
      this.subAgentTimingTracker.recordChildSpanTiming(parentSpan.spanId, childSpan);
    }

    return childSpan;
  }

  private endSpan(spanData: SpanData, result?: SpanResult): void {
    spanData.endTime = Date.now();
    spanData.durationMs = spanData.endTime - spanData.startTime;
    if (result) {
      spanData.success = result.success;
      spanData.output = result.output;
    }

    if (spanData.spanType === 'sub_agent' && spanData.parentSpanId && this.subAgentTimingTracker) {
      this.subAgentTimingTracker.recordChildSpanEnd(spanData.parentSpanId, spanData);
    }

    if (spanData.spanType === 'agent_task') {
      this.computeTaskAggregates(spanData);
      this.completedSpans.push(spanData);
      this.spans.delete(spanData.spanId);

      const aggregates = this.aggregates.get(spanData.spanId);
      if (aggregates) {
        this.emitTaskSummaryEvent(spanData, aggregates);
      }
    }
  }

  private computeTaskAggregates(taskSpan: SpanData): void {
    const startTime = taskSpan.startTime;
    const endTime = taskSpan.endTime || Date.now();
    const totalDurationMs = endTime - startTime;

    let totalLlmCalls = 0;
    let totalToolCalls = 0;
    let totalTokens = 0;
    let totalCostUsd = 0;
    let stepCount = 0;

    const walkChildren = (span: SpanData): void => {
      if (span.spanType === 'llm_call') {
        totalLlmCalls += 1;
        totalTokens += span.totalTokens ?? 0;
        totalCostUsd += span.costUsd ?? 0;
      } else if (span.spanType === 'tool_call') {
        totalToolCalls += 1;
      }
      stepCount += 1;
      span.children.forEach(walkChildren);
    };

    taskSpan.children.forEach(walkChildren);

    const aggregates: TaskAggregates = {
      totalDurationMs,
      totalLlmCalls,
      totalToolCalls,
      totalTokens,
      totalCostUsd,
      stepCount,
      success: taskSpan.success !== false,
    };

    this.aggregates.set(taskSpan.spanId, aggregates);
  }

  private emitTaskSummaryEvent(taskSpan: SpanData, aggregates: TaskAggregates): void {
    const event: AiAgentTaskSummary = {
      id: randomUUID(),
      timestamp: Date.now(),
      traceId: taskSpan.traceId,
      spanId: taskSpan.spanId,
      taskName: taskSpan.name,
      durationMs: aggregates.totalDurationMs,
      totalLlmCalls: aggregates.totalLlmCalls,
      totalToolCalls: aggregates.totalToolCalls,
      totalTokens: aggregates.totalTokens,
      totalCostUsd: aggregates.totalCostUsd,
      stepCount: aggregates.stepCount,
      success: aggregates.success,
      'nr.appName': 'nr-ai-agent',
      customAttributes: taskSpan.customAttributes,
    };

    // Event will be sent to the event buffer by the agent
    globalThis.dispatchEvent?.(
      new CustomEvent('ai-agent-task-summary', {
        detail: event,
      })
    );
  }

  getSpan(spanId: string): SpanData | undefined {
    return this.spans.get(spanId);
  }

  getCompletedSpans(): SpanData[] {
    return [...this.completedSpans];
  }

  getActiveTraceContext(): SpanContext | undefined {
    return spanContextStorage.getStore();
  }

  reset(): void {
    this.spans.clear();
    this.completedSpans = [];
    this.aggregates.clear();
  }
}

export function getSpanContext(): SpanContext | undefined {
  return spanContextStorage.getStore();
}
