import { describe, it, expect, beforeEach } from '@jest/globals';
import { NrAiCallbackHandler } from './langchain.js';

describe('NrAiCallbackHandler (LangChain Integration)', () => {
  let handler: NrAiCallbackHandler;

  beforeEach(() => {
    handler = new NrAiCallbackHandler();
    handler.clearSpans();
  });

  describe('LLM call tracking', () => {
    it('tracks LLM start', async () => {
      await handler.handleLLMStart(
        { name: 'gpt-4' },
        ['What is 2+2?']
      );

      const spans = handler.getRecordedSpans();
      expect(spans).toHaveLength(1);
      expect((spans[0] as Record<string, unknown>).type).toBe('llm_call');
    });

    it('tracks LLM end', async () => {
      await handler.handleLLMStart({ name: 'gpt-4' }, ['What is 2+2?']);
      await handler.handleLLMEnd({ text: '4' });

      const spans = handler.getRecordedSpans();
      expect((spans[0] as Record<string, unknown>).endTime).toBeDefined();
    });

    it('records error spans', async () => {
      const error = new Error('Rate limit exceeded');
      await handler.handleLLMError(error);

      const spans = handler.getRecordedSpans();
      expect(spans).toHaveLength(1);
      expect((spans[0] as Record<string, unknown>).type).toBe('error');
      expect((spans[0] as Record<string, unknown>).error).toBe('Rate limit exceeded');
    });
  });

  describe('Chain tracking', () => {
    it('tracks chain start', async () => {
      await handler.handleChainStart(
        { name: 'LLMChain' },
        { input: 'test' }
      );

      const spans = handler.getRecordedSpans();
      expect(spans).toHaveLength(1);
      expect((spans[0] as Record<string, unknown>).type).toBe('agent_task');
    });

    it('tracks chain end', async () => {
      await handler.handleChainStart({ name: 'LLMChain' }, {});
      await handler.handleChainEnd({ output: 'result' });

      const spans = handler.getRecordedSpans();
      expect((spans[0] as Record<string, unknown>).endTime).toBeDefined();
    });
  });

  describe('Tool tracking', () => {
    it('tracks tool start with input', async () => {
      await handler.handleToolStart(
        { name: 'calculator' },
        { operation: 'add', a: 2, b: 2 }
      );

      const spans = handler.getRecordedSpans();
      expect(spans).toHaveLength(1);
      expect((spans[0] as Record<string, unknown>).type).toBe('tool_call');
      expect((spans[0] as Record<string, unknown>).name).toBe('calculator');
    });

    it('tracks tool end with output', async () => {
      await handler.handleToolStart({ name: 'calculator' }, {});
      await handler.handleToolEnd('4');

      const spans = handler.getRecordedSpans();
      expect((spans[0] as Record<string, unknown>).output).toBe('4');
      expect((spans[0] as Record<string, unknown>).endTime).toBeDefined();
    });
  });

  describe('Retriever tracking', () => {
    it('tracks retriever start', async () => {
      await handler.handleRetrieverStart(
        { name: 'docs' },
        'what is the capital of france'
      );

      const spans = handler.getRecordedSpans();
      expect(spans).toHaveLength(1);
      expect((spans[0] as Record<string, unknown>).type).toBe('tool_call');
      expect((spans[0] as Record<string, unknown>).subType).toBe('retrieval');
    });

    it('tracks retriever end with document count', async () => {
      await handler.handleRetrieverStart({ name: 'docs' }, 'query');
      const docs = [
        { content: 'Paris is the capital' },
        { content: 'It has 2 million people' },
      ];
      await handler.handleRetrieverEnd(docs);

      const spans = handler.getRecordedSpans();
      expect((spans[0] as Record<string, unknown>).documentCount).toBe(2);
      expect((spans[0] as Record<string, unknown>).endTime).toBeDefined();
    });
  });

  describe('Agent action tracking', () => {
    it('tracks agent action', async () => {
      await handler.handleAgentAction({
        tool: 'calculator',
        toolInput: '2+2',
      });

      const spans = handler.getRecordedSpans();
      expect(spans).toHaveLength(1);
      expect((spans[0] as Record<string, unknown>).type).toBe('planning');
    });

    it('tracks agent end', async () => {
      await handler.handleAgentAction({ tool: 'search' });
      await handler.handleAgentEnd({ result: 'finished' });

      const spans = handler.getRecordedSpans();
      expect((spans[0] as Record<string, unknown>).result).toBeDefined();
      expect((spans[0] as Record<string, unknown>).endTime).toBeDefined();
    });
  });

  describe('Complex lifecycle', () => {
    it('tracks complete callback lifecycle', async () => {
      await handler.handleChainStart({ name: 'agent_chain' }, {});
      await handler.handleLLMStart({ name: 'gpt-4' }, ['initial prompt']);
      await handler.handleLLMEnd({ text: 'Use calculator' });
      await handler.handleToolStart({ name: 'calculator' }, { op: 'add' });
      await handler.handleToolEnd('4');
      await handler.handleLLMStart({ name: 'gpt-4' }, ['follow up']);
      await handler.handleLLMEnd({ text: 'Final answer' });
      await handler.handleChainEnd({ output: 'result' });

      const spans = handler.getRecordedSpans();
      expect(spans.length).toBeGreaterThan(3);
      expect(spans[0] as Record<string, unknown>).toHaveProperty('type', 'agent_task');
      expect(spans[1] as Record<string, unknown>).toHaveProperty('type', 'llm_call');
    });

    it('handles nested retrieval in chain', async () => {
      await handler.handleChainStart({ name: 'rag_chain' }, {});
      await handler.handleRetrieverStart({ name: 'docs' }, 'query');
      await handler.handleRetrieverEnd([{ doc: 1 }, { doc: 2 }]);
      await handler.handleLLMStart({ name: 'gpt-4' }, ['with context']);
      await handler.handleLLMEnd({ text: 'answer' });
      await handler.handleChainEnd({ output: 'result' });

      const spans = handler.getRecordedSpans();
      expect(spans).toHaveLength(3);
    });
  });

  describe('span management', () => {
    it('clears recorded spans', async () => {
      await handler.handleLLMStart({ name: 'gpt-4' }, []);
      expect(handler.getRecordedSpans()).toHaveLength(1);

      handler.clearSpans();
      expect(handler.getRecordedSpans()).toHaveLength(0);
    });

    it('returns copy of spans list', async () => {
      await handler.handleLLMStart({ name: 'gpt-4' }, []);
      const spans1 = handler.getRecordedSpans();
      const spans2 = handler.getRecordedSpans();

      expect(spans1).not.toBe(spans2);
      expect(spans1).toEqual(spans2);
    });
  });

  describe('unknown serialized names', () => {
    it('handles LLM without name', async () => {
      await handler.handleLLMStart({}, []);
      const spans = handler.getRecordedSpans();
      expect((spans[0] as Record<string, unknown>).name).toBe('unknown');
    });

    it('handles tool without name', async () => {
      await handler.handleToolStart({}, {});
      const spans = handler.getRecordedSpans();
      expect((spans[0] as Record<string, unknown>).name).toBe('unknown_tool');
    });
  });
});
