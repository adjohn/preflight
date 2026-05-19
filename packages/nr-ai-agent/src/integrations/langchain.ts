import type { AgenticTracer, TaskSpan, Span } from '../agentic/tracer.js';
import type { IntegrationOptions } from './registry.js';

export interface LangChainCallbackOptions extends IntegrationOptions {
  tracer?: AgenticTracer;
  captureErrors?: boolean;
}

export class NrAiCallbackHandler {
  private options: LangChainCallbackOptions;
  private activeSpans: Map<string, unknown> = new Map();
  private currentTaskSpan: TaskSpan | null = null;
  private currentLlmSpan: Span | null = null;
  private currentToolSpan: Span | null = null;

  constructor(_options?: LangChainCallbackOptions) {
    this.options = _options || {};
  }

  async handleLLMStart(serialized: Record<string, unknown>, _prompts: string[]): Promise<void> {
    const llmName = typeof serialized.name === 'string' ? serialized.name : 'unknown';
    const spanId = `llm-${Date.now()}-${Math.random()}`;
    this.activeSpans.set(spanId, { type: 'llm_call', name: llmName, startTime: Date.now() });
    if (this.currentTaskSpan) {
      this.currentLlmSpan = this.currentTaskSpan.startLlmCall(llmName);
    }
  }

  async handleLLMEnd(_output: Record<string, unknown>): Promise<void> {
    const spans = Array.from(this.activeSpans.values()).filter((s: unknown) => {
      const span = s as Record<string, unknown>;
      return span.type === 'llm_call';
    });
    if (spans.length > 0) {
      const span = spans[spans.length - 1] as Record<string, unknown>;
      (span as Record<string, unknown>).endTime = Date.now();
    }
    if (this.currentLlmSpan) {
      this.currentLlmSpan.end({ success: true });
      this.currentLlmSpan = null;
    }
  }

  async handleLLMError(_err: Error): Promise<void> {
    const errorSpanId = `error-${Date.now()}-${Math.random()}`;
    this.activeSpans.set(errorSpanId, {
      type: 'error',
      error: _err.message,
      startTime: Date.now(),
      endTime: Date.now(),
    });
    if (this.currentLlmSpan) {
      this.currentLlmSpan.end({ success: false });
      this.currentLlmSpan = null;
    }
  }

  async handleChainStart(serialized: Record<string, unknown>, _inputs: Record<string, unknown>): Promise<void> {
    const chainName = typeof serialized.name === 'string' ? serialized.name : 'chain';
    const spanId = `chain-${Date.now()}-${Math.random()}`;
    this.activeSpans.set(spanId, { type: 'agent_task', name: chainName, startTime: Date.now() });
    if (this.options.tracer) {
      this.currentTaskSpan = this.options.tracer.startTask(chainName);
    }
  }

  async handleChainEnd(_outputs: Record<string, unknown>): Promise<void> {
    const spans = Array.from(this.activeSpans.values()).filter((s: unknown) => {
      const span = s as Record<string, unknown>;
      return span.type === 'agent_task';
    });
    if (spans.length > 0) {
      const span = spans[spans.length - 1] as Record<string, unknown>;
      (span as Record<string, unknown>).endTime = Date.now();
    }
    if (this.currentTaskSpan) {
      this.currentTaskSpan.end({ success: true });
      this.currentTaskSpan = null;
    }
  }

  async handleToolStart(serialized: Record<string, unknown>, toolInput: Record<string, unknown>): Promise<void> {
    const toolName = typeof serialized.name === 'string' ? serialized.name : 'unknown_tool';
    const spanId = `tool-${Date.now()}-${Math.random()}`;
    this.activeSpans.set(spanId, {
      type: 'tool_call',
      name: toolName,
      input: toolInput,
      startTime: Date.now(),
    });
    if (this.currentTaskSpan) {
      this.currentToolSpan = this.currentTaskSpan.startToolCall(toolName, toolInput);
    }
  }

  async handleToolEnd(toolOutput: unknown): Promise<void> {
    const spans = Array.from(this.activeSpans.values()).filter((s: unknown) => {
      const span = s as Record<string, unknown>;
      return span.type === 'tool_call';
    });
    if (spans.length > 0) {
      const span = spans[spans.length - 1] as Record<string, unknown>;
      (span as Record<string, unknown>).endTime = Date.now();
      (span as Record<string, unknown>).output = toolOutput;
    }
    if (this.currentToolSpan) {
      this.currentToolSpan.end({ success: true, output: String(toolOutput) });
      this.currentToolSpan = null;
    }
  }

  async handleRetrieverStart(serialized: Record<string, unknown>, query: string): Promise<void> {
    const spanId = `retriever-${Date.now()}-${Math.random()}`;
    this.activeSpans.set(spanId, {
      type: 'tool_call',
      name: 'retrieval',
      subType: 'retrieval',
      input: { query },
      startTime: Date.now(),
    });
    if (this.currentTaskSpan) {
      this.currentToolSpan = this.currentTaskSpan.startToolCall('retrieval', { query });
    }
  }

  async handleRetrieverEnd(documents: unknown[]): Promise<void> {
    const spans = Array.from(this.activeSpans.values()).filter((s: unknown) => {
      const span = s as Record<string, unknown>;
      return span.type === 'tool_call' && span.subType === 'retrieval';
    });
    if (spans.length > 0) {
      const span = spans[spans.length - 1] as Record<string, unknown>;
      (span as Record<string, unknown>).endTime = Date.now();
      (span as Record<string, unknown>).documentCount = documents?.length || 0;
    }
    if (this.currentToolSpan) {
      this.currentToolSpan.end({ success: true });
      this.currentToolSpan = null;
    }
  }

  async handleAgentAction(action: Record<string, unknown>): Promise<void> {
    const spanId = `planning-${Date.now()}-${Math.random()}`;
    this.activeSpans.set(spanId, {
      type: 'planning',
      action,
      startTime: Date.now(),
    });
  }

  async handleAgentEnd(result: Record<string, unknown>): Promise<void> {
    const spans = Array.from(this.activeSpans.values()).filter((s: unknown) => {
      const span = s as Record<string, unknown>;
      return span.type === 'planning';
    });
    if (spans.length > 0) {
      const span = spans[spans.length - 1] as Record<string, unknown>;
      (span as Record<string, unknown>).endTime = Date.now();
      (span as Record<string, unknown>).result = result;
    }
  }

  getRecordedSpans(): unknown[] {
    return Array.from(this.activeSpans.values());
  }

  clearSpans(): void {
    this.activeSpans.clear();
    if (this.currentTaskSpan) {
      this.currentTaskSpan.end({ success: false });
      this.currentTaskSpan = null;
    }
    this.currentLlmSpan = null;
    this.currentToolSpan = null;
  }
}

export async function initializeLangChainIntegration(_options?: LangChainCallbackOptions): Promise<void> {
  (globalThis as unknown as Record<string, unknown>).NrAiCallbackHandler = NrAiCallbackHandler;
}
