import { render, screen } from '@testing-library/react';
import { vi, type MockInstance } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

function Boom({ message }: { message: string }): JSX.Element {
  throw new Error(message);
}

describe('ErrorBoundary', () => {
  let consoleSpy: MockInstance;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <div>healthy</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('healthy')).toBeInTheDocument();
  });

  it('renders the fallback UI with the error message when a child throws', () => {
    render(
      <ErrorBoundary>
        <Boom message="kaboom" />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('kaboom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
  });

  it('resets when resetKey changes (e.g. route change)', () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/a">
        <Boom message="route-a-error" />
      </ErrorBoundary>,
    );
    expect(screen.getByText('route-a-error')).toBeInTheDocument();

    rerender(
      <ErrorBoundary resetKey="/b">
        <div>route-b-content</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('route-b-content')).toBeInTheDocument();
    expect(screen.queryByText('route-a-error')).not.toBeInTheDocument();
  });

  it('logs the caught error via componentDidCatch with our specific message', () => {
    // React itself calls console.error on uncaught render errors in dev mode,
    // so a bare `toHaveBeenCalled()` would pass vacuously. Assert on the
    // exact message string we emit from componentDidCatch.
    render(
      <ErrorBoundary>
        <Boom message="logged-error" />
      </ErrorBoundary>,
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      'ErrorBoundary caught a render error',
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });
});
