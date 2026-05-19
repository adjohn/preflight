import { createLogger } from '@nr-ai-observatory/shared';

const logger = createLogger('custom-metrics');

export type CustomMetricType = 'gauge' | 'counter' | 'summary';

export interface CustomSpan {
  setAttribute(key: string, value: unknown): void;
  end(): void;
}

export interface CustomMetricsAPI {
  recordCustomEvent(eventName: string, attributes: Record<string, unknown>): void;
  recordCustomMetric(
    metricName: string,
    value: number,
    attributes?: Record<string, string | number | boolean>,
  ): void;
  startCustomSpan(spanName: string, attributes?: Record<string, unknown>): CustomSpan;
  instrument<T extends (...args: unknown[]) => Promise<unknown> | unknown>(
    spanName: string,
    fn: T,
  ): T;
}

interface StandardAttributes {
  'ai.app_name'?: string;
  'ai.agent_version'?: string;
  timestamp?: number;
}

export class CustomMetricsManager implements CustomMetricsAPI {
  private appName: string;
  private agentVersion: string;
  private eventHandler: ((event: unknown) => void) | null = null;
  private metricHandler: ((metric: unknown) => void) | null = null;
  private spanHandler: ((span: unknown) => void) | null = null;

  constructor(appName: string = 'nr-ai-agent', agentVersion: string = '1.0.0') {
    this.appName = appName;
    this.agentVersion = agentVersion;
  }

  setEventHandler(handler: (event: unknown) => void): void {
    this.eventHandler = handler;
  }

  setMetricHandler(handler: (metric: unknown) => void): void {
    this.metricHandler = handler;
  }

  setSpanHandler(handler: (span: unknown) => void): void {
    this.spanHandler = handler;
  }

  recordCustomEvent(eventName: string, attributes: Record<string, unknown>): void {
    if (!this.validateEventName(eventName)) {
      logger.warn('Invalid custom event name', { eventName });
      return;
    }

    const validatedAttributes = this.validateAndSanitizeAttributes(attributes);

    const standardAttrs: StandardAttributes = {
      'ai.app_name': this.appName,
      'ai.agent_version': this.agentVersion,
      timestamp: Date.now(),
    };

    const event = {
      eventType: eventName,
      attributes: {
        ...standardAttrs,
        ...validatedAttributes,
      },
    };

    if (this.eventHandler) {
      this.eventHandler(event);
    }
  }

  recordCustomMetric(
    metricName: string,
    value: number,
    attributes?: Record<string, string | number | boolean>,
  ): void {
    if (!this.validateMetricName(metricName)) {
      logger.warn('Invalid custom metric name', { metricName });
      return;
    }

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      logger.warn('Invalid metric value', { metricName, value });
      return;
    }

    const metric = {
      name: metricName,
      value,
      timestamp: Date.now(),
      attributes: attributes || {},
    };

    if (this.metricHandler) {
      this.metricHandler(metric);
    }
  }

  startCustomSpan(spanName: string, attributes?: Record<string, unknown>): CustomSpan {
    if (!this.validateSpanName(spanName)) {
      logger.warn('Invalid custom span name', { spanName });
      return this.createNullSpan();
    }

    const startTime = Date.now();
    const mutableAttributes: Record<string, unknown> = { ...(attributes ?? {}) };
    const handler = this.spanHandler;

    const span: CustomSpan = {
      setAttribute: (key: string, value: unknown) => {
        mutableAttributes[key] = value;
      },
      end: () => {
        const endTime = Date.now();
        const spanData = {
          name: spanName,
          startTime,
          endTime,
          duration_ms: endTime - startTime,
          attributes: { ...mutableAttributes },
        };
        if (handler) {
          handler(spanData);
        }
      },
    };

    return span;
  }

  instrument<T extends (...args: unknown[]) => Promise<unknown> | unknown>(
    spanName: string,
    fn: T,
  ): T {
    if (!this.validateSpanName(spanName)) {
      logger.warn('Invalid instrument span name', { spanName });
      return fn;
    }

    if (this.isFunctionAsync(fn)) {
      const asyncWrapper = async (...args: unknown[]) => {
        const span = this.startCustomSpan(spanName);

        try {
          const result = await (fn as (...args: unknown[]) => Promise<unknown>)(...args);
          span.setAttribute('status', 'success');
          span.setAttribute('result_type', typeof result);
          span.end();
          return result;
        } catch (error) {
          span.setAttribute('status', 'error');
          span.setAttribute('error_type', error instanceof Error ? error.name : typeof error);
          span.end();
          throw error;
        }
      };

      return asyncWrapper as T;
    }

    const syncWrapper = (...args: unknown[]) => {
      const span = this.startCustomSpan(spanName);

      try {
        const result = (fn as (...args: unknown[]) => unknown)(...args);
        span.setAttribute('status', 'success');
        span.setAttribute('result_type', typeof result);
        span.end();
        return result;
      } catch (error) {
        span.setAttribute('status', 'error');
        span.setAttribute('error_type', error instanceof Error ? error.name : typeof error);
        span.end();
        throw error;
      }
    };

    return syncWrapper as T;
  }

  private validateEventName(name: string): boolean {
    if (typeof name !== 'string') {
      return false;
    }

    if (name.length === 0 || name.length > 255) {
      return false;
    }

    if (name.startsWith('Nr')) {
      return false;
    }

    if (!/^[a-zA-Z0-9._]*$/.test(name)) {
      return false;
    }

    return true;
  }

  private validateMetricName(name: string): boolean {
    if (typeof name !== 'string') {
      return false;
    }

    if (!name.startsWith('ai.custom.')) {
      return false;
    }

    if (name.length > 255) {
      return false;
    }

    return true;
  }

  private validateSpanName(name: string): boolean {
    if (typeof name !== 'string') {
      return false;
    }

    if (name.length === 0 || name.length > 255) {
      return false;
    }

    return true;
  }

  private validateAndSanitizeAttributes(
    attrs: Record<string, unknown>,
  ): Record<string, string | number | boolean> {
    const sanitized: Record<string, string | number | boolean> = {};

    for (const [key, value] of Object.entries(attrs)) {
      if (key.length > 255) {
        logger.warn('Attribute key too long, truncating', { key });
        continue;
      }

      if (value === null || value === undefined) {
        continue;
      }

      if (typeof value === 'string') {
        if (value.length > 4096) {
          logger.warn('String attribute value too long, truncating', { key });
          sanitized[key] = value.substring(0, 4096);
        } else {
          sanitized[key] = value;
        }
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        sanitized[key] = value;
      } else if (typeof value === 'boolean') {
        sanitized[key] = value;
      } else if (Array.isArray(value)) {
        logger.warn('Array attribute rejected, only primitives supported', { key });
      } else if (typeof value === 'object') {
        logger.warn('Nested object attribute rejected, only primitives supported', { key });
      } else {
        logger.warn('Unsupported attribute type', { key, type: typeof value });
      }
    }

    return sanitized;
  }

  private isFunctionAsync(fn: unknown): boolean {
    if (typeof fn !== 'function') {
      return false;
    }
    const AsyncFunction = (async () => {}).constructor;
    return fn instanceof AsyncFunction;
  }

  private createNullSpan(): CustomSpan {
    return {
      setAttribute: () => {
        // no-op
      },
      end: () => {
        // no-op
      },
    };
  }
}
