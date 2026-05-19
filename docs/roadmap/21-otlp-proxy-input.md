# Implementation Plan: OTLP Input in Proxy Mode

**Roadmap item:** [21 — OTLP Input in Proxy Mode](../ROADMAP.md#21-otlp-input-in-proxy-mode)
**Effort estimate:** ~2 days
**Prerequisites:** Read `packages/nr-ai-mcp-server/src/proxy/proxy-manager.ts` and the proxy types before starting. Item 18 (OTLP Transport) must be complete first — this plan depends on the OTel dependencies and the NR OTLP forwarding setup from item 18.

---

## Goal

When the MCP server runs in proxy mode, add a local OTLP/HTTP receiver that accepts telemetry from other instrumented services on the developer's machine and forwards it to New Relic's OTLP ingest endpoint, enriched with the current session context (`session_id`, `developer`, `project_id`). This makes the observatory a local OpenTelemetry Collector that ties AI-coded application telemetry to the coding session that produced it.

Concretely: a developer runs `nr-ai-mcp-server` in proxy mode. Their application is instrumented with any OTel SDK and configured to export to `http://localhost:4318`. The proxy receives those spans, stamps them with the active `session_id`, and forwards to NR. In NR, the developer can query: "which application spans were created during this AI coding session?"

---

## Background reading

Before starting, read these files end-to-end:

- `packages/nr-ai-mcp-server/src/proxy/proxy-manager.ts` — the existing HTTP proxy server; this plan adds routes to it
- `packages/nr-ai-mcp-server/src/proxy/types.ts` — `UpstreamConfig` and proxy types
- `packages/nr-ai-mcp-server/src/config.ts` — `McpServerConfig` to extend with receiver config
- `packages/nr-ai-mcp-server/src/transport/nr-ingest.ts` — `NrIngestManager` for context about session_id/developer fields

---

## Step 1 — Add config fields

In `packages/nr-ai-mcp-server/src/config.ts`, add to `McpServerConfig`:

```typescript
/** Enable the local OTLP/HTTP receiver. Default: false. */
readonly otlpReceiverEnabled: boolean;
/** Port for the local OTLP/HTTP receiver. Default: 4318. */
readonly otlpReceiverPort: number;
/**
 * OTLP forward endpoint — where to relay received spans.
 * Defaults to New Relic US OTLP endpoint when licenseKey is present.
 * Set to null to disable forwarding (receive and enrich only, then drop).
 */
readonly otlpForwardEndpoint: string | null;
```

Defaults:
- `otlpReceiverEnabled`: `false` (env: `NR_AI_OTLP_RECEIVER_ENABLED=true`)
- `otlpReceiverPort`: `4318` (env: `NR_AI_OTLP_RECEIVER_PORT`)
- `otlpForwardEndpoint`: `'https://otlp.nr-data.net'` when `licenseKey` is non-empty, `null` otherwise (configurable via `NR_AI_OTLP_FORWARD_ENDPOINT`)

---

## Step 2 — Create `OtlpReceiver`

Create `packages/nr-ai-mcp-server/src/proxy/otlp-receiver.ts`.

This module starts an HTTP server on `otlpReceiverPort` that accepts OTLP/HTTP `POST /v1/traces`, `POST /v1/metrics`, and `POST /v1/logs` requests. For each request it:

1. Reads and decodes the protobuf body (traces) or JSON body (metrics/logs)
2. Injects enrichment attributes (`ai.session.id`, `ai.developer`, `ai.project_id`) into every resource's `attributes` array
3. Re-encodes and forwards the enriched payload to `otlpForwardEndpoint`
4. Returns the upstream response status to the caller

```typescript
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger } from '@nr-ai-observatory/shared';

const logger = createLogger('otlp-receiver');

export interface OtlpReceiverOptions {
  port: number;
  forwardEndpoint: string | null;
  forwardHeaders: Record<string, string>;
  enrichmentAttributes: Record<string, string>;
}

export class OtlpReceiver {
  private readonly options: OtlpReceiverOptions;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(options: OtlpReceiverOptions) {
    this.options = options;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.on('error', reject);
      this.server.listen(this.options.port, () => {
        logger.info('OTLP receiver listening', { port: this.options.port });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise(resolve => {
      if (!this.server) { resolve(); return; }
      this.server.close(() => resolve());
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = req.url ?? '';
    if (!['POST'].includes(req.method ?? '') || !path.startsWith('/v1/')) {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      const body = await this.readBody(req);
      const enriched = this.enrichPayload(body);

      if (this.options.forwardEndpoint) {
        const result = await this.forward(enriched, path);
        res.writeHead(result.statusCode ?? 200, { 'Content-Type': 'application/json' });
        res.end(result.body);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
    } catch (err) {
      logger.error('OTLP receiver error', { err });
      res.writeHead(500);
      res.end();
    }
  }

  private async readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  private enrichPayload(body: Buffer): Buffer {
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
  ): Promise<{ statusCode: number; body: string }> {
    const url = `${this.options.forwardEndpoint}${path}`;
    const response = await globalThis.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.options.forwardHeaders,
      },
      body,
    });
    const responseBody = await response.text();
    return { statusCode: response.status, body: responseBody };
  }
}
```

---

## Step 3 — Wire into `ProxyManager`

### 3a — Extend `ProxyManagerOptions`

`ProxyManager` only receives `ProxyManagerOptions` — it has no reference to `McpServerConfig`. Add these optional fields to the `ProxyManagerOptions` interface in `proxy-manager.ts`:

```typescript
readonly otlpReceiverEnabled?: boolean;
readonly otlpReceiverPort?: number;
readonly otlpForwardEndpoint?: string | null;
readonly otlpForwardHeaders?: Record<string, string>;
readonly otlpEnrichmentAttributes?: Record<string, string>;
```

### 3b — Add the receiver field to `ProxyManager`

Add this private field to the `ProxyManager` class alongside the existing field declarations:

```typescript
private otlpReceiver: OtlpReceiver | null = null;
```

### 3c — Start the receiver in `ProxyManager.start()`

At the end of `ProxyManager.start()`, after the HTTP server is started, add:

```typescript
if (this.options.otlpReceiverEnabled) {
  try {
    const receiver = new OtlpReceiver({
      port: this.options.otlpReceiverPort ?? 4318,
      forwardEndpoint: this.options.otlpForwardEndpoint ?? null,
      forwardHeaders: this.options.otlpForwardHeaders ?? {},
      enrichmentAttributes: this.options.otlpEnrichmentAttributes ?? {},
    });
    await receiver.start();
    this.otlpReceiver = receiver;
  } catch (err) {
    logger.warn('OTLP receiver failed to start — disabled', { error: String(err) });
  }
}
```

The try/catch handles the SSRF validation error from Step 4: if `OtlpReceiver`'s constructor throws, the warning is logged and the receiver is simply not started (the proxy continues normally).

### 3d — Stop the receiver in `ProxyManager.stop()`

Add before the upstream disconnect loop:

```typescript
if (this.otlpReceiver) {
  await this.otlpReceiver.stop();
  this.otlpReceiver = null;
}
```

### 3e — Wire from `index.ts`

In the proxy mode block of `packages/nr-ai-mcp-server/src/index.ts` (the `else` branch of `if (options.stdio)`), add `const sessionTraceId = randomUUID();` before constructing `ProxyManager` (the import is already at the top of the file). Then pass the new options:

```typescript
const sessionTraceId = randomUUID();

proxyManager = new ProxyManager({
  port: config.port,
  onToolCall: ...,
  onRequest: ...,
  otlpReceiverEnabled: config.otlpReceiverEnabled,
  otlpReceiverPort: config.otlpReceiverPort,
  otlpForwardEndpoint: config.otlpForwardEndpoint,
  otlpForwardHeaders: config.licenseKey ? { 'api-key': config.licenseKey } : {},
  otlpEnrichmentAttributes: {
    'ai.session.id': sessionTraceId,
    'ai.developer': config.developer,
    ...(config.projectId && { 'ai.project_id': config.projectId }),
    ...(config.teamId && { 'ai.team_id': config.teamId }),
  },
});
```

---

## Step 4 — SSRF guard

Before making outbound forward requests in `OtlpReceiver.forward()`, validate that `otlpForwardEndpoint` is not an RFC-1918 or loopback address. Reuse the SSRF validation logic already present in `packages/nr-ai-mcp-server/src/proxy/upstream-http.ts`. Extract the validation to a shared utility in `packages/nr-ai-mcp-server/src/security/` if not already there.

The receiver must reject any `otlpForwardEndpoint` that resolves to a private IP at construction time (not at request time) — **throw an `Error`** in the constructor if the endpoint fails validation. The caller in `ProxyManager.start()` (Step 3c) catches this error, logs a warning, and skips starting the receiver. Do not try to mutate `otlpReceiverEnabled` — `OtlpReceiver` has no reference to `McpServerConfig`.

---

## Step 5 — Write tests

Create `packages/nr-ai-mcp-server/src/proxy/otlp-receiver.test.ts`.

Key test cases:

- `enrichPayload` — injects `ai.session.id` into `resourceSpans[0].resource.attributes`
- `enrichPayload` — handles `resourceMetrics` and `resourceLogs` structures
- `enrichPayload` — passes non-JSON (Buffer with arbitrary bytes) through unchanged
- `handleRequest` — returns 404 for non-POST requests
- `handleRequest` — returns 404 for unrecognized paths
- `start()` / `stop()` — server starts on configured port, `stop()` closes it
- `stop()` without prior `start()` — resolves immediately without throwing

Mock `globalThis.fetch` for forwarding tests — do not make real network requests.

```typescript
const mockFetch = jest.fn<Promise<Response>, unknown[]>().mockResolvedValue({
  status: 200,
  text: async () => '{}',
} as Response);
(globalThis as { fetch?: unknown }).fetch = mockFetch;
```

---

## Acceptance criteria

- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] When `otlpReceiverEnabled: false` (default), no extra HTTP server starts
- [ ] When `otlpReceiverEnabled: true`, an HTTP server starts on `otlpReceiverPort` (default 4318)
- [ ] `POST /v1/traces` with JSON-encoded OTLP body receives `ai.session.id` in every resource's attributes
- [ ] `POST /v1/metrics` and `POST /v1/logs` are also enriched
- [ ] Protobuf-encoded payloads (non-JSON) are forwarded as-is without modification
- [ ] Enriched payload is forwarded to `otlpForwardEndpoint` with the NR license key as `api-key` header
- [ ] When `otlpForwardEndpoint` is `null`, payload is accepted and dropped (200 returned to caller, no forward)
- [ ] Private/loopback `otlpForwardEndpoint` is rejected at startup with a warning log and receiver disabled
- [ ] `OtlpReceiver.stop()` is called during server shutdown
- [ ] `npm run lint` passes

---

## File checklist

Files to **create**:

```
packages/nr-ai-mcp-server/src/proxy/otlp-receiver.ts
packages/nr-ai-mcp-server/src/proxy/otlp-receiver.test.ts
```

Files to **modify**:

```
packages/nr-ai-mcp-server/src/config.ts              — add otlpReceiverEnabled, otlpReceiverPort, otlpForwardEndpoint
packages/nr-ai-mcp-server/src/proxy/proxy-manager.ts — extend ProxyManagerOptions; add otlpReceiver field; instantiate and wire OtlpReceiver in start()/stop()
packages/nr-ai-mcp-server/src/index.ts               — generate sessionTraceId in proxy mode; pass new otlp* fields to ProxyManagerOptions
```
