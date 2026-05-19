export interface AppConfig {
  readonly appId: string;
  readonly privateKey: string;
  readonly webhookSecret: string;
  readonly newRelicApiKey: string;
  readonly newRelicAccountId: number;
  readonly reportHours: number;
  readonly failBelow: number | null;
  readonly port: number;
}

function parseIntEnv(name: string, value: string): number {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    process.stderr.write(`Error: ${name} must be a number\n`);
    process.exit(1);
  }
  return parsed;
}

export function loadConfig(): AppConfig {
  const required: Record<string, string | undefined> = {
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    NEW_RELIC_API_KEY: process.env.NEW_RELIC_API_KEY,
    NEW_RELIC_ACCOUNT_ID: process.env.NEW_RELIC_ACCOUNT_ID,
  };

  for (const [key, value] of Object.entries(required)) {
    if (!value) {
      process.stderr.write(`Error: ${key} environment variable is required\n`);
      process.exit(1);
    }
  }

  const accountId = parseIntEnv('NEW_RELIC_ACCOUNT_ID', process.env.NEW_RELIC_ACCOUNT_ID!);

  const failBelowStr = process.env.NR_AI_REPORT_FAIL_BELOW;
  let failBelow: number | null = null;
  if (failBelowStr) {
    const parsed = parseFloat(failBelowStr);
    if (isNaN(parsed)) {
      process.stderr.write('Error: NR_AI_REPORT_FAIL_BELOW must be a number\n');
      process.exit(1);
    }
    failBelow = parsed;
  }

  return {
    appId: process.env.GITHUB_APP_ID!,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, '\n'),
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,
    newRelicApiKey: process.env.NEW_RELIC_API_KEY!,
    newRelicAccountId: accountId,
    reportHours: parseIntEnv('NR_AI_REPORT_HOURS', process.env.NR_AI_REPORT_HOURS ?? '24'),
    failBelow,
    port: parseIntEnv('PORT', process.env.PORT ?? '3000'),
  };
}
