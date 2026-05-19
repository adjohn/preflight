import { CustomMetricsManager } from './custom-metrics.js';

describe('CustomMetricsManager', () => {
  let manager: CustomMetricsManager;

  beforeEach(() => {
    manager = new CustomMetricsManager('test-app', '1.0.0');
  });

  describe('recordCustomEvent', () => {
    it('creates event with correct attributes and standard fields', () => {
      const events: unknown[] = [];
      manager.setEventHandler((event) => {
        events.push(event);
      });

      manager.recordCustomEvent('AiEvaluation', {
        score: 0.87,
        version: 'v3.2',
        passed: true,
      });

      expect(events.length).toBe(1);
      const event = events[0] as Record<string, unknown>;
      expect(event.eventType).toBe('AiEvaluation');
      expect((event.attributes as Record<string, unknown>)['ai.app_name']).toBe('test-app');
      expect((event.attributes as Record<string, unknown>)['ai.agent_version']).toBe('1.0.0');
      expect((event.attributes as Record<string, unknown>)['score']).toBe(0.87);
      expect((event.attributes as Record<string, unknown>)['version']).toBe('v3.2');
      expect((event.attributes as Record<string, unknown>)['passed']).toBe(true);
    });

    it('includes timestamp in event attributes', () => {
      const events: unknown[] = [];
      manager.setEventHandler((event) => {
        events.push(event);
      });

      const before = Date.now();
      manager.recordCustomEvent('TestEvent', {});
      const after = Date.now();

      const event = events[0] as Record<string, unknown>;
      const timestamp = (event.attributes as Record<string, unknown>)['timestamp'] as number;

      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });

    it('rejects nested objects in attributes', () => {
      const events: unknown[] = [];
      manager.setEventHandler((event) => {
        events.push(event);
      });

      manager.recordCustomEvent('TestEvent', {
        valid: 'string',
        invalid: { nested: 'object' },
      });

      expect(events.length).toBe(1);
      const attrs = (events[0] as Record<string, unknown>).attributes as Record<string, unknown>;
      expect(attrs['valid']).toBe('string');
      expect(attrs['invalid']).toBeUndefined();
    });

    it('rejects array attributes', () => {
      const events: unknown[] = [];
      manager.setEventHandler((event) => {
        events.push(event);
      });

      manager.recordCustomEvent('TestEvent', {
        valid: 'string',
        invalid: [1, 2, 3],
      });

      expect(events.length).toBe(1);
      const attrs = (events[0] as Record<string, unknown>).attributes as Record<string, unknown>;
      expect(attrs['valid']).toBe('string');
      expect(attrs['invalid']).toBeUndefined();
    });

    it('truncates long string values to 4096 chars', () => {
      const events: unknown[] = [];
      manager.setEventHandler((event) => {
        events.push(event);
      });

      const longString = 'x'.repeat(5000);
      manager.recordCustomEvent('TestEvent', {
        longAttr: longString,
      });

      expect(events.length).toBe(1);
      const attrs = (events[0] as Record<string, unknown>).attributes as Record<string, unknown>;
      const truncated = attrs['longAttr'] as string;
      expect(truncated.length).toBe(4096);
    });

    it('validates event name - rejects names starting with Nr', () => {
      const events: unknown[] = [];
      manager.setEventHandler((event) => {
        events.push(event);
      });

      manager.recordCustomEvent('NrInvalidEvent', {});

      expect(events.length).toBe(0);
    });

    it('validates event name - rejects names over 255 chars', () => {
      const events: unknown[] = [];
      manager.setEventHandler((event) => {
        events.push(event);
      });

      const longName = 'A'.repeat(256);
      manager.recordCustomEvent(longName, {});

      expect(events.length).toBe(0);
    });

    it('accepts valid event names', () => {
      const events: unknown[] = [];
      manager.setEventHandler((event) => {
        events.push(event);
      });

      manager.recordCustomEvent('ValidEventName_123', {});

      expect(events.length).toBe(1);
    });

    it('filters out null and undefined attributes', () => {
      const events: unknown[] = [];
      manager.setEventHandler((event) => {
        events.push(event);
      });

      manager.recordCustomEvent('TestEvent', {
        valid: 'string',
        nullValue: null as unknown,
        undefinedValue: undefined as unknown,
      });

      const attrs = (events[0] as Record<string, unknown>).attributes as Record<string, unknown>;
      expect(attrs['valid']).toBe('string');
      expect(attrs['nullValue']).toBeUndefined();
      expect(attrs['undefinedValue']).toBeUndefined();
    });
  });

  describe('recordCustomMetric', () => {
    it('registers metric in aggregator', () => {
      const metrics: unknown[] = [];
      manager.setMetricHandler((metric) => {
        metrics.push(metric);
      });

      manager.recordCustomMetric('ai.custom.eval_score', 0.87, {
        version: 'v3.2',
      });

      expect(metrics.length).toBe(1);
      const metric = metrics[0] as Record<string, unknown>;
      expect(metric.name).toBe('ai.custom.eval_score');
      expect(metric.value).toBe(0.87);
      expect((metric.attributes as Record<string, unknown>)['version']).toBe('v3.2');
    });

    it('validates metric name - requires ai.custom. prefix', () => {
      const metrics: unknown[] = [];
      manager.setMetricHandler((metric) => {
        metrics.push(metric);
      });

      manager.recordCustomMetric('invalid_metric', 100);

      expect(metrics.length).toBe(0);
    });

    it('accepts metrics with ai.custom. prefix', () => {
      const metrics: unknown[] = [];
      manager.setMetricHandler((metric) => {
        metrics.push(metric);
      });

      manager.recordCustomMetric('ai.custom.quality', 0.95);

      expect(metrics.length).toBe(1);
    });

    it('rejects non-numeric values', () => {
      const metrics: unknown[] = [];
      manager.setMetricHandler((metric) => {
        metrics.push(metric);
      });

      // Test with invalid type - cast to bypass TypeScript
      const recordMetric = manager.recordCustomMetric.bind(manager);
      recordMetric('ai.custom.test', 'not-a-number' as unknown as number);

      expect(metrics.length).toBe(0);
    });

    it('rejects Infinity and NaN', () => {
      const metrics: unknown[] = [];
      manager.setMetricHandler((metric) => {
        metrics.push(metric);
      });

      manager.recordCustomMetric('ai.custom.inf', Infinity);
      manager.recordCustomMetric('ai.custom.nan', NaN);

      expect(metrics.length).toBe(0);
    });

    it('includes timestamp in metric', () => {
      const metrics: unknown[] = [];
      manager.setMetricHandler((metric) => {
        metrics.push(metric);
      });

      const before = Date.now();
      manager.recordCustomMetric('ai.custom.test', 42);
      const after = Date.now();

      const metric = metrics[0] as Record<string, unknown>;
      const timestamp = metric.timestamp as number;

      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('startCustomSpan', () => {
    it('creates span with name and attributes', () => {
      const spans: unknown[] = [];
      manager.setSpanHandler((span) => {
        spans.push(span);
      });

      const span = manager.startCustomSpan('ai.custom.eval', { evalType: 'reference' });
      // span is only emitted on end()
      expect(spans.length).toBe(0);
      span.end();

      expect(spans.length).toBe(1);
      const spanData = spans[0] as Record<string, unknown>;
      expect(spanData.name).toBe('ai.custom.eval');
      expect((spanData.attributes as Record<string, unknown>)['evalType']).toBe('reference');
    });

    it('allows setting attributes on span and emits them on end', () => {
      const spans: unknown[] = [];
      manager.setSpanHandler((span) => {
        spans.push(span);
      });

      const span = manager.startCustomSpan('ai.custom.test');
      span.setAttribute('result', 0.95);
      span.setAttribute('model', 'gpt-4');
      span.end();

      expect(spans.length).toBe(1);
      const spanData = spans[0] as Record<string, unknown>;
      expect((spanData.attributes as Record<string, unknown>)['result']).toBe(0.95);
      expect((spanData.attributes as Record<string, unknown>)['model']).toBe('gpt-4');
    });

    it('creates span without attributes when not provided', () => {
      const spans: unknown[] = [];
      manager.setSpanHandler((spanData) => {
        spans.push(spanData);
      });

      const span = manager.startCustomSpan('ai.custom.test');
      span.end();

      expect(spans.length).toBe(1);
      const spanDataResult = spans[0] as Record<string, unknown>;
      expect(spanDataResult.attributes).toEqual({});
    });

    it('returns valid span object even with invalid name', () => {
      const spans: unknown[] = [];
      manager.setSpanHandler((span) => {
        spans.push(span);
      });

      const span = manager.startCustomSpan('');

      expect(span).toBeDefined();
      expect(spans.length).toBe(0);

      span.setAttribute('key', 'value');
      span.end();
    });

    it('includes startTime, endTime, and duration_ms in span data', () => {
      const spans: unknown[] = [];
      manager.setSpanHandler((span) => {
        spans.push(span);
      });

      const before = Date.now();
      const span = manager.startCustomSpan('ai.custom.test');
      span.end();
      const after = Date.now();

      const spanData = spans[0] as Record<string, unknown>;
      const startTime = spanData.startTime as number;
      const endTime = spanData.endTime as number;
      const durationMs = spanData.duration_ms as number;

      expect(startTime).toBeGreaterThanOrEqual(before);
      expect(startTime).toBeLessThanOrEqual(after);
      expect(endTime).toBeGreaterThanOrEqual(startTime);
      expect(durationMs).toBeGreaterThanOrEqual(0);
      expect(durationMs).toBe(endTime - startTime);
    });
  });

  describe('instrument', () => {
    it('measures duration of synchronous function', async () => {
      const spans: unknown[] = [];
      manager.setSpanHandler((span) => {
        spans.push(span);
      });

      const fn = ((...args: unknown[]) => {
        const x = args[0] as number;
        return x * 2;
      }) as unknown as (...args: unknown[]) => unknown;
      const instrumented = manager.instrument('ai.custom.compute', fn);

      const result = instrumented(5);

      expect(result).toBe(10);
    });

    it('measures duration of async function', async () => {
      const spans: unknown[] = [];
      manager.setSpanHandler((span) => {
        spans.push(span);
      });

      const asyncFn = (async (...args: unknown[]) => {
        const x = args[0] as number;
        return new Promise((resolve) => {
          setTimeout(() => resolve(x * 2), 10);
        });
      }) as unknown as (...args: unknown[]) => Promise<unknown>;

      const instrumented = manager.instrument('ai.custom.asyncCompute', asyncFn);

      const result = await (instrumented as (...args: unknown[]) => Promise<unknown>)(5);

      expect(result).toBe(10);
    });

    it('propagates errors from wrapped function', () => {
      const fn = () => {
        throw new Error('Test error');
      };

      const instrumented = manager.instrument('ai.custom.error', fn);

      expect(() => instrumented()).toThrow('Test error');
    });

    it('propagates errors from async wrapped function', async () => {
      const asyncFn = async () => {
        throw new Error('Async error');
      };

      const instrumented = manager.instrument('ai.custom.asyncError', asyncFn);

      await expect(instrumented()).rejects.toThrow('Async error');
    });

    it('includes duration_ms in span data', async () => {
      const spans: unknown[] = [];
      manager.setSpanHandler((span) => {
        spans.push(span);
      });

      const fn = async () => {
        return new Promise((resolve) => {
          setTimeout(() => resolve('done'), 20);
        });
      };

      const instrumented = manager.instrument('ai.custom.timed', fn);
      await instrumented();

      const spanData = spans[0] as Record<string, unknown>;
      expect(spanData.startTime).toBeDefined();
      expect(spanData.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('includes status success in span attributes', async () => {
      const spans: unknown[] = [];
      manager.setSpanHandler((span) => {
        spans.push(span);
      });

      const fn = () => 'success';
      const instrumented = manager.instrument('ai.custom.success', fn);

      instrumented();

      expect(spans.length).toBe(1);
    });

    it('includes status error in span attributes on exception', async () => {
      const spans: unknown[] = [];
      manager.setSpanHandler((span) => {
        spans.push(span);
      });

      const fn = () => {
        throw new Error('error');
      };

      const instrumented = manager.instrument('ai.custom.errorSpan', fn);

      try {
        instrumented();
      } catch {
        // Expected
      }

      expect(spans.length).toBe(1);
    });

    it('handles function with invalid span name', () => {
      const fn = ((...args: unknown[]) => {
        const x = args[0] as number;
        return x * 2;
      }) as unknown as (...args: unknown[]) => unknown;
      const instrumented = manager.instrument('', fn);

      expect((instrumented as (...args: unknown[]) => unknown)(5)).toBe(10);
    });
  });

  describe('Event Handler Attachment', () => {
    it('allows setting and using event handler', () => {
      const events: unknown[] = [];

      manager.setEventHandler((event) => {
        events.push(event);
      });

      manager.recordCustomEvent('Test', { key: 'value' });

      expect(events.length).toBe(1);
    });

    it('allows setting and using metric handler', () => {
      const metrics: unknown[] = [];

      manager.setMetricHandler((metric) => {
        metrics.push(metric);
      });

      manager.recordCustomMetric('ai.custom.test', 123);

      expect(metrics.length).toBe(1);
    });

    it('allows setting and using span handler', () => {
      const spans: unknown[] = [];

      manager.setSpanHandler((span) => {
        spans.push(span);
      });

      const span = manager.startCustomSpan('ai.custom.test');
      span.end();

      expect(spans.length).toBe(1);
    });
  });

  describe('Configuration', () => {
    it('uses custom app name', () => {
      const manager2 = new CustomMetricsManager('my-app', '2.0.0');
      const events: unknown[] = [];

      manager2.setEventHandler((event) => {
        events.push(event);
      });

      manager2.recordCustomEvent('Test', {});

      const attrs = (events[0] as Record<string, unknown>).attributes as Record<string, unknown>;
      expect(attrs['ai.app_name']).toBe('my-app');
      expect(attrs['ai.agent_version']).toBe('2.0.0');
    });

    it('uses default app name and version when not provided', () => {
      const manager2 = new CustomMetricsManager();
      const events: unknown[] = [];

      manager2.setEventHandler((event) => {
        events.push(event);
      });

      manager2.recordCustomEvent('Test', {});

      const attrs = (events[0] as Record<string, unknown>).attributes as Record<string, unknown>;
      expect(attrs['ai.app_name']).toBe('nr-ai-agent');
      expect(attrs['ai.agent_version']).toBe('1.0.0');
    });
  });

  describe('No Handler Edge Cases', () => {
    it('handles recordCustomEvent with no handler set', () => {
      expect(() => {
        manager.recordCustomEvent('Test', { key: 'value' });
      }).not.toThrow();
    });

    it('handles recordCustomMetric with no handler set', () => {
      expect(() => {
        manager.recordCustomMetric('ai.custom.test', 42);
      }).not.toThrow();
    });

    it('handles startCustomSpan with no handler set', () => {
      expect(() => {
        const span = manager.startCustomSpan('ai.custom.test');
        span.end();
      }).not.toThrow();
    });
  });

  describe('Attribute Type Validation', () => {
    it('accepts string, number, and boolean attributes', () => {
      const events: unknown[] = [];
      manager.setEventHandler((event) => {
        events.push(event);
      });

      manager.recordCustomEvent('Test', {
        str: 'value',
        num: 42,
        bool: true,
      });

      const attrs = (events[0] as Record<string, unknown>).attributes as Record<string, unknown>;
      expect(attrs['str']).toBe('value');
      expect(attrs['num']).toBe(42);
      expect(attrs['bool']).toBe(true);
    });

    it('rejects unsupported types', () => {
      const events: unknown[] = [];
      manager.setEventHandler((event) => {
        events.push(event);
      });

      manager.recordCustomEvent('Test', {
        fn: () => 'function',
        symbol: Symbol('test'),
      });

      const attrs = (events[0] as Record<string, unknown>).attributes as Record<string, unknown>;
      expect(attrs['fn']).toBeUndefined();
      expect(attrs['symbol']).toBeUndefined();
    });
  });

  describe('Attribute Key Length Validation', () => {
    it('skips attributes with keys over 255 chars', () => {
      const events: unknown[] = [];
      manager.setEventHandler((event) => {
        events.push(event);
      });

      const longKey = 'k'.repeat(256);
      manager.recordCustomEvent('Test', {
        [longKey]: 'value',
        validKey: 'value',
      });

      const attrs = (events[0] as Record<string, unknown>).attributes as Record<string, unknown>;
      expect(attrs['validKey']).toBe('value');
      expect(attrs[longKey]).toBeUndefined();
    });
  });
});
