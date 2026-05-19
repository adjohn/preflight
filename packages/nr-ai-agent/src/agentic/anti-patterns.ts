import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { AiAntiPattern } from '@nr-ai-observatory/shared';
import type { SpanData } from './tracer.js';

export interface AntiPatternDetectorOptions {
  spinThreshold?: number;
  bailOutThreshold?: number;
  contextLimitTokens?: number;
  contextPressure?: number;
}

export interface AntiPattern {
  readonly type: string;
  readonly severity: 'low' | 'medium' | 'high';
  readonly description: string;
  readonly details: Record<string, unknown>;
}

export class AntiPatternDetector {
  private spinThreshold: number = 3;
  private bailOutThreshold: number = 2;
  private contextLimitTokens: number = 128000;
  private contextPressureThreshold: number = 0.8;
  private tokenExplosionThreshold: number = 0.5;
  private overthinkingDepthThreshold: number = 0.9;
  private underthinkingDepthThreshold: number = 0.2;

  constructor(options?: AntiPatternDetectorOptions) {
    if (options?.spinThreshold !== undefined) {
      this.spinThreshold = options.spinThreshold;
    }
    if (options?.bailOutThreshold !== undefined) {
      this.bailOutThreshold = options.bailOutThreshold;
    }
    if (options?.contextLimitTokens !== undefined) {
      this.contextLimitTokens = options.contextLimitTokens;
    }
  }

  analyze(spanData: SpanData, additionalContext?: {
    contextPressure?: number;
    inputTokens?: number;
    outputTokens?: number;
    reasoningDepth?: number;
    stopReason?: string;
    responseText?: string;
  }): AntiPattern[] {
    const patterns: AntiPattern[] = [];

    patterns.push(...this.detectSpinningWheels(spanData));
    patterns.push(...this.detectOverthinking(spanData, additionalContext?.reasoningDepth));
    patterns.push(...this.detectUnderthinking(spanData, additionalContext?.reasoningDepth));
    patterns.push(...this.detectContextStuffing(additionalContext?.contextPressure));
    patterns.push(...this.detectTokenExplosion(additionalContext?.inputTokens, additionalContext?.outputTokens));
    patterns.push(...this.detectBailOut(spanData, additionalContext?.stopReason, additionalContext?.responseText));

    return patterns;
  }

  private detectSpinningWheels(spanData: SpanData): AntiPattern[] {
    const toolCallHashes = new Map<string, number>();

    const walkSpans = (span: SpanData): void => {
      if (span.spanType === 'tool_call' && span.toolName) {
        const key = `${span.toolName}:${span.input || ''}`;
        const hash = createHash('sha256').update(key).digest('hex');
        toolCallHashes.set(hash, (toolCallHashes.get(hash) || 0) + 1);
      }
      span.children.forEach(walkSpans);
    };

    spanData.children.forEach(walkSpans);

    const patterns: AntiPattern[] = [];
    for (const [, count] of toolCallHashes) {
      if (count > this.spinThreshold) {
        patterns.push({
          type: 'spinning_wheels',
          severity: 'high',
          description: `Tool called ${count} times with identical or similar inputs (threshold: ${this.spinThreshold})`,
          details: { repeatCount: count, threshold: this.spinThreshold },
        });
        break;
      }
    }

    return patterns;
  }

  private detectOverthinking(spanData: SpanData, reasoningDepth?: number): AntiPattern[] {
    if (reasoningDepth === undefined || reasoningDepth <= this.overthinkingDepthThreshold) {
      return [];
    }

    let toolCount = 0;
    let estimatedOutputTokens = 0;

    const walkSpans = (span: SpanData): void => {
      if (span.spanType === 'tool_call') {
        toolCount += 1;
      }
      if (span.spanType === 'llm_call' && span.output) {
        estimatedOutputTokens += Math.ceil(span.output.length / 4);
      }
      span.children.forEach(walkSpans);
    };

    spanData.children.forEach(walkSpans);

    const isSimpleTask = toolCount < 3 || estimatedOutputTokens < 500;

    if (isSimpleTask) {
      return [
        {
          type: 'overthinking',
          severity: 'medium',
          description: `High reasoning depth (${(reasoningDepth * 100).toFixed(0)}%) on simple task (${toolCount} tools, ~${estimatedOutputTokens} tokens)`,
          details: { depthIndex: reasoningDepth, toolCount, estimatedTokens: estimatedOutputTokens, taskComplexity: 'simple' },
        },
      ];
    }

    return [];
  }

  private detectUnderthinking(spanData: SpanData, reasoningDepth?: number): AntiPattern[] {
    if (reasoningDepth === undefined || reasoningDepth >= this.underthinkingDepthThreshold) {
      return [];
    }

    let toolCount = 0;
    let estimatedOutputTokens = 0;

    const walkSpans = (span: SpanData): void => {
      if (span.spanType === 'tool_call') {
        toolCount += 1;
      }
      if (span.spanType === 'llm_call' && span.output) {
        estimatedOutputTokens += Math.ceil(span.output.length / 4);
      }
      span.children.forEach(walkSpans);
    };

    spanData.children.forEach(walkSpans);

    const isComplexTask = toolCount > 5 || estimatedOutputTokens > 2000;

    if (isComplexTask) {
      return [
        {
          type: 'underthinking',
          severity: 'medium',
          description: `Low reasoning depth (${(reasoningDepth * 100).toFixed(0)}%) on complex task (${toolCount} tools, ~${estimatedOutputTokens} tokens)`,
          details: { depthIndex: reasoningDepth, toolCount, estimatedTokens: estimatedOutputTokens, taskComplexity: 'complex' },
        },
      ];
    }

    return [];
  }

  private detectContextStuffing(contextPressure?: number): AntiPattern[] {
    if (contextPressure === undefined || contextPressure <= this.contextPressureThreshold) {
      return [];
    }

    return [
      {
        type: 'context_stuffing',
        severity: 'high',
        description: `Context window ${(contextPressure * 100).toFixed(0)}% full, leaving limited room for reasoning`,
        details: { contextPressure, threshold: this.contextPressureThreshold },
      },
    ];
  }

  private detectTokenExplosion(inputTokens?: number, outputTokens?: number): AntiPattern[] {
    if (inputTokens === undefined || outputTokens === undefined) {
      return [];
    }

    const totalTokens = inputTokens + outputTokens;
    const tokenShare = totalTokens / this.contextLimitTokens;

    if (tokenShare > this.tokenExplosionThreshold) {
      return [
        {
          type: 'token_explosion',
          severity: 'high',
          description: `Single turn consumed ${(tokenShare * 100).toFixed(0)}% of context window (${totalTokens} tokens)`,
          details: { inputTokens, outputTokens, totalTokens, tokenShare, threshold: this.tokenExplosionThreshold },
        },
      ];
    }

    return [];
  }

  private detectBailOut(spanData: SpanData, stopReason?: string, responseText?: string): AntiPattern[] {
    let toolCount = 0;

    const walkSpans = (span: SpanData): void => {
      if (span.spanType === 'tool_call') {
        toolCount += 1;
      }
      span.children.forEach(walkSpans);
    };

    spanData.children.forEach(walkSpans);

    if (toolCount < this.bailOutThreshold && stopReason === 'end_turn' && responseText) {
      const escalationPhrases = [
        "i can't",
        "unable to",
        "i don't have access",
        "i need your help",
        "can you help",
        "please help",
        "i apologize",
        "i'm unable",
      ];

      const hasEscalation = escalationPhrases.some((phrase) =>
        responseText.toLowerCase().includes(phrase)
      );

      if (hasEscalation) {
        return [
          {
            type: 'bail_out',
            severity: 'medium',
            description: `Agent gave up after ${toolCount} attempt(s) (threshold: ${this.bailOutThreshold})`,
            details: { attemptCount: toolCount, threshold: this.bailOutThreshold, stopReason },
          },
        ];
      }
    }

    return [];
  }
}

export function emitAntiPatternEvent(pattern: AntiPattern, traceId: string, appName: string = 'nr-ai-agent'): AiAntiPattern {
  const event: AiAntiPattern = {
    id: randomUUID(),
    timestamp: Date.now(),
    traceId,
    patternType: pattern.type as unknown as AiAntiPattern['patternType'],
    severity: pattern.severity,
    description: pattern.description,
    toolName: pattern.details.toolName as string | undefined,
    repeatCount: pattern.details.repeatCount as number | undefined,
    depthIndex: pattern.details.depthIndex as number | undefined,
    taskComplexity: pattern.details.taskComplexity as 'simple' | 'moderate' | 'complex' | undefined,
    contextPressure: pattern.details.contextPressure as number | undefined,
    tokenShare: pattern.details.tokenShare as number | undefined,
    attemptCount: pattern.details.attemptCount as number | undefined,
    'nr.appName': appName,
    customAttributes: {},
  };

  return event;
}
