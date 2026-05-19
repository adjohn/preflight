import type { SpanData } from './tracer.js';

export interface PerTaskMetrics {
  readonly taskDurationMs: number;
  readonly totalSteps: number;
  readonly llmCallsPerTask: number;
  readonly toolCallsPerTask: number;
  readonly tokensPerTask: number;
  readonly costPerTaskUsd: number;
  readonly toolCallChainDepth: number;
  readonly success: boolean;
}

export interface TaskAggregateStats {
  readonly completedTaskCount: number;
  readonly avgCostPerTask: number;
  readonly p95CostPerTask: number;
  readonly avgStepsPerTask: number;
  readonly avgDurationMs: number;
  readonly completionRate: number;
  readonly avgToolCallsPerTask: number;
  readonly avgLlmCallsPerTask: number;
}

export class TaskMetricsCalculator {
  static computePerTaskMetrics(spanData: SpanData, tokenCosts?: Map<string, { inputCost: number; outputCost: number }>): PerTaskMetrics {
    let llmCallCount = 0;
    let toolCallCount = 0;
    let totalTokens = 0;
    let totalCostUsd = 0;
    let maxDepth = 1;

    const walkSpans = (span: SpanData, currentDepth: number = 0): void => {
      if (span.spanType === 'llm_call') {
        llmCallCount += 1;
        totalTokens += span.totalTokens ?? 0;
        const modelCost = span.model && tokenCosts?.get(span.model);
        totalCostUsd += span.costUsd ?? (modelCost ? modelCost.inputCost + modelCost.outputCost : 0);
      } else if (span.spanType === 'tool_call') {
        toolCallCount += 1;
      }

      if (span.children.length > 0) {
        maxDepth = Math.max(maxDepth, currentDepth + 1);
        span.children.forEach((child) => walkSpans(child, currentDepth + 1));
      }
    };

    spanData.children.forEach((child) => walkSpans(child, 1));

    const totalSteps = llmCallCount + toolCallCount;
    const durationMs = (spanData.endTime || Date.now()) - spanData.startTime;

    return {
      taskDurationMs: durationMs,
      totalSteps,
      llmCallsPerTask: llmCallCount,
      toolCallsPerTask: toolCallCount,
      tokensPerTask: totalTokens,
      costPerTaskUsd: totalCostUsd,
      toolCallChainDepth: maxDepth,
      success: spanData.success ?? true,
    };
  }
}

export class TaskMetricsAggregator {
  private taskMetrics: PerTaskMetrics[] = [];
  private readonly windowSize: number = 100;
  private spinningWheelsCount: number = 0;

  recordSpinningWheels(): void {
    this.spinningWheelsCount++;
  }

  getSpinningWheelsRate(): number {
    return this.taskMetrics.length > 0 ? this.spinningWheelsCount / this.taskMetrics.length : 0;
  }

  recordTaskMetrics(metrics: PerTaskMetrics): void {
    this.taskMetrics.push(metrics);

    if (this.taskMetrics.length > this.windowSize) {
      this.taskMetrics = this.taskMetrics.slice(-this.windowSize);
    }
  }

  getAggregateStats(): TaskAggregateStats {
    if (this.taskMetrics.length === 0) {
      return {
        completedTaskCount: 0,
        avgCostPerTask: 0,
        p95CostPerTask: 0,
        avgStepsPerTask: 0,
        avgDurationMs: 0,
        completionRate: 0,
        avgToolCallsPerTask: 0,
        avgLlmCallsPerTask: 0,
      };
    }

    const costs = this.taskMetrics.map((m) => m.costPerTaskUsd).sort((a, b) => a - b);
    const costIndex = Math.floor(this.taskMetrics.length * 0.95);
    const p95Cost = costs[Math.min(costIndex, costs.length - 1)] ?? 0;

    const avgCost = this.taskMetrics.reduce((sum, m) => sum + m.costPerTaskUsd, 0) / this.taskMetrics.length;
    const avgSteps = this.taskMetrics.reduce((sum, m) => sum + m.totalSteps, 0) / this.taskMetrics.length;
    const avgDuration = this.taskMetrics.reduce((sum, m) => sum + m.taskDurationMs, 0) / this.taskMetrics.length;
    const completionRate = this.taskMetrics.filter((m) => m.success).length / this.taskMetrics.length;
    const avgToolCalls = this.taskMetrics.reduce((sum, m) => sum + m.toolCallsPerTask, 0) / this.taskMetrics.length;
    const avgLlmCalls = this.taskMetrics.reduce((sum, m) => sum + m.llmCallsPerTask, 0) / this.taskMetrics.length;

    return {
      completedTaskCount: this.taskMetrics.length,
      avgCostPerTask: Math.round(avgCost * 10000) / 10000,
      p95CostPerTask: Math.round(p95Cost * 10000) / 10000,
      avgStepsPerTask: Math.round(avgSteps * 100) / 100,
      avgDurationMs: Math.round(avgDuration),
      completionRate: Math.round(completionRate * 10000) / 10000,
      avgToolCallsPerTask: Math.round(avgToolCalls * 100) / 100,
      avgLlmCallsPerTask: Math.round(avgLlmCalls * 100) / 100,
    };
  }

  reset(): void {
    this.taskMetrics = [];
    this.spinningWheelsCount = 0;
  }

  getTaskCount(): number {
    return this.taskMetrics.length;
  }

  getMetrics(): PerTaskMetrics[] {
    return [...this.taskMetrics];
  }
}
