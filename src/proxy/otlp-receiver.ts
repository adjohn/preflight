import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger } from '../shared/index.js';
import { validateSsrfUrl } from '../security/ssrf.js';

const logger = createLogger('otlp-receiver');

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_BODY_TIMEOUT_MS = 30_000; // 30 s

class BodyTooLargeError extends Error {}
class RequestTimeoutError extends Error {}

export interface OtlpReceiverOptions {
  readonly port: number;
  readonly bindAddress?: string;
  readonly forwardEndpoint: string | null;
  readonly forwardHeaders: Record<string, string>;
  readonly enrichmentAttributes: Record<string, string>;
  readonly maxBodyBytes?: number;
  readonly bodyTimeoutMs?: number;
}

export class OtlpReceiver {
  private readonly options: OtlpReceiverOptions;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(options: OtlpReceiverOptions) {
    if (options.forwardEndpoint !== null) {
      validateSsrfUrl('OtlpReceiver forwardEndpoint', new URL(options.forwardEndpoint));
    }
    this.options = Object.freeze(options);
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => void this.handleRequest(req, res));
      this.server.on('error', reject);
      const host = this.options.bindAddress ?? '127.0.0.1';
      this.server.listen(this.options.port, host, () => {
        logger.info('OTLP receiver listening', { port: this.options.port, host });
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise(resolve => {
      if (!this.server) { resolve(); return; }
      this.server.close(() => resolve());
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const timeoutMs = this.options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
    req.setTimeout(timeoutMs, () => {
      res.writeHead(408);
      res.end();
      req.destroy(new RequestTimeoutError('Request timed out'));
    });

    const path = req.url ?? '';
    if (req.method !== 'POST' || !path.startsWith('/v1/')) {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      const body = await this.readBody(req);
      const enriched = this.enrichPayload(body);
      const contentType = req.headers['content-type'] ?? 'application/json';

      if (this.options.forwardEndpoint) {
        const result = await this.forward(enriched, path, contentType);
        res.writeHead(result.statusCode ?? 200, { 'Content-Type': 'application/json' });
        res.end(result.body);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        res.writeHead(413);
        res.end();
        return;
      }
      if (err instanceof RequestTimeoutError) {
        // 408 already written by the setTimeout callback; just return.
        return;
      }
      logger.error('OTLP receiver error', { err });
      res.writeHead(500);
      res.end();
    }
  }

  private readBody(req: IncomingMessage): Promise<Buffer> {
    const maxBytes = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          req.destroy();
          reject(new BodyTooLargeError(`Request body exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  enrichPayload(body: Buffer): Buffer {
    // For JSON-encoded OTLP (content-type: application/json), parse and inject attributes.
    // For protobuf-encoded OTLP (content-type: application/x-protobuf), pass through unchanged
    // (protobuf decoding requires additional dependencies — handle JSON only in v1).
    try {
      const parsed = JSON.parse(body.toString('utf-8')) as Record<string, unknown>;
      this.injectResourceAttributes(parsed, this.options.enrichmentAttributes);
      return Buffer.from(JSON.stringify(parsed));
    } catch {
      // Not JSON (likely protobuf) — forward as-is
      return body;
    }
  }

  private injectResourceAttributes(
    payload: Record<string, unknown>,
    attrs: Record<string, string>,
  ): void {
    // OTLP JSON structure: { resourceSpans: [{ resource: { attributes: [...] }, ... }] }
    // Also handle resourceMetrics and resourceLogs for /v1/metrics and /v1/logs
    for (const key of ['resourceSpans', 'resourceMetrics', 'resourceLogs']) {
      const resources = payload[key] as Array<{ resource?: { attributes?: unknown[] } }> | undefined;
      if (!Array.isArray(resources)) continue;

      for (const resource of resources) {
        if (!resource.resource) resource.resource = {};
        if (!Array.isArray(resource.resource.attributes)) resource.resource.attributes = [];
        for (const [k, v] of Object.entries(attrs)) {
          resource.resource.attributes.push({ key: k, value: { stringValue: v } });
        }
      }
    }
  }

  private async forward(
    body: Buffer,
    path: string,
    contentType: string,
  ): Promise<{ statusCode: number; body: string }> {
    if (this.options.forwardEndpoint === null) {
      throw new Error('forward() called with no forwardEndpoint configured');
    }
    validateSsrfUrl('OtlpReceiver forward endpoint', new URL(this.options.forwardEndpoint));
    const url = `${this.options.forwardEndpoint}${path}`;
    const response = await globalThis.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        ...this.options.forwardHeaders,
      },
      body: body as unknown as BodyInit,
    });
    const responseBody = await response.text();
    return { statusCode: response.status, body: responseBody };
  }
}
