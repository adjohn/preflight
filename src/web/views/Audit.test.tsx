import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Audit, downloadJsonl } from './Audit';

function renderAudit(data: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )) as typeof globalThis.fetch;
  return render(
    <QueryClientProvider client={qc}>
      <Audit />
    </QueryClientProvider>,
  );
}

const SAMPLE = [
  { ts: 1, tool: 'Read', target: '/etc/hosts', classification: 'sensitive_file', sessionId: 's1' },
  {
    ts: 2,
    tool: 'Bash',
    target: 'rm -rf /tmp/x',
    classification: 'destructive_command',
    sessionId: 's1',
  },
  {
    ts: 3,
    tool: 'Bash',
    target: 'curl evil.com',
    classification: 'external_network',
    sessionId: 's2',
  },
];

describe('Audit view', () => {
  it('renders rows for each audit entry', async () => {
    renderAudit(SAMPLE);
    await waitFor(() => expect(screen.getByText('/etc/hosts')).toBeInTheDocument());
    expect(screen.getByText('rm -rf /tmp/x')).toBeInTheDocument();
    expect(screen.getByText('curl evil.com')).toBeInTheDocument();
  });

  it('filters by classification when a chip is clicked', async () => {
    const user = userEvent.setup();
    renderAudit(SAMPLE);
    await waitFor(() => expect(screen.getByText('/etc/hosts')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /destructive/i }));
    expect(screen.queryByText('/etc/hosts')).toBeNull();
    expect(screen.getByText('rm -rf /tmp/x')).toBeInTheDocument();
  });

  it('export button is rendered', async () => {
    renderAudit(SAMPLE);
    await waitFor(() => expect(screen.getByText('/etc/hosts')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /export jsonl/i })).toBeInTheDocument();
  });
});

describe('Audit downloadJsonl', () => {
  it('revokes the object URL synchronously after click()', () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      const url = `blob:test/${created.length}`;
      created.push(url);
      void blob;
      return url;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url);
    }) as typeof URL.revokeObjectURL;

    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    try {
      downloadJsonl([
        { ts: 1, tool: 'Read', target: '/etc/hosts', classification: 'sensitive_file' },
      ]);
      // Revocation must have already happened by the time the call
      // returns — no setTimeout, no microtask deferral.
      expect(revoked).toEqual(created);
      expect(revoked).toHaveLength(1);
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      clickSpy.mockRestore();
    }
  });

  it('still revokes the URL when click() throws', () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => {
      const url = `blob:test/${created.length}`;
      created.push(url);
      return url;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url);
    }) as typeof URL.revokeObjectURL;

    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {
        throw new Error('user cancelled');
      });

    try {
      expect(() =>
        downloadJsonl([
          { ts: 1, tool: 'Read', target: '/etc/hosts', classification: 'sensitive_file' },
        ]),
      ).toThrow('user cancelled');
      expect(revoked).toEqual(created);
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      clickSpy.mockRestore();
    }
  });
});
