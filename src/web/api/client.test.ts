import { fetchSessionCurrent, fetchAuditLog, qk } from './client';

describe('api/client', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetchSessionCurrent calls /api/session/current and returns JSON', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 'x' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch;
    const result = await fetchSessionCurrent();
    expect(result).toEqual({ id: 'x' });
  });

  it('throws when response status is not 2xx', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response('boom', { status: 503 }))) as typeof globalThis.fetch;
    await expect(fetchSessionCurrent()).rejects.toThrow(/503/);
  });

  it('fetchAuditLog hits /api/audit', async () => {
    let calledWith = '';
    globalThis.fetch = ((u: string) => {
      calledWith = u;
      return Promise.resolve(
        new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof globalThis.fetch;
    await fetchAuditLog();
    expect(calledWith).toBe('/api/audit');
  });

  it('qk produces stable React Query keys', () => {
    expect(qk.sessionCurrent).toEqual(['session', 'current']);
    expect(qk.audit).toEqual(['audit']);
    expect(qk.sessionDetail('abc')).toEqual(['session', 'abc']);
  });

  it('qk.sessionsList differs by limit so the React Query cache does not collide', () => {
    expect(qk.sessionsList(50)).toEqual(['sessions', 'list', 50]);
    expect(qk.sessionsList(200)).toEqual(['sessions', 'list', 200]);
    expect(qk.sessionsList(50)).not.toEqual(qk.sessionsList(200));
  });
});
