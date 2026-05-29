import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Today } from './Today';
import { useLiveStore } from '../store/liveStore';

function renderToday() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <Today />
    </QueryClientProvider>,
  );
}

describe('Today view', () => {
  beforeEach(() => {
    useLiveStore.setState({
      connected: true,
      recentToolCalls: [
        { id: 'a', tool: 'Read', durationMs: 120, costUsd: 0.001, ts: 1 },
        { id: 'b', tool: 'Edit', durationMs: 85, costUsd: 0.002, ts: 2 },
      ],
      cost: { sessionTotalUsd: 3.42, todayTotalUsd: 12.17, forecastEodUsd: 18.4 },
      antiPatterns: [{ type: 'thrashing', target: 'auth.ts', count: 4 }],
    });
  });

  it('renders the four KPI labels', () => {
    renderToday();
    expect(screen.getByText('spend')).toBeInTheDocument();
    expect(screen.getByText('calls')).toBeInTheDocument();
    expect(screen.getByText('eff.')).toBeInTheDocument();
    expect(screen.getByText('flags')).toBeInTheDocument();
  });

  it('renders today total cost in the spend KPI', () => {
    renderToday();
    expect(screen.getByText('$12.17')).toBeInTheDocument();
  });

  it('renders the recent tool calls table', () => {
    renderToday();
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
  });

  it('renders an anti-pattern banner when patterns exist', () => {
    renderToday();
    expect(screen.getByText(/thrashing/i)).toBeInTheDocument();
    expect(screen.getByText(/auth\.ts/)).toBeInTheDocument();
  });

  it('hides the banner when no anti-patterns', () => {
    useLiveStore.setState({ antiPatterns: [] });
    renderToday();
    expect(screen.queryByText(/thrashing/i)).toBeNull();
  });

  it('renders the forecast-EOD card with the projected end-of-day spend', () => {
    renderToday();
    expect(screen.getByText(/forecast/i)).toBeInTheDocument();
    expect(screen.getByText('$18.40')).toBeInTheDocument();
  });

  it('shows the delta from current spend to forecast', () => {
    // todayTotal=12.17, forecastEodUsd=18.4 → delta=6.23
    renderToday();
    expect(screen.getByText(/\+\$6\.23/)).toBeInTheDocument();
  });

  it('shows an "insufficient data" message when forecast is null', () => {
    useLiveStore.setState({
      cost: { sessionTotalUsd: 3.42, todayTotalUsd: 12.17, forecastEodUsd: null },
    });
    renderToday();
    expect(screen.getByText(/insufficient data/i)).toBeInTheDocument();
    // Should not display a dollar value for the forecast.
    expect(screen.queryByText(/\$18\.40/)).toBeNull();
  });

  it('shows insufficient-data when cost has not loaded', () => {
    useLiveStore.setState({ cost: null });
    renderToday();
    expect(screen.getByText(/insufficient data/i)).toBeInTheDocument();
  });
});

describe('Today header timestamp', () => {
  beforeEach(() => {
    useLiveStore.setState({
      connected: true,
      recentToolCalls: [],
      cost: { sessionTotalUsd: 0, todayTotalUsd: 0, forecastEodUsd: null },
      antiPatterns: [],
    });
    vi.useFakeTimers();
    // 2026-05-29 14:00 local-ish — exact zone doesn't matter; the
    // assertion below only checks the value is stable across
    // re-renders, not what the formatted string contains.
    vi.setSystemTime(new Date('2026-05-29T18:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('memoizes the header timestamp across re-renders', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    const { rerender, container } = render(
      <QueryClientProvider client={qc}>
        <Today />
      </QueryClientProvider>,
    );

    const headerSpan = container.querySelector('header span')!;
    const before = headerSpan.textContent;
    expect(before).toBeTruthy();

    // Advance the system clock far enough that an unmemoized
    // timestamp would format to a different minute, then trigger
    // a re-render via a store update.
    vi.setSystemTime(new Date('2026-05-29T19:30:00Z'));
    act(() => {
      useLiveStore.setState({ antiPatterns: [{ type: 'flag', target: 'x', count: 1 }] });
    });
    rerender(
      <QueryClientProvider client={qc}>
        <Today />
      </QueryClientProvider>,
    );

    const after = container.querySelector('header span')!.textContent;
    expect(after).toBe(before);
  });
});
