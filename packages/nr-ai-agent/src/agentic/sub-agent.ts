import { randomUUID } from 'node:crypto';
import type { AiAgentMessage } from '@nr-ai-observatory/shared';
import type { SpanData, TaskSpan } from './tracer.js';
import { AgenticTracer } from './tracer.js';

export interface SubAgentMetrics {
  readonly delegationCount: number;
  readonly spawnCount: number;
  readonly delegationDepth: number;
  readonly interAgentMessages: number;
  readonly delegationOverheadMs: number;
}

interface SubAgentTrackingData {
  delegationCount: number;
  spawnCount: number;
  delegationDepth: number;
  interAgentMessages: number;
  childStartTimes: number[];
  childEndTimes: number[];
  spanDataRef: SpanData | undefined;
}

const subAgentTrackingMap = new Map<string, SubAgentTrackingData>();

export type SpawnedTaskSpan = TaskSpan & { _spawnIndex: number; _spawnTotal: number };

export interface TaskSpanWithSubAgent extends TaskSpan {
  delegate(agentName: string, taskDescription: string): TaskSpan;
  spawn(agents: Array<{ name: string; task: string }>): TaskSpan[];
  recordAgentMessage(from: string, to: string, messageType: string, tokenCount?: number): void;
}

export class SubAgentTracker {
  constructor(private tracer: AgenticTracer) {}

  wrapTaskSpan(taskSpan: TaskSpan, spanData: SpanData): TaskSpanWithSubAgent {
    return {
      ...taskSpan,

      delegate: (agentName: string, _taskDescription: string): TaskSpan => {
        const delegatedSpan = taskSpan.startSubAgent(agentName);

        // Track delegation
        const tracking = this.getOrCreateTracking(spanData.spanId, spanData);
        tracking.delegationCount += 1;
        tracking.interAgentMessages += 1;
        tracking.delegationDepth = this.calculateDelegationDepth(spanData);

        // Emit delegation message
        this.emitAgentMessage(spanData.traceId, spanData.name, agentName, 'task_assignment');

        return delegatedSpan;
      },

      spawn: (agents: Array<{ name: string; task: string }>): TaskSpan[] => {
        const tracking = this.getOrCreateTracking(spanData.spanId, spanData);
        tracking.spawnCount += agents.length;
        tracking.interAgentMessages += agents.length;

        return agents.map((agent, index) => {
          const spawnedSpan = taskSpan.startSubAgent(agent.name) as unknown as SpawnedTaskSpan;
          spawnedSpan._spawnIndex = index;
          spawnedSpan._spawnTotal = agents.length;

          // Emit spawn assignment
          this.emitAgentMessage(spanData.traceId, spanData.name, agent.name, 'task_assignment');

          return spawnedSpan;
        });
      },

      recordAgentMessage: (from: string, to: string, messageType: string, tokenCount?: number): void => {
        const tracking = this.getOrCreateTracking(spanData.spanId, spanData);
        tracking.interAgentMessages += 1;
        this.emitAgentMessage(spanData.traceId, from, to, messageType, tokenCount);
      },
    };
  }

  recordChildSpanTiming(parentSpanId: string, childSpan: SpanData): void {
    const tracking = this.getOrCreateTracking(parentSpanId);
    tracking.childStartTimes.push(childSpan.startTime);
  }

  recordChildSpanEnd(parentSpanId: string, childSpan: SpanData): void {
    const tracking = this.getOrCreateTracking(parentSpanId);
    tracking.childEndTimes.push(childSpan.endTime || Date.now());
  }

  calculateDelegationOverhead(parentSpan: SpanData): number {
    const tracking = subAgentTrackingMap.get(parentSpan.spanId);
    if (!tracking || tracking.childStartTimes.length === 0) {
      return 0;
    }

    const parentStart = parentSpan.startTime;
    const parentEnd = parentSpan.endTime || Date.now();
    const parentDuration = parentEnd - parentStart;

    const childStart = Math.min(...tracking.childStartTimes);
    const childEnd = Math.max(...tracking.childEndTimes);
    const childDuration = childEnd - childStart;

    const overheadMs = parentDuration - childDuration;
    return Math.max(0, overheadMs);
  }

  getMetrics(spanId: string): SubAgentMetrics {
    const tracking = subAgentTrackingMap.get(spanId);
    if (!tracking) {
      return {
        delegationCount: 0,
        spawnCount: 0,
        delegationDepth: 0,
        interAgentMessages: 0,
        delegationOverheadMs: 0,
      };
    }

    return {
      delegationCount: tracking.delegationCount,
      spawnCount: tracking.spawnCount,
      delegationDepth: tracking.delegationDepth,
      interAgentMessages: tracking.interAgentMessages,
      delegationOverheadMs: tracking.spanDataRef
        ? this.calculateDelegationOverhead(tracking.spanDataRef)
        : 0,
    };
  }

  private calculateDelegationDepth(parentSpan: SpanData): number {
    let depth = 0;
    let current: SpanData | null = parentSpan;

    while (current) {
      if (current.spanType === 'sub_agent') {
        depth += 1;
      }
      current = current.parentSpanId ? (this.tracer.getSpan(current.parentSpanId) ?? null) : null;
    }

    return depth;
  }

  private getOrCreateTracking(spanId: string, spanData?: SpanData): SubAgentTrackingData {
    if (!subAgentTrackingMap.has(spanId)) {
      subAgentTrackingMap.set(spanId, {
        delegationCount: 0,
        spawnCount: 0,
        delegationDepth: 0,
        interAgentMessages: 0,
        childStartTimes: [],
        childEndTimes: [],
        spanDataRef: spanData,
      });
    } else if (spanData) {
      subAgentTrackingMap.get(spanId)!.spanDataRef = spanData;
    }

    return subAgentTrackingMap.get(spanId)!;
  }

  private emitAgentMessage(
    traceId: string,
    fromAgent: string,
    toAgent: string,
    messageType: string,
    tokenCount?: number
  ): void {
    const event: AiAgentMessage = {
      id: randomUUID(),
      timestamp: Date.now(),
      traceId,
      fromAgent,
      toAgent,
      messageType,
      tokenCount,
      'nr.appName': 'nr-ai-agent',
      customAttributes: {},
    };

    globalThis.dispatchEvent?.(
      new CustomEvent('ai-agent-message', {
        detail: event,
      })
    );
  }

  reset(): void {
    subAgentTrackingMap.clear();
  }
}
