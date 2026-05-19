import type { AgenticTracer, TaskSpan, Span } from '../agentic/tracer.js';
import type { IntegrationOptions } from './registry.js';

export interface VercelAiTelemetryOptions extends IntegrationOptions {
  tracer?: AgenticTracer;
  captureStreamingMetrics?: boolean;
}

export interface GenerateTextEvent {
  type: 'generateText' | 'streamText';
  model: string;
  input: Record<string, unknown>;
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
  }>;
  finishTime: number;
  output?: Record<string, unknown>;
  error?: string;
  ttft?: number;
  [key: string]: unknown;
}

export class VercelAiTelemetryHandler {
  private options: VercelAiTelemetryOptions;
  private events: GenerateTextEvent[] = [];
  private activeGeneration: Record<string, unknown> | null = null;
  private currentTaskSpan: TaskSpan | null = null;
  private currentLlmSpan: Span | null = null;

  constructor(options?: VercelAiTelemetryOptions) {
    this.options = options || { captureStreamingMetrics: true };
  }

  onGenerateStart(input: Record<string, unknown>, model: string): void {
    this.activeGeneration = {
      type: 'generateText',
      model,
      input,
      startTime: Date.now(),
      toolCalls: [],
    };
    if (this.options.tracer) {
      this.currentTaskSpan = this.options.tracer.startTask(`generate:${model}`);
      this.currentLlmSpan = this.currentTaskSpan.startLlmCall(model);
    }
  }

  onGenerateEnd(output: Record<string, unknown>): void {
    if (this.activeGeneration) {
      (this.activeGeneration as Record<string, unknown>).output = output;
      (this.activeGeneration as Record<string, unknown>).finishTime = Date.now();
      this.events.push(this.activeGeneration as unknown as GenerateTextEvent);
      this.activeGeneration = null;
    }
    if (this.currentLlmSpan) {
      this.currentLlmSpan.end({ success: true });
      this.currentLlmSpan = null;
    }
    if (this.currentTaskSpan) {
      this.currentTaskSpan.end({ success: true });
      this.currentTaskSpan = null;
    }
  }

  onStreamStart(input: Record<string, unknown>, model: string): void {
    this.activeGeneration = {
      type: 'streamText',
      model,
      input,
      startTime: Date.now(),
      firstTokenTime: null,
      toolCalls: [],
    };
    if (this.options.tracer) {
      this.currentTaskSpan = this.options.tracer.startTask(`stream:${model}`);
      this.currentLlmSpan = this.currentTaskSpan.startLlmCall(model);
    }
  }

  onStreamFirstToken(): void {
    if (this.activeGeneration) {
      (this.activeGeneration as Record<string, unknown>).firstTokenTime = Date.now();
      (this.activeGeneration as Record<string, unknown>).ttft =
        ((this.activeGeneration as Record<string, unknown>).firstTokenTime as number) -
        ((this.activeGeneration as Record<string, unknown>).startTime as number);
    }
  }

  onStreamEnd(output: Record<string, unknown>): void {
    if (this.activeGeneration) {
      (this.activeGeneration as Record<string, unknown>).output = output;
      (this.activeGeneration as Record<string, unknown>).finishTime = Date.now();
      this.events.push(this.activeGeneration as unknown as GenerateTextEvent);
      this.activeGeneration = null;
    }
    if (this.currentLlmSpan) {
      this.currentLlmSpan.end({ success: true });
      this.currentLlmSpan = null;
    }
    if (this.currentTaskSpan) {
      this.currentTaskSpan.end({ success: true });
      this.currentTaskSpan = null;
    }
  }

  onToolCall(toolName: string, args: Record<string, unknown>): void {
    if (this.activeGeneration) {
      const toolCalls = (this.activeGeneration as Record<string, unknown>).toolCalls as Array<{
        name: string;
        args: Record<string, unknown>;
      }>;
      toolCalls.push({ name: toolName, args });
    }
    if (this.currentTaskSpan) {
      this.currentTaskSpan.startToolCall(toolName, args).end({ success: true });
    }
  }

  onError(error: Error): void {
    if (this.activeGeneration) {
      (this.activeGeneration as Record<string, unknown>).error = error.message;
      (this.activeGeneration as Record<string, unknown>).finishTime = Date.now();
      this.events.push(this.activeGeneration as unknown as GenerateTextEvent);
      this.activeGeneration = null;
    }
    if (this.currentLlmSpan) {
      this.currentLlmSpan.end({ success: false });
      this.currentLlmSpan = null;
    }
    if (this.currentTaskSpan) {
      this.currentTaskSpan.end({ success: false });
      this.currentTaskSpan = null;
    }
  }

  getEvents(): GenerateTextEvent[] {
    return [...this.events];
  }

  clearEvents(): void {
    this.events = [];
    this.activeGeneration = null;
    if (this.currentTaskSpan) {
      this.currentTaskSpan.end({ success: false });
      this.currentTaskSpan = null;
    }
    this.currentLlmSpan = null;
  }
}

export function createTelemetryHandler(options?: VercelAiTelemetryOptions): VercelAiTelemetryHandler {
  return new VercelAiTelemetryHandler(options);
}

export async function initializeVercelAiIntegration(_options?: VercelAiTelemetryOptions): Promise<void> {
  (globalThis as unknown as Record<string, unknown>).VercelAiTelemetryHandler = VercelAiTelemetryHandler;
  (globalThis as unknown as Record<string, unknown>).createTelemetryHandler = createTelemetryHandler;
}
