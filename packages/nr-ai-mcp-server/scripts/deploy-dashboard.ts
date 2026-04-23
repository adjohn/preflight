#!/usr/bin/env npx tsx
/**
 * Deploy an AI Coding Assistant dashboard to a New Relic account.
 *
 * Usage:
 *   NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx scripts/deploy-dashboard.ts [options] [dashboard-file]
 *
 * Arguments:
 *   dashboard-file  Name of the JSON file in the dashboards/ directory.
 *                   Defaults to "ai-coding-assistant-overview.json".
 *   --all           Deploy all dashboard JSON files in the dashboards/ directory.
 *   --print         Print the JSON with accountIds filled in (for NR UI import) and exit.
 *
 * Examples:
 *   npx tsx scripts/deploy-dashboard.ts
 *   npx tsx scripts/deploy-dashboard.ts ai-coding-assistant-team-view.json
 *   npx tsx scripts/deploy-dashboard.ts --all
 *   NEW_RELIC_ACCOUNT_ID=12345 npx tsx scripts/deploy-dashboard.ts --print
 *   NEW_RELIC_ACCOUNT_ID=12345 npx tsx scripts/deploy-dashboard.ts --print ai-coding-assistant-team-view.json
 *
 * Requires a New Relic User API key (not a license key).
 * For --print, only NEW_RELIC_ACCOUNT_ID is required (no API key needed).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const NERDGRAPH_URL = 'https://api.newrelic.com/graphql';

export const CREATE_MUTATION = `
mutation DashboardCreate($accountId: Int!, $dashboard: DashboardInput!) {
  dashboardCreate(accountId: $accountId, dashboard: $dashboard) {
    entityResult {
      guid
      name
    }
    errors {
      description
      type
    }
  }
}`;

interface DashboardJson {
  name: string;
  description?: string;
  permissions?: string;
  pages: Array<{
    name: string;
    description?: string;
    widgets: Array<{
      title: string;
      layout: { column: number; row: number; width: number; height: number };
      visualization: { id: string };
      rawConfiguration: {
        nrqlQueries: Array<{ accountIds: number[]; query: string }>;
        [key: string]: unknown;
      };
    }>;
  }>;
}

function injectAccountId(dashboard: DashboardJson, accountId: number): DashboardJson {
  const copy: DashboardJson = JSON.parse(JSON.stringify(dashboard));
  for (const page of copy.pages) {
    for (const widget of page.widgets) {
      for (const nrqlQuery of widget.rawConfiguration.nrqlQueries) {
        nrqlQuery.accountIds = [accountId];
      }
    }
  }
  return copy;
}

async function deployDashboard(apiKey: string, accountId: number, dashboardFile: string): Promise<void> {
  const dashboardPath = resolve(__dirname, '..', 'dashboards', dashboardFile);
  const raw = readFileSync(dashboardPath, 'utf-8');
  const dashboard = injectAccountId(JSON.parse(raw) as DashboardJson, accountId);

  console.log(`Deploying dashboard "${dashboard.name}" to account ${accountId}...`);

  const response = await fetch(NERDGRAPH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'API-Key': apiKey,
    },
    body: JSON.stringify({
      query: CREATE_MUTATION,
      variables: { accountId, dashboard },
    }),
  });

  if (!response.ok) {
    console.error(`HTTP error: ${response.status} ${response.statusText}`);
    const body = await response.text();
    console.error(body);
    process.exit(1);
  }

  const result = await response.json() as {
    data?: {
      dashboardCreate?: {
        entityResult?: { guid: string; name: string } | null;
        errors?: Array<{ description: string; type: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (result.errors?.length) {
    console.error('GraphQL errors:', JSON.stringify(result.errors, null, 2));
    process.exit(1);
  }

  const createResult = result.data?.dashboardCreate;
  if (createResult?.errors?.length) {
    console.error('Dashboard creation errors:', JSON.stringify(createResult.errors, null, 2));
    process.exit(1);
  }

  const entity = createResult?.entityResult;
  if (entity) {
    console.log(`  ✓ ${entity.name}`);
    console.log(`    GUID: ${entity.guid}`);
    console.log(`    URL:  https://one.newrelic.com/dashboards/detail/${entity.guid}`);
  } else {
    console.error('Unexpected response — no entity result returned');
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const printOnly = args.includes('--print');
  const deployAll = args.includes('--all');
  const fileArgs = args.filter((a: string) => !a.startsWith('--'));

  const accountIdStr = process.env.NEW_RELIC_ACCOUNT_ID;
  if (!accountIdStr) {
    console.error('Error: NEW_RELIC_ACCOUNT_ID environment variable is required');
    process.exit(1);
  }
  const accountId = parseInt(accountIdStr, 10);
  if (Number.isNaN(accountId)) {
    console.error(`Error: NEW_RELIC_ACCOUNT_ID must be a number, got: ${accountIdStr}`);
    process.exit(1);
  }

  const dashboardsDir = resolve(__dirname, '..', 'dashboards');

  if (printOnly) {
    // Output UI-ready JSON (accountIds filled in) for copy-paste into NR UI import dialog
    const files = deployAll
      ? readdirSync(dashboardsDir).filter((f: string) => f.endsWith('.json'))
      : [fileArgs[0] ?? 'ai-coding-assistant-overview.json'];

    for (const file of files) {
      const raw = readFileSync(resolve(dashboardsDir, file), 'utf-8');
      const dashboard = injectAccountId(JSON.parse(raw) as DashboardJson, accountId);
      if (files.length > 1) {
        console.log(`\n// ─── ${file} ───`);
      }
      console.log(JSON.stringify(dashboard, null, 2));
    }
    return;
  }

  const apiKey = process.env.NEW_RELIC_API_KEY;
  if (!apiKey) {
    console.error('Error: NEW_RELIC_API_KEY environment variable is required (User API key, not license key)');
    console.error('       To print JSON for UI import instead, use --print (no API key needed)');
    process.exit(1);
  }

  const files = deployAll
    ? readdirSync(dashboardsDir).filter((f: string) => f.endsWith('.json'))
    : [fileArgs[0] ?? 'ai-coding-assistant-overview.json'];

  for (const file of files) {
    await deployDashboard(apiKey, accountId, file);
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Failed to deploy dashboard:', err);
  process.exit(1);
});
