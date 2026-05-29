import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticHandler } from './static-handler.js';
import { IncomingMessage, ServerResponse } from 'node:http';

function makeReqRes(url: string): { req: IncomingMessage; res: ServerResponse; chunks: Buffer[]; status: () => number; headers: () => Record<string, string> } {
  const chunks: Buffer[] = [];
  let status = 0;
  const headers: Record<string, string> = {};
  const req = { url, method: 'GET' } as IncomingMessage;
  const res = {
    writeHead: (s: number, h?: Record<string, string>) => {
      status = s;
      if (h) Object.assign(headers, h);
    },
    setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; },
    end: (chunk?: Buffer | string) => {
      if (chunk) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    },
    headersSent: false,
  } as unknown as ServerResponse;
  return { req, res, chunks, status: () => status, headers: () => headers };
}

describe('static-handler', () => {
  it('serves index.html for GET /', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><h1>Hi</h1>');
    const handler = createStaticHandler(dir);
    const { req, res, chunks, status, headers } = makeReqRes('/');
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/text\/html/);
    expect(Buffer.concat(chunks).toString()).toContain('<h1>Hi</h1>');
  });

  it('serves assets/ files with correct content-type', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'static-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'main.js'), 'console.log(1)');
    const handler = createStaticHandler(dir);
    const { req, res, chunks, status, headers } = makeReqRes('/assets/main.js');
    await handler(req, res);
    expect(status()).toBe(200);
    expect(headers()['content-type']).toMatch(/javascript/);
    expect(Buffer.concat(chunks).toString()).toBe('console.log(1)');
  });

  it('returns 404 for missing files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    const handler = createStaticHandler(dir);
    const { req, res, status } = makeReqRes('/missing.js');
    await handler(req, res);
    expect(status()).toBe(404);
  });

  it('rejects path traversal (../)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    const handler = createStaticHandler(dir);
    const { req, res, status } = makeReqRes('/../../etc/passwd');
    await handler(req, res);
    expect(status()).toBe(403);
  });
});
