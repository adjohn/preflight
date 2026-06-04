import { createLogger } from '../shared/index.js';

const logger = createLogger('key-validator');

const EVENTS_API_HOSTS: Record<string, string> = {
  eu: 'insights-collector.eu01.nr-data.net',
  staging: 'staging-insights-collector.newrelic.com',
  gov: 'gov-insights-collector.newrelic.com',
  us: 'insights-collector.newrelic.com',
};

const NERDGRAPH_URLS: Record<string, string> = {
  eu: 'https://api.eu.newrelic.com/graphql',
  staging: 'https://staging-api.newrelic.com/graphql',
  gov: 'https://api.newrelic.com/graphql',
  us: 'https://api.newrelic.com/graphql',
};

export function getEventsApiUrl(accountId: string, collectorHost: string | null): string {
  const host = EVENTS_API_HOSTS[collectorHost ?? 'us'] ?? EVENTS_API_HOSTS['us'];
  return `https://${host}/v1/accounts/${accountId}/events`;
}

export function getNerdgraphUrl(collectorHost: string | null): string {
  return NERDGRAPH_URLS[collectorHost ?? 'us'] ?? NERDGRAPH_URLS['us'];
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly detail?: string;
  readonly reason?: 'unauthorized' | 'timeout' | 'network' | 'server-error';
}

export async function validateLicenseKey(params: {
  licenseKey: string;
  accountId: string;
  collectorHost: string | null;
  timeoutMs?: number;
}): Promise<ValidationResult> {
  const { licenseKey, accountId, collectorHost, timeoutMs = 5000 } = params;
  const url = getEventsApiUrl(accountId, collectorHost);
  const body = JSON.stringify([{ eventType: 'NrAiObserveSetupCheck', setupCheck: true }]);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-Insert-Key': licenseKey, 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    if (res.status === 200) return { valid: true };
    if (res.status === 403 || res.status === 401) {
      return {
        valid: false,
        reason: 'unauthorized',
        detail: 'key rejected (HTTP ' + String(res.status) + ')',
      };
    }
    return { valid: false, reason: 'server-error', detail: 'HTTP ' + String(res.status) };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        valid: false,
        reason: 'timeout',
        detail: 'no response within ' + String(timeoutMs) + 'ms',
      };
    }
    logger.warn('license key validation network error', { err: String(err) });
    return {
      valid: false,
      reason: 'network',
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function validateApiKey(params: {
  nrApiKey: string;
  collectorHost: string | null;
  timeoutMs?: number;
}): Promise<ValidationResult> {
  const { nrApiKey, collectorHost, timeoutMs = 5000 } = params;
  const url = getNerdgraphUrl(collectorHost);
  const body = JSON.stringify({ query: '{ actor { user { email } } }' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Api-Key': nrApiKey, 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    if (res.status === 403 || res.status === 401) {
      return {
        valid: false,
        reason: 'unauthorized',
        detail: 'key rejected (HTTP ' + String(res.status) + ')',
      };
    }
    if (res.status !== 200) {
      return { valid: false, reason: 'server-error', detail: 'HTTP ' + String(res.status) };
    }
    const json = (await res.json()) as {
      data?: { actor?: { user?: { email?: string } } };
      errors?: unknown[];
    };
    if (json.errors?.length) {
      return { valid: false, reason: 'unauthorized', detail: 'API returned errors' };
    }
    const email = json.data?.actor?.user?.email;
    return { valid: true, detail: email };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        valid: false,
        reason: 'timeout',
        detail: 'no response within ' + String(timeoutMs) + 'ms',
      };
    }
    logger.warn('API key validation network error', { err: String(err) });
    return {
      valid: false,
      reason: 'network',
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
