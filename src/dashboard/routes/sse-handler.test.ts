import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { LiveEventBus } from '../live-event-bus.js';
import { createSseHandler } from './sse-handler.js';

function startTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      void handler(req, res);
    });
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => s.close(() => r())),
      });
    });
  });
}

async function readSseChunks(res: Response, count: number, timeoutMs = 1000): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (chunks.length < count && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((r) =>
        setTimeout(() => r({ value: undefined, done: true }), 100),
      ),
    ]);
    if (done) break;
    if (value) chunks.push(decoder.decode(value));
  }
  void reader.cancel();
  return chunks;
}

describe('sse-handler', () => {
  it('responds with text/event-stream and Cache-Control: no-cache', async () => {
    const bus = new LiveEventBus();
    const server = await startTestServer(createSseHandler(bus));
    try {
      const res = await fetch(`${server.url}/sse`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/event-stream/);
      expect(res.headers.get('cache-control')).toMatch(/no-cache/);
      void res.body?.cancel();
    } finally {
      await server.close();
    }
  });

  it('forwards bus emissions as SSE frames', async () => {
    const bus = new LiveEventBus();
    const server = await startTestServer(createSseHandler(bus));
    try {
      const res = await fetch(`${server.url}/sse`);
      // Give the server a moment to attach the listener before emitting
      await new Promise((r) => setTimeout(r, 30));
      bus.emit('tool-call', { id: 'a', tool: 'Read', durationMs: 1, costUsd: 0, ts: 1 });
      bus.emit('cost-update', { sessionTotalUsd: 1, todayTotalUsd: 2, forecastEodUsd: null });
      const chunks = await readSseChunks(res, 2);
      const merged = chunks.join('');
      expect(merged).toContain('event: tool-call');
      expect(merged).toContain('"tool":"Read"');
      expect(merged).toContain('event: cost-update');
    } finally {
      await server.close();
    }
  });

  it('replays buffered events when Last-Event-ID header is set', async () => {
    const bus = new LiveEventBus();
    bus.emit('tool-call', { id: 'a', tool: 'Read', durationMs: 1, costUsd: 0, ts: 1 });
    bus.emit('tool-call', { id: 'b', tool: 'Edit', durationMs: 2, costUsd: 0, ts: 2 });
    const server = await startTestServer(createSseHandler(bus));
    try {
      // seq starts at 1, so 'a' has seq=1 and 'b' has seq=2. Client has
      // already received seq=1 ('a'); ask for events with seq > 1.
      const res = await fetch(`${server.url}/sse`, { headers: { 'last-event-id': '1' } });
      const chunks = await readSseChunks(res, 1);
      const merged = chunks.join('');
      expect(merged).toContain('"id":"b"');
      expect(merged).not.toContain('"id":"a"');
    } finally {
      await server.close();
    }
  });

  it('Last-Event-ID: 0 replays everything (sentinel for "nothing seen")', async () => {
    const bus = new LiveEventBus();
    bus.emit('tool-call', { id: 'a', tool: 'Read', durationMs: 1, costUsd: 0, ts: 1 });
    bus.emit('tool-call', { id: 'b', tool: 'Edit', durationMs: 2, costUsd: 0, ts: 2 });
    const server = await startTestServer(createSseHandler(bus));
    try {
      const res = await fetch(`${server.url}/sse`, { headers: { 'last-event-id': '0' } });
      const chunks = await readSseChunks(res, 2);
      const merged = chunks.join('');
      expect(merged).toContain('"id":"a"');
      expect(merged).toContain('"id":"b"');
    } finally {
      await server.close();
    }
  });
});
