import { useEffect } from 'react';
import { useLiveStore } from '../store/liveStore';

export function useLiveEvents(url: string = '/sse'): void {
  useEffect(() => {
    const es = new EventSource(url);

    es.onopen = (): void => useLiveStore.getState().setConnected(true);
    es.onerror = (): void => useLiveStore.getState().setConnected(false);

    // F-019: read live state inside each callback rather than capturing
    // a one-time snapshot at effect-run time. Zustand action references
    // are stable today, but a future memoization or selector wrapper
    // would silently break the captured-snapshot pattern.
    const onToolCall = (e: MessageEvent): void => {
      try {
        useLiveStore.getState().pushToolCall(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    const onCost = (e: MessageEvent): void => {
      try {
        useLiveStore.getState().setCost(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    const onAnti = (e: MessageEvent): void => {
      try {
        useLiveStore.getState().pushAntiPattern(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    const onAlert = (e: MessageEvent): void => {
      try {
        useLiveStore.getState().addOrUpdateAlert(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };

    es.addEventListener('tool-call', onToolCall as EventListener);
    es.addEventListener('cost-update', onCost as EventListener);
    es.addEventListener('anti-pattern', onAnti as EventListener);
    es.addEventListener('alert', onAlert as EventListener);

    return (): void => {
      es.removeEventListener('tool-call', onToolCall as EventListener);
      es.removeEventListener('cost-update', onCost as EventListener);
      es.removeEventListener('anti-pattern', onAnti as EventListener);
      es.removeEventListener('alert', onAlert as EventListener);
      es.close();
    };
  }, [url]);
}
