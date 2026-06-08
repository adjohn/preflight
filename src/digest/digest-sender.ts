export async function sendSlackDigest(
  webhookUrl: string,
  payload: Record<string, unknown>,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    throw new Error('Invalid webhook URL: must be a valid https://hooks.slack.com/ URL');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'hooks.slack.com') {
    throw new Error('Invalid webhook URL: must be a valid https://hooks.slack.com/ URL');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`Slack webhook returned ${resp.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
