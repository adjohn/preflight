import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sessions } from './Sessions';

interface DetailMap {
  readonly [sessionId: string]: unknown;
}

function renderSessions(listData: unknown, detailMap: DetailMap = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  globalThis.fetch = ((url: string) => {
    if (url.startsWith('/api/sessions/')) {
      const id = decodeURIComponent(url.split('/').pop() ?? '');
      const detail = detailMap[id] ?? { sessionId: id, toolCalls: [] };
      return Promise.resolve(
        new Response(JSON.stringify(detail), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(listData), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof globalThis.fetch;
  return render(
    <QueryClientProvider client={qc}>
      <Sessions />
    </QueryClientProvider>,
  );
}

const SAMPLE_LIST = [
  {
    sessionId: 's1',
    startTime: '2026-05-28T09:00:00Z',
    toolCallCount: 42,
    estimatedCostUsd: 1.23,
    outcome: 'feature',
  },
  {
    sessionId: 's2',
    startTime: '2026-05-27T15:30:00Z',
    toolCallCount: 18,
    estimatedCostUsd: 0.45,
    outcome: 'bug_fix',
  },
];

describe('Sessions view', () => {
  it('renders one row per session in the list', async () => {
    renderSessions(SAMPLE_LIST);
    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    expect(screen.getByText(/s2/)).toBeInTheDocument();
  });

  it('shows tool-call count and cost per row', async () => {
    renderSessions(SAMPLE_LIST);
    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    expect(screen.getByText('42 calls')).toBeInTheDocument();
    expect(screen.getByText('$1.23')).toBeInTheDocument();
  });

  it('shows an empty-state message when list is empty', async () => {
    renderSessions([]);
    await waitFor(() => expect(screen.getByText(/no sessions yet/i)).toBeInTheDocument());
  });

  it('shows a placeholder until a session is selected', async () => {
    renderSessions(SAMPLE_LIST);
    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    expect(screen.getByText(/pick a session on the left/i)).toBeInTheDocument();
  });

  it('shows the empty-timeline message when the selected session has no tool calls', async () => {
    renderSessions(SAMPLE_LIST, { s1: { sessionId: 's1', toolCalls: [] } });
    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    fireEvent.click(screen.getAllByText(/s1/)[0]);
    await waitFor(() =>
      expect(screen.getByText(/no tool calls in this session/i)).toBeInTheDocument(),
    );
  });

  it('renders one timeline row per tool call with name and duration', async () => {
    const detail = {
      sessionId: 's1',
      toolCalls: [
        { toolName: 'Read', durationMs: 120, startTime: 1_000, endTime: 1_120 },
        { toolName: 'Edit', durationMs: 240, startTime: 1_200, endTime: 1_440 },
        { toolName: 'Bash', durationMs: 80, startTime: 1_500, endTime: 1_580 },
      ],
    };
    renderSessions(SAMPLE_LIST, { s1: detail });
    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    fireEvent.click(screen.getAllByText(/s1/)[0]);
    await waitFor(() => expect(screen.getByText('Read')).toBeInTheDocument());
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText('120ms')).toBeInTheDocument();
    expect(screen.getByText('240ms')).toBeInTheDocument();
    expect(screen.getByText('80ms')).toBeInTheDocument();
  });

  it('shows the timeline header with session ID, call count, and span', async () => {
    const detail = {
      sessionId: 's1',
      toolCalls: [
        { toolName: 'Read', durationMs: 100, startTime: 0, endTime: 100 },
        { toolName: 'Edit', durationMs: 200, startTime: 1_000, endTime: 5_000 },
      ],
    };
    renderSessions(SAMPLE_LIST, { s1: detail });
    await waitFor(() => expect(screen.getByText(/s1/)).toBeInTheDocument());
    fireEvent.click(screen.getAllByText(/s1/)[0]);
    await waitFor(() =>
      expect(screen.getByText(/s1 · 2 calls · 5s/)).toBeInTheDocument(),
    );
  });
});
