import { OTelExporter, mapAgentAttributesToOTel } from './otel.js';

describe('OTelExporter', () => {
  beforeEach(() => {
    delete process.env.NEW_RELIC_AI_OTLP_EXPORT_ENABLED;
    delete process.env.NEW_RELIC_AI_OTLP_ENDPOINT;
  });

  describe('Attribute Mapping', () => {
    it('maps OTel GenAI convention attributes correctly', () => {
      const input = {
        'ai.request.model': 'gpt-4',
        'ai.tokens.input': 100,
        'ai.tokens.output': 50,
        'ai.request.temperature': 0.7,
        'ai.request.max_tokens': 2048,
        'ai.response.stop_reason': 'stop',
      };

      const output = mapAgentAttributesToOTel(input);

      expect(output['gen_ai.request.model']).toBe('gpt-4');
      expect(output['gen_ai.usage.input_tokens']).toBe(100);
      expect(output['gen_ai.usage.output_tokens']).toBe(50);
      expect(output['gen_ai.request.temperature']).toBe(0.7);
      expect(output['gen_ai.request.max_output_tokens']).toBe(2048);
      expect(output['gen_ai.response.finish_reasons']).toBe('stop');
    });

    it('retains agent-specific attributes with ai.* prefix', () => {
      const input = {
        'ai.reasoning.depth_index': 5,
        'ai.cost.total_usd': 0.012,
        'ai.agent.total_steps': 3,
        'ai.custom.metric': 'value',
      };

      const output = mapAgentAttributesToOTel(input);

      expect(output['ai.reasoning.depth_index']).toBe(5);
      expect(output['ai.cost.total_usd']).toBe(0.012);
      expect(output['ai.agent.total_steps']).toBe(3);
      expect(output['ai.custom.metric']).toBe('value');
    });

    it('handles mixed mapped and unmapped attributes', () => {
      const input = {
        'ai.request.model': 'claude-opus',
        'ai.cost.total_usd': 0.05,
        'ai.tokens.input': 200,
      };

      const output = mapAgentAttributesToOTel(input);

      expect(output['gen_ai.request.model']).toBe('claude-opus');
      expect(output['ai.cost.total_usd']).toBe(0.05);
      expect(output['gen_ai.usage.input_tokens']).toBe(200);
    });

    it('filters out null and undefined values', () => {
      const input = {
        'ai.request.model': 'gpt-4',
        'ai.tokens.input': null as unknown,
        'ai.tokens.output': undefined as unknown,
      };

      const output = mapAgentAttributesToOTel(input);

      expect(output['gen_ai.request.model']).toBe('gpt-4');
      expect(Object.keys(output).length).toBe(1);
    });
  });

  describe('Span Export', () => {
    it('converts LlmCall span to OTel span', async () => {
      const exporter = new OTelExporter({ enabled: true });

      const span = {
        traceId: 'trace123',
        spanId: 'span456',
        name: 'llm.call',
        kind: 'CLIENT' as const,
        startTimeUnixNano: 1000000,
        endTimeUnixNano: 2000000,
        attributes: {
          'ai.request.model': 'gpt-4',
          'ai.tokens.input': 100,
          'ai.tokens.output': 50,
        },
        events: [],
      };

      const result = await exporter.exportSpans([span]);

      expect(result).toBeUndefined();
    });

    it('converts ToolCall span to OTel internal span', async () => {
      const exporter = new OTelExporter({ enabled: true });

      const span = {
        traceId: 'trace789',
        spanId: 'span012',
        parentSpanId: 'parent123',
        name: 'tool.call',
        kind: 'INTERNAL' as const,
        startTimeUnixNano: 1000000,
        endTimeUnixNano: 1500000,
        attributes: {
          'ai.tool.name': 'bash',
          'ai.tool.status': 'success',
        },
        events: [],
      };

      const result = await exporter.exportSpans([span]);

      expect(result).toBeUndefined();
    });

    it('includes span events in export', async () => {
      const exporter = new OTelExporter({ enabled: true });

      const span = {
        traceId: 'trace123',
        spanId: 'span456',
        name: 'task.span',
        kind: 'SERVER' as const,
        startTimeUnixNano: 1000000,
        endTimeUnixNano: 2000000,
        attributes: {},
        events: [
          {
            timeUnixNano: 1500000,
            name: 'event1',
            attributes: { key: 'value' },
          },
        ],
      };

      const result = await exporter.exportSpans([span]);

      expect(result).toBeUndefined();
    });

    it('handles spans with no parent span ID', async () => {
      const exporter = new OTelExporter({ enabled: true });

      const span = {
        traceId: 'trace123',
        spanId: 'span456',
        name: 'root.span',
        kind: 'SERVER' as const,
        startTimeUnixNano: 1000000,
        endTimeUnixNano: 2000000,
        attributes: {},
        events: [],
      };

      const result = await exporter.exportSpans([span]);

      expect(result).toBeUndefined();
    });
  });

  describe('Metric Export', () => {
    it('exports gauge metrics', async () => {
      const exporter = new OTelExporter({ enabled: true });

      const metrics = [
        {
          name: 'ai.cost.total',
          type: 'gauge' as const,
          dataPoints: [
            {
              timeUnixNano: 1000000,
              value: 0.05,
              attributes: { model: 'gpt-4' },
            },
          ],
        },
      ];

      const result = await exporter.exportMetrics(metrics);

      expect(result).toBeUndefined();
    });

    it('exports counter metrics', async () => {
      const exporter = new OTelExporter({ enabled: true });

      const metrics = [
        {
          name: 'ai.requests.total',
          type: 'counter' as const,
          dataPoints: [
            {
              timeUnixNano: 1000000,
              value: 100,
            },
          ],
        },
      ];

      const result = await exporter.exportMetrics(metrics);

      expect(result).toBeUndefined();
    });

    it('exports histogram metrics', async () => {
      const exporter = new OTelExporter({ enabled: true });

      const metrics = [
        {
          name: 'ai.duration.ms',
          type: 'histogram' as const,
          dataPoints: [
            {
              timeUnixNano: 1000000,
              value: 250,
            },
          ],
        },
      ];

      const result = await exporter.exportMetrics(metrics);

      expect(result).toBeUndefined();
    });

    it('includes metric description and unit', async () => {
      const exporter = new OTelExporter({ enabled: true });

      const metrics = [
        {
          name: 'ai.latency',
          description: 'Request latency in milliseconds',
          unit: 'ms',
          type: 'histogram' as const,
          dataPoints: [
            {
              timeUnixNano: 1000000,
              value: 150,
            },
          ],
        },
      ];

      const result = await exporter.exportMetrics(metrics);

      expect(result).toBeUndefined();
    });
  });

  describe('Configuration', () => {
    it('respects NEW_RELIC_AI_OTLP_EXPORT_ENABLED env var', () => {
      process.env.NEW_RELIC_AI_OTLP_EXPORT_ENABLED = 'true';
      const exporter = new OTelExporter();

      expect(exporter.isEnabled()).toBe(true);
    });

    it('respects NEW_RELIC_AI_OTLP_ENDPOINT env var', () => {
      process.env.NEW_RELIC_AI_OTLP_ENDPOINT = 'http://otel-collector:4318';
      const exporter = new OTelExporter();

      expect(exporter.getEndpoint()).toBe('http://otel-collector:4318');
    });

    it('uses config parameter over env vars', () => {
      process.env.NEW_RELIC_AI_OTLP_ENDPOINT = 'http://env:4318';
      const exporter = new OTelExporter({ endpoint: 'http://config:4318' });

      expect(exporter.getEndpoint()).toBe('http://config:4318');
    });

    it('defaults to localhost:4318 when not configured', () => {
      const exporter = new OTelExporter();

      expect(exporter.getEndpoint()).toBe('http://localhost:4318');
    });

    it('defaults to disabled when no config provided', () => {
      const exporter = new OTelExporter();

      expect(exporter.isEnabled()).toBe(false);
    });
  });

  describe('Disabled Export', () => {
    it('does not export spans when disabled', async () => {
      const exporter = new OTelExporter({ enabled: false });

      const span = {
        traceId: 'trace123',
        spanId: 'span456',
        name: 'test.span',
        kind: 'INTERNAL' as const,
        startTimeUnixNano: 1000000,
        endTimeUnixNano: 2000000,
        attributes: {},
        events: [],
      };

      const result = await exporter.exportSpans([span]);

      expect(result).toBeUndefined();
    });

    it('does not export metrics when disabled', async () => {
      const exporter = new OTelExporter({ enabled: false });

      const metrics = [
        {
          name: 'ai.test',
          type: 'gauge' as const,
          dataPoints: [
            {
              timeUnixNano: 1000000,
              value: 1,
            },
          ],
        },
      ];

      const result = await exporter.exportMetrics(metrics);

      expect(result).toBeUndefined();
    });

    it('handles empty span array', async () => {
      const exporter = new OTelExporter({ enabled: true });

      const result = await exporter.exportSpans([]);

      expect(result).toBeUndefined();
    });

    it('handles empty metric array', async () => {
      const exporter = new OTelExporter({ enabled: true });

      const result = await exporter.exportMetrics([]);

      expect(result).toBeUndefined();
    });
  });

  describe('Dual-Write Capability', () => {
    it('supports creating multiple exporters for dual-write', () => {
      const nrExporter = new OTelExporter({ enabled: false });
      const otelExporter = new OTelExporter({ enabled: true });

      expect(nrExporter.isEnabled()).toBe(false);
      expect(otelExporter.isEnabled()).toBe(true);
    });

    it('allows exporting same span to multiple destinations', async () => {
      const exporter1 = new OTelExporter({ enabled: true, endpoint: 'http://dest1:4318' });
      const exporter2 = new OTelExporter({ enabled: true, endpoint: 'http://dest2:4318' });

      const span = {
        traceId: 'trace123',
        spanId: 'span456',
        name: 'test.span',
        kind: 'INTERNAL' as const,
        startTimeUnixNano: 1000000,
        endTimeUnixNano: 2000000,
        attributes: {},
        events: [],
      };

      await Promise.all([exporter1.exportSpans([span]), exporter2.exportSpans([span])]);

      expect(exporter1.isEnabled()).toBe(true);
      expect(exporter2.isEnabled()).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('continues gracefully if fetch fails', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

      const exporter = new OTelExporter({ enabled: true });

      const span = {
        traceId: 'trace123',
        spanId: 'span456',
        name: 'test.span',
        kind: 'INTERNAL' as const,
        startTimeUnixNano: 1000000,
        endTimeUnixNano: 2000000,
        attributes: {},
        events: [],
      };

      const result = await exporter.exportSpans([span]);

      expect(result).toBeUndefined();

      global.fetch = originalFetch;
    });

    it('logs warning on HTTP error responses', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const exporter = new OTelExporter({ enabled: true });

      const span = {
        traceId: 'trace123',
        spanId: 'span456',
        name: 'test.span',
        kind: 'INTERNAL' as const,
        startTimeUnixNano: 1000000,
        endTimeUnixNano: 2000000,
        attributes: {},
        events: [],
      };

      const result = await exporter.exportSpans([span]);

      expect(result).toBeUndefined();

      global.fetch = originalFetch;
    });
  });

  describe('Span Kind Conversion', () => {
    it('converts INTERNAL span kind to OTel value', async () => {
      const exporter = new OTelExporter({ enabled: true });

      const span = {
        traceId: 'trace123',
        spanId: 'span456',
        name: 'internal.operation',
        kind: 'INTERNAL' as const,
        startTimeUnixNano: 1000000,
        endTimeUnixNano: 2000000,
        attributes: {},
        events: [],
      };

      const result = await exporter.exportSpans([span]);

      expect(result).toBeUndefined();
    });

    it('converts SERVER span kind to OTel value', async () => {
      const exporter = new OTelExporter({ enabled: true });

      const span = {
        traceId: 'trace123',
        spanId: 'span456',
        name: 'server.operation',
        kind: 'SERVER' as const,
        startTimeUnixNano: 1000000,
        endTimeUnixNano: 2000000,
        attributes: {},
        events: [],
      };

      const result = await exporter.exportSpans([span]);

      expect(result).toBeUndefined();
    });

    it('converts CLIENT span kind to OTel value', async () => {
      const exporter = new OTelExporter({ enabled: true });

      const span = {
        traceId: 'trace123',
        spanId: 'span456',
        name: 'client.operation',
        kind: 'CLIENT' as const,
        startTimeUnixNano: 1000000,
        endTimeUnixNano: 2000000,
        attributes: {},
        events: [],
      };

      const result = await exporter.exportSpans([span]);

      expect(result).toBeUndefined();
    });
  });

  describe('Attribute OTLP Format', () => {
    it('uses typed OTLP value fields for booleans, integers, floats, and strings', async () => {
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('{}', { status: 200 }),
      );

      const exporter = new OTelExporter({ enabled: true });
      await exporter.exportSpans([
        {
          traceId: 'trace1',
          spanId: 'span1',
          name: 'test',
          kind: 'INTERNAL' as const,
          startTimeUnixNano: 1000,
          endTimeUnixNano: 2000,
          attributes: {
            str_attr: 'hello',
            int_attr: 42,
            float_attr: 3.14,
            bool_attr: true,
          },
          events: [],
        },
      ]);

      expect(fetchSpy).toHaveBeenCalled();
      const [, options] = fetchSpy.mock.calls[0];
      expect(options?.method).toBe('POST');
      expect((options?.headers as Record<string, string>)?.['Content-Type']).toBe('application/json');
      const body = JSON.parse(options?.body as string) as {
        resourceSpans: Array<{
          scopeSpans: Array<{
            spans: Array<{ attributes: Array<{ key: string; value: Record<string, unknown> }> }>;
          }>;
        }>;
      };
      const attrs = body.resourceSpans[0].scopeSpans[0].spans[0].attributes;
      const byKey = Object.fromEntries(attrs.map(({ key, value }) => [key, value]));

      expect(byKey['str_attr']).toEqual({ stringValue: 'hello' });
      expect(byKey['int_attr']).toEqual({ intValue: 42 });
      expect(byKey['float_attr']).toEqual({ doubleValue: 3.14 });
      expect(byKey['bool_attr']).toEqual({ boolValue: true });

      fetchSpy.mockRestore();
    });

    it('serializes array attributes as OTLP arrayValue', async () => {
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('{}', { status: 200 }),
      );

      const exporter = new OTelExporter({ enabled: true });
      await exporter.exportSpans([
        {
          traceId: 'trace2',
          spanId: 'span2',
          name: 'test',
          kind: 'INTERNAL' as const,
          startTimeUnixNano: 1000,
          endTimeUnixNano: 2000,
          attributes: { tags: ['a', 'b', 'c'] as unknown as string },
          events: [],
        },
      ]);

      expect(fetchSpy).toHaveBeenCalled();
      const [, options] = fetchSpy.mock.calls[0];
      expect(options?.method).toBe('POST');
      expect((options?.headers as Record<string, string>)?.['Content-Type']).toBe('application/json');
      const body = JSON.parse(options?.body as string) as {
        resourceSpans: Array<{
          scopeSpans: Array<{
            spans: Array<{ attributes: Array<{ key: string; value: Record<string, unknown> }> }>;
          }>;
        }>;
      };
      const attrs = body.resourceSpans[0].scopeSpans[0].spans[0].attributes;
      const tagsAttr = attrs.find((a) => a.key === 'tags');

      expect(tagsAttr?.value).toHaveProperty('arrayValue');

      fetchSpy.mockRestore();
    });
  });

  describe('Metric Type Conversion', () => {
    it('converts gauge type to OTel gauge', async () => {
      const exporter = new OTelExporter({ enabled: true });

      const metrics = [
        {
          name: 'ai.gauge_metric',
          type: 'gauge' as const,
          dataPoints: [
            {
              timeUnixNano: 1000000,
              value: 42,
            },
          ],
        },
      ];

      const result = await exporter.exportMetrics(metrics);

      expect(result).toBeUndefined();
    });

    it('converts counter type to OTel sum with monotonic=true', async () => {
      const exporter = new OTelExporter({ enabled: true });

      const metrics = [
        {
          name: 'ai.counter_metric',
          type: 'counter' as const,
          dataPoints: [
            {
              timeUnixNano: 1000000,
              value: 100,
            },
          ],
        },
      ];

      const result = await exporter.exportMetrics(metrics);

      expect(result).toBeUndefined();
    });

    it('converts histogram type to OTel histogram', async () => {
      const exporter = new OTelExporter({ enabled: true });

      const metrics = [
        {
          name: 'ai.histogram_metric',
          type: 'histogram' as const,
          dataPoints: [
            {
              timeUnixNano: 1000000,
              value: 250,
            },
          ],
        },
      ];

      const result = await exporter.exportMetrics(metrics);

      expect(result).toBeUndefined();
    });
  });

  describe('setEndpoint and setHeaders', () => {
    it('setEndpoint updates the endpoint returned by getEndpoint', () => {
      const exporter = new OTelExporter({ enabled: true });
      exporter.setEndpoint('http://collector.example.com:4318');
      expect(exporter.getEndpoint()).toBe('http://collector.example.com:4318');
    });

    it('setHeaders merges custom headers into fetch calls', async () => {
      const exporter = new OTelExporter({ enabled: true, endpoint: 'http://test-host' });
      exporter.setHeaders({ 'api-key': 'my-secret', 'x-source': 'test' });

      let capturedHeaders: Record<string, string> | undefined;
      const mockFetch = jest.fn(async (_url: string, options?: RequestInit) => {
        capturedHeaders = options?.headers as Record<string, string>;
        return { ok: true } as Response;
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      try {
        await exporter.exportSpans([
          {
            traceId: 'abc', spanId: 'def', name: 'test', kind: 'INTERNAL',
            startTimeUnixNano: 0, endTimeUnixNano: 1,
            attributes: {}, events: [],
          },
        ]);
        expect(capturedHeaders?.['api-key']).toBe('my-secret');
        expect(capturedHeaders?.['x-source']).toBe('test');
        expect(capturedHeaders?.['Content-Type']).toBe('application/json');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
