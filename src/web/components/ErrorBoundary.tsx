import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  /** A key that changes between routes — when it changes, the boundary resets so a sticky error in one view doesn't survive across navigation. */
  resetKey?: string | number;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render-time errors anywhere in the subtree and renders a recoverable
 * fallback UI instead of letting React unmount the entire root and white-screen
 * the dashboard. See finding F-004.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to dev tooling — this is intentionally console.error so the dev
    // console keeps its red entry; the dashboard runs in the browser, so a
    // server-side project logger isn't applicable here.
    console.error('ErrorBoundary caught a render error', { error, info });
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleDismiss = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div role="alert" className="flex justify-center p-8">
        <div className="max-w-2xl w-full bg-bg-panel border border-accent-red/60 rounded-lg p-6 space-y-4">
          <div>
            <div className="text-accent-red font-semibold uppercase text-xs tracking-wider mb-1">
              Render error
            </div>
            <div className="text-ink-fg text-base font-mono break-all">{error.message}</div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={this.handleReload}
              className="px-3 py-1.5 text-sm bg-bg-line hover:bg-accent-blue/30 text-ink-fg rounded border border-bg-line"
            >
              Reload page
            </button>
            <button
              type="button"
              onClick={this.handleDismiss}
              className="px-3 py-1.5 text-sm bg-bg-line/50 hover:bg-bg-line text-ink-muted rounded border border-bg-line"
            >
              Dismiss
            </button>
          </div>
          {error.stack && (
            <details className="text-xs text-ink-muted">
              <summary className="cursor-pointer select-none">Stack trace</summary>
              <pre className="mt-2 p-2 bg-bg-line/30 rounded overflow-x-auto whitespace-pre-wrap break-all">
                {error.stack}
              </pre>
            </details>
          )}
        </div>
      </div>
    );
  }
}
