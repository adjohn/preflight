import { createLogger } from '@nr-ai-observatory/shared';

const logger = createLogger('otel-export');

export interface OTelAttributes {
  [key: string]: string | number | boolean | string[] | number[] | boolean[];
}

export interface OTelSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: 'INTERNAL' | 'SERVER' | 'CLIENT';
  readonly startTimeUnixNano: number;
  readonly endTimeUnixNano: number;
  readonly attributes: OTelAttributes;
  readonly events: Array<{
    readonly timeUnixNano: number;
    readonly name: string;
    readonly attributes?: OTelAttributes;
  }>;
}

export interface OTelMetricDataPoint {
  readonly timeUnixNano: number;
  readonly value: number;
  readonly attributes?: OTelAttributes;
}

export interface OTelMetric {
  readonly name: string;
  readonly description?: string;
  readonly unit?: string;
  readonly type: 'gauge' | 'counter' | 'histogram';
  readonly dataPoints: OTelMetricDataPoint[];
}

export interface OTelExporterConfig {
  enabled?: boolean;
  endpoint?: string;
}

const ATTRIBUTE_MAPPING: Record<string, string> = {
  'ai.request.model': 'gen_ai.request.model',
  'ai.tokens.input': 'gen_ai.usage.input_tokens',
  'ai.tokens.output': 'gen_ai.usage.output_tokens',
  'ai.request.temperature': 'gen_ai.request.temperature',
  'ai.request.max_tokens': 'gen_ai.request.max_output_tokens',
  'ai.response.stop_reason': 'gen_ai.response.finish_reasons',
};

function mapAttributes(input: Record<string, unknown>): OTelAttributes {
  const output: OTelAttributes = {};

  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) {
      continue;
    }

    const mappedKey = ATTRIBUTE_MAPPING[key] || key;
    const primitiveValue = value as string | number | boolean | string[] | number[] | boolean[];
    output[mappedKey] = primitiveValue;
  }

  return output;
}

export class OTelExporter {
  private enabled: boolean;
  private endpoint: string;
  private headers: Record<string, string>;

  constructor(config?: OTelExporterConfig) {
    this.enabled = config?.enabled ?? false;

    if (!this.enabled && process.env.NEW_RELIC_AI_OTLP_EXPORT_ENABLED === 'true') {
      this.enabled = true;
    }

    this.endpoint =
      config?.endpoint || process.env.NEW_RELIC_AI_OTLP_ENDPOINT || 'http://localhost:4318';
    this.headers = {};
  }

  exportSpans(spans: OTelSpan[]): Promise<void> {
    if (!this.enabled || spans.length === 0) {
      return Promise.resolve();
    }

    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [],
          },
          scopeSpans: [
            {
              scope: {
                name: 'nr-ai-agent',
              },
              spans: spans.map((span) => ({
                traceId: span.traceId,
                spanId: span.spanId,
                parentSpanId: span.parentSpanId || '',
                name: span.name,
                kind: this.spanKindToOTel(span.kind),
                startTimeUnixNano: span.startTimeUnixNano,
                endTimeUnixNano: span.endTimeUnixNano,
                attributes: this.attributesToOTelFormat(span.attributes),
                events: span.events.map((event) => ({
                  timeUnixNano: event.timeUnixNano,
                  name: event.name,
                  attributes: event.attributes
                    ? this.attributesToOTelFormat(event.attributes)
                    : [],
                })),
                status: {
                  code: 0,
                },
              })),
            },
          ],
        },
      ],
    };

    return this.sendToOTLP(payload, 'traces');
  }

  exportMetrics(metrics: OTelMetric[]): Promise<void> {
    if (!this.enabled || metrics.length === 0) {
      return Promise.resolve();
    }

    const payload = {
      resourceMetrics: [
        {
          resource: {
            attributes: [],
          },
          scopeMetrics: [
            {
              scope: {
                name: 'nr-ai-agent',
              },
              metrics: metrics.map((metric) => ({
                name: metric.name,
                description: metric.description || '',
                unit: metric.unit || '',
                [this.metricTypeToKey(metric.type)]: {
                  dataPoints: metric.dataPoints.map((dp) => ({
                    timeUnixNano: dp.timeUnixNano,
                    value: dp.value,
                    attributes: dp.attributes ? this.attributesToOTelFormat(dp.attributes) : [],
                  })),
                  isMonotonic: metric.type === 'counter',
                },
              })),
            },
          ],
        },
      ],
    };

    return this.sendToOTLP(payload, 'metrics');
  }

  private spanKindToOTel(kind: string): number {
    const kinds: Record<string, number> = {
      INTERNAL: 1,
      SERVER: 2,
      CLIENT: 3,
    };
    return kinds[kind] || 1;
  }

  private metricTypeToKey(type: string): string {
    const keys: Record<string, string> = {
      gauge: 'gauge',
      counter: 'sum',
      histogram: 'histogram',
    };
    return keys[type] || 'gauge';
  }

  private attributesToOTelFormat(attrs: OTelAttributes): Array<{ key: string; value: unknown }> {
    return Object.entries(attrs).map(([key, value]) => {
      let otlpValue: unknown;
      if (typeof value === 'boolean') {
        otlpValue = { boolValue: value };
      } else if (typeof value === 'number') {
        otlpValue = Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
      } else if (Array.isArray(value)) {
        otlpValue = { arrayValue: { values: value.map((v) => this.primitiveToAnyValue(v)) } };
      } else {
        otlpValue = { stringValue: String(value) };
      }
      return { key, value: otlpValue };
    });
  }

  private primitiveToAnyValue(value: string | number | boolean): unknown {
    if (typeof value === 'boolean') return { boolValue: value };
    if (typeof value === 'number') {
      return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
    }
    return { stringValue: value };
  }

  private async sendToOTLP(payload: unknown, type: string): Promise<void> {
    if (!this.enabled) {
      return;
    }

    try {
      const endpoint = `${this.endpoint}/v1/${type}`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        logger.warn('OTLP export failed', {
          endpoint,
          status: response.status,
          type,
        });
      }
    } catch (error) {
      logger.warn('OTLP export error', {
        type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getEndpoint(): string {
    return this.endpoint;
  }

  setEndpoint(url: string): void {
    this.endpoint = url;
  }

  setHeaders(headers: Record<string, string>): void {
    this.headers = { ...headers };
  }
}

export function mapAgentAttributesToOTel(attributes: Record<string, unknown>): OTelAttributes {
  return mapAttributes(attributes);
}
