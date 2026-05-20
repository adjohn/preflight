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
 *   --update        Update existing dashboards in-place (matched by name). Errors if not found.
 *   --teardown      Delete dashboards (matched by name). Skips files whose dashboard
 *                   does not exist. Mutually exclusive with --update and --print.
 *   --print         Print the JSON with accountIds filled in (for NR UI import) and exit.
 *   --staging       Target the New Relic staging API (staging-api.newrelic.com).
 *   --eu            Target the New Relic EU API (api.eu.newrelic.com). Mutually exclusive with --staging.
 *
 * Examples:
 *   npx tsx scripts/deploy-dashboard.ts
 *   npx tsx scripts/deploy-dashboard.ts ai-coding-assistant-team-view.json
 *   npx tsx scripts/deploy-dashboard.ts --all
 *   npx tsx scripts/deploy-dashboard.ts --all --update
 *   npx tsx scripts/deploy-dashboard.ts --update ai-coding-assistant-overview.json
 *   npx tsx scripts/deploy-dashboard.ts --all --teardown
 *   npx tsx scripts/deploy-dashboard.ts --teardown ai-coding-assistant-overview.json
 *   NEW_RELIC_ACCOUNT_ID=12345 npx tsx scripts/deploy-dashboard.ts --print
 *   NEW_RELIC_ACCOUNT_ID=12345 npx tsx scripts/deploy-dashboard.ts --print ai-coding-assistant-team-view.json
 *
 * Requires a New Relic User API key (not a license key).
 * For --print, only NEW_RELIC_ACCOUNT_ID is required (no API key needed).
 */

import 'dotenv/config';

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeDeveloperName } from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let NERDGRAPH_URL = 'https://api.newrelic.com/graphql';

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

const UPDATE_MUTATION = `
mutation DashboardUpdate($guid: EntityGuid!, $dashboard: DashboardInput!) {
  dashboardUpdate(guid: $guid, dashboard: $dashboard) {
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

const DELETE_MUTATION = `
mutation DashboardDelete($guid: EntityGuid!) {
  dashboardDelete(guid: $guid) {
    status
    errors {
      description
      type
    }
  }
}`;

const FIND_DASHBOARD_QUERY = `
query FindDashboard($query: String!) {
  actor {
    entitySearch(query: $query) {
      results {
        entities {
          guid
          name
        }
      }
    }
  }
}`;

interface DashboardVariable {
  name: string;
  type: string;
  nrqlQuery?: { accountIds: number[]; query: string };
  [key: string]: unknown;
}

interface DashboardJson {
  name: string;
  description?: string;
  permissions?: string;
  variables?: DashboardVariable[];
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
      for (const nrqlQuery of widget.rawConfiguration.nrqlQueries ?? []) {
        nrqlQuery.accountIds = [accountId];
      }
    }
  }
  for (const variable of copy.variables ?? []) {
    if (variable.nrqlQuery) {
      variable.nrqlQuery.accountIds = [accountId];
    }
  }
  return copy;
}

async function nerdgraphRequest<T>(apiKey: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(NERDGRAPH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'API-Key': apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body}`);
  }
  return response.json() as Promise<T>;
}

async function findDashboardGuid(apiKey: string, accountId: number, name: string): Promise<string | null> {
  const result = await nerdgraphRequest<{
    data?: { actor?: { entitySearch?: { results?: { entities?: Array<{ guid: string; name: string }> } } } };
  }>(apiKey, FIND_DASHBOARD_QUERY, {
    query: `type = 'DASHBOARD' AND name = '${name.replace(/'/g, "\\'")}' AND accountId = ${accountId}`,
  });
  const entities = result.data?.actor?.entitySearch?.results?.entities ?? [];
  return entities[0]?.guid ?? null;
}

function loadDashboard(dashboardFile: string, accountId: number): DashboardJson {
  const dashboardPath = resolve(__dirname, '..', 'dashboards', dashboardFile);
  const raw = readFileSync(dashboardPath, 'utf-8');
  return injectAccountId(JSON.parse(raw) as DashboardJson, accountId);
}

function injectDeveloperDefault(dashboard: DashboardJson, developer: string): void {
  if (!dashboard.variables) return;
  for (const variable of dashboard.variables) {
    if (variable.name === 'developer') {
      variable.defaultValues = [{ value: { string: developer } }];
      return;
    }
  }
}

function printEntity(entity: { guid: string; name: string }): void {
  console.log(`  ✓ ${entity.name}`);
  console.log(`    GUID: ${entity.guid}`);
  console.log(`    URL:  https://one.newrelic.com/dashboards/detail/${entity.guid}`);
}

async function deployDashboard(
  apiKey: string,
  accountId: number,
  dashboardFile: string,
  developerOverride: string | null,
): Promise<void> {
  const dashboard = loadDashboard(dashboardFile, accountId);
  if (developerOverride) {
    const normalised = normalizeDeveloperName(developerOverride);
    injectDeveloperDefault(dashboard, normalised);
    console.log(`  Developer default set to: ${normalised}`);
  }
  console.log(`Deploying dashboard "${dashboard.name}" to account ${accountId}...`);

  const result = await nerdgraphRequest<{
    data?: {
      dashboardCreate?: {
        entityResult?: { guid: string; name: string } | null;
        errors?: Array<{ description: string; type: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  }>(apiKey, CREATE_MUTATION, { accountId, dashboard });

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
    printEntity(entity);
  } else {
    console.error('Unexpected response — no entity result returned');
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
}

async function updateDashboard(
  apiKey: string,
  accountId: number,
  dashboardFile: string,
  developerOverride: string | null,
): Promise<void> {
  const dashboard = loadDashboard(dashboardFile, accountId);
  if (developerOverride) {
    const normalised = normalizeDeveloperName(developerOverride);
    injectDeveloperDefault(dashboard, normalised);
    console.log(`  Developer default set to: ${normalised}`);
  }
  console.log(`Looking up "${dashboard.name}" in account ${accountId}...`);

  const guid = await findDashboardGuid(apiKey, accountId, dashboard.name);
  if (!guid) {
    console.error(`  ✗ No existing dashboard found with name "${dashboard.name}". Use deploy (without --update) to create it.`);
    process.exit(1);
  }
  console.log(`  Found GUID: ${guid}`);
  console.log(`  Updating...`);

  const result = await nerdgraphRequest<{
    data?: {
      dashboardUpdate?: {
        entityResult?: { guid: string; name: string } | null;
        errors?: Array<{ description: string; type: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  }>(apiKey, UPDATE_MUTATION, { guid, dashboard });

  if (result.errors?.length) {
    console.error('GraphQL errors:', JSON.stringify(result.errors, null, 2));
    process.exit(1);
  }

  const updateResult = result.data?.dashboardUpdate;
  if (updateResult?.errors?.length) {
    console.error('Dashboard update errors:', JSON.stringify(updateResult.errors, null, 2));
    process.exit(1);
  }

  const entity = updateResult?.entityResult;
  if (entity) {
    printEntity(entity);
  } else {
    console.error('Unexpected response — no entity result returned');
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
}

async function teardownDashboard(
  apiKey: string,
  accountId: number,
  dashboardFile: string,
): Promise<void> {
  const dashboardPath = resolve(__dirname, '..', 'dashboards', dashboardFile);
  const raw = readFileSync(dashboardPath, 'utf-8');
  const dashboard = JSON.parse(raw) as DashboardJson;

  console.log(`Looking up "${dashboard.name}" in account ${accountId}...`);
  const guid = await findDashboardGuid(apiKey, accountId, dashboard.name);
  if (!guid) {
    console.log(`  No dashboard named "${dashboard.name}" found. Skipping.`);
    return;
  }
  console.log(`  Found GUID: ${guid}`);
  console.log(`  Deleting...`);

  const result = await nerdgraphRequest<{
    data?: {
      dashboardDelete?: {
        status?: string;
        errors?: Array<{ description: string; type: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  }>(apiKey, DELETE_MUTATION, { guid });

  if (result.errors?.length) {
    console.error('GraphQL errors:', JSON.stringify(result.errors, null, 2));
    process.exit(1);
  }

  const deleteResult = result.data?.dashboardDelete;
  if (deleteResult?.errors?.length) {
    console.error('Dashboard deletion errors:', JSON.stringify(deleteResult.errors, null, 2));
    process.exit(1);
  }

  console.log(`  ✓ Deleted "${dashboard.name}" (${deleteResult?.status ?? 'OK'})`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const printOnly = args.includes('--print');
  const deployAll = args.includes('--all');
  const updateMode = args.includes('--update');
  const teardown = args.includes('--teardown');
  const staging = args.includes('--staging');
  const eu = args.includes('--eu');

  if (staging && eu) {
    console.error('Error: --staging and --eu are mutually exclusive.');
    process.exit(1);
  }

  if (teardown && (printOnly || updateMode)) {
    console.error('Error: --teardown is mutually exclusive with --print and --update.');
    process.exit(1);
  }

  if (staging) {
    NERDGRAPH_URL = 'https://staging-api.newrelic.com/graphql';
    process.stdout.write('Targeting staging API: https://staging-api.newrelic.com/graphql\n');
  } else if (eu) {
    NERDGRAPH_URL = 'https://api.eu.newrelic.com/graphql';
    process.stdout.write('Targeting EU API: https://api.eu.newrelic.com/graphql\n');
  }

  // Parse --developer <name>
  const developerFlagIndex = args.indexOf('--developer');
  const developerOverride: string | null = developerFlagIndex !== -1
    ? (args[developerFlagIndex + 1] ?? null)
    : null;

  // Drop flags and the value that follows --developer. Guard with
  // developerFlagIndex !== -1 so that when the flag is absent we don't drop
  // args[0] (developerFlagIndex + 1 would be 0, the positional filename).
  const fileArgs = args.filter(
    (_a: string, i: number) =>
      !args[i].startsWith('--') &&
      (developerFlagIndex === -1 || i !== developerFlagIndex + 1),
  );

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
      if (developerOverride) {
        injectDeveloperDefault(dashboard, normalizeDeveloperName(developerOverride));
      }
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
    if (teardown) {
      await teardownDashboard(apiKey, accountId, file);
    } else if (updateMode) {
      await updateDashboard(apiKey, accountId, file, developerOverride);
    } else {
      await deployDashboard(apiKey, accountId, file, developerOverride);
    }
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Failed to deploy dashboard:', err);
  process.exit(1);
});
