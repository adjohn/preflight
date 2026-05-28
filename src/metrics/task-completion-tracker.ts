import type { AiCodingTask } from './task-detector.js';
import type { ToolCallRecord } from '../storage/types.js';

interface TaskSummary {
  readonly durationMs: number;
  readonly toolCallCount: number;
}

export interface TaskCompletionMetrics {
  readonly completedTasks: number;
  readonly avgTaskDurationMs: number | null;
  readonly avgToolCallsPerTask: number | null;
}

export class TaskCompletionTracker {
  private completed: TaskSummary[] = [];

  // No-op: this tracker is fed via recordTask() called by TaskDetector.
  // recordToolCall exists for compatibility with the standard tracker pattern.
  recordToolCall(_record: ToolCallRecord): void {}

  recordTask(task: AiCodingTask): void {
    this.completed.push({ durationMs: task.durationMs, toolCallCount: task.toolCallCount });
  }

  getMetrics(): TaskCompletionMetrics {
    const completedCount = this.completed.length;

    const avgTaskDurationMs =
      completedCount > 0
        ? this.completed.reduce((s, t) => s + t.durationMs, 0) / completedCount
        : null;

    const avgToolCallsPerTask =
      completedCount > 0
        ? this.completed.reduce((s, t) => s + t.toolCallCount, 0) / completedCount
        : null;

    return {
      completedTasks: completedCount,
      avgTaskDurationMs,
      avgToolCallsPerTask,
    };
  }

  reset(): void {
    this.completed = [];
  }
}
