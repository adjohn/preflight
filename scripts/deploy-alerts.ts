#!/usr/bin/env npx tsx
/**
 * Deploy AI Coding Assistant alert conditions to a New Relic account.
 *
 * Usage:
 *   NEW_RELIC_API_KEY=NRAK-... NEW_RELIC_ACCOUNT_ID=12345 npx tsx scripts/deploy-alerts.ts [options]
 *
 * Options:
 *   --dry-run             Print the policy + conditions that would be created and exit.
 *   --teardown            Delete the alert policy and all its conditions.
 *   --update              Sync conditions on an existing policy in place (matched by name).
 *                         Updates conditions that match a local file, creates ones that
 *                         don't exist, and deletes remote conditions with no local match.
 *                         Errors if the policy itself is not found. Policy metadata
 *                         (name, incidentPreference) is NOT updated — those changes
 *                         still require --teardown then redeploy. Mutually exclusive
 *                         with --dry-run and --teardown.
 *   --developer <name>    Deploy a personal alert policy scoped to <name> instead of
 *                         the team policy. Personal thresholds are read from
 *                         ~/.nr-ai-observe/config.json under "alerts.personal", falling
 *                         back to DEFAULT_PERSONAL_THRESHOLDS. Combine with --dry-run,
 *                         --teardown, or --update to preview, remove, or sync the
 *                         personal policy.
 *   --staging             Target the New Relic staging API (staging-api.newrelic.com).
 *   --eu                  Target the New Relic EU API (api.eu.newrelic.com).
 *                         Mutually exclusive with --staging.
 *
 * Requires a New Relic User API key (NRAK-...), not a license key.
 */

import 'dotenv/config';

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { AlertConditionDefinition, AlertPolicyDefinition, PersonalAlertThresholds } from '../src/alerts/types.js';
import { DEFAULT_PERSONAL_THRESHOLDS } from '../src/alerts/types.js';
import { normalizeDeveloperName } from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let NERDGRAPH_URL = 'https://api.newrelic.com/graphql';

async function nerdgraph<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const resp = await fetch(NERDGRAPH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'API-Key': apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    throw new Error(`NerdGraph HTTP ${resp.status}: ${await resp.text()}`);
  }
  const json = (await resp.json()) as {
    data?: T;
    errors?: Array<{
      message: string;
      path?: ReadonlyArray<string | number>;
      extensions?: Record<string, unknown>;
    }>;
  };
  if (json.errors?.length) {
    // Include path + extensions so opaque resolver errors are debuggable.
    throw new Error(`NerdGraph errors: ${JSON.stringify(json.errors, null, 2)}`);
  }
  return json.data as T;
}

const CREATE_POLICY_MUTATION = `
mutation CreateAlertPolicy($accountId: Int!, $name: String!, $incidentPreference: AlertsIncidentPreference!) {
  alertsPolicyCreate(accountId: $accountId, policy: {
    name: $name
    incidentPreference: $incidentPreference
  }) {
    id
    name
  }
}`;

interface CreatePolicyResult {
  alertsPolicyCreate: { id: string; name: string };
}

const CREATE_NRQL_CONDITION_MUTATION = `
mutation CreateNrqlCondition($accountId: Int!, $policyId: ID!, $condition: AlertsNrqlConditionStaticInput!) {
  alertsNrqlConditionStaticCreate(accountId: $accountId, policyId: $policyId, condition: $condition) {
    id
    name
    enabled
  }
}`;

interface CreateConditionResult {
  alertsNrqlConditionStaticCreate: { id: string; name: string; enabled: boolean };
}

const LIST_POLICIES_QUERY = `
query ListPolicies($accountId: Int!, $name: String!) {
  actor {
    account(id: $accountId) {
      alerts {
        policiesSearch(searchCriteria: { name: $name }) {
          policies {
            id
            name
          }
        }
      }
    }
  }
}`;

interface ListPoliciesResult {
  actor: {
    account: {
      alerts: {
        policiesSearch: {
          policies: Array<{ id: string; name: string }>;
        };
      };
    };
  };
}

const DELETE_POLICY_MUTATION = `
mutation DeletePolicy($accountId: Int!, $policyId: ID!) {
  alertsPolicyDelete(accountId: $accountId, id: $policyId) {
    id
  }
}`;

const LIST_CONDITIONS_QUERY = `
query ListConditions($accountId: Int!, $policyId: ID!) {
  actor {
    account(id: $accountId) {
      alerts {
        nrqlConditionsSearch(searchCriteria: { policyId: $policyId }) {
          nrqlConditions {
            id
            name
          }
        }
      }
    }
  }
}`;

interface ListConditionsResult {
  actor: {
    account: {
      alerts: {
        nrqlConditionsSearch: {
          nrqlConditions: Array<{ id: string; name: string }>;
        };
      };
    };
  };
}

const UPDATE_NRQL_CONDITION_MUTATION = `
mutation UpdateNrqlCondition($accountId: Int!, $id: ID!, $condition: AlertsNrqlConditionUpdateStaticInput!) {
  alertsNrqlConditionStaticUpdate(accountId: $accountId, id: $id, condition: $condition) {
    id
    name
    enabled
  }
}`;

interface UpdateConditionResult {
  alertsNrqlConditionStaticUpdate: { id: string; name: string; enabled: boolean };
}

const DELETE_CONDITION_MUTATION = `
mutation DeleteCondition($accountId: Int!, $id: ID!) {
  alertsConditionDelete(accountId: $accountId, id: $id) {
    id
  }
}`;

function loadDefinitions(): {
  policy: AlertPolicyDefinition;
  conditions: AlertConditionDefinition[];
} {
  const alertsDir = resolve(__dirname, '..', 'alerts');
  const conditionsDir = resolve(alertsDir, 'conditions');

  const policy: AlertPolicyDefinition = JSON.parse(
    readFileSync(resolve(alertsDir, 'policy.json'), 'utf-8'),
  );

  const conditionFiles = readdirSync(conditionsDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const conditions: AlertConditionDefinition[] = conditionFiles.map((f) =>
    JSON.parse(readFileSync(resolve(conditionsDir, f), 'utf-8')),
  );

  return { policy, conditions };
}

function loadPersonalDefinitions(
  developer: string,
  thresholds: PersonalAlertThresholds,
): { policy: AlertPolicyDefinition; conditions: AlertConditionDefinition[] } {
  const conditionsDir = resolve(__dirname, '..', 'alerts', 'conditions-personal');

  const policy: AlertPolicyDefinition = {
    name: `AI Coding — Personal — ${developer}`,
    incidentPreference: 'PER_CONDITION',
  };

  const conditionFiles = readdirSync(conditionsDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const thresholdMap: Record<string, number> = {
    __dailyCostUsd__:        thresholds.dailyCostUsd,
    __sessionCostUsd__:      thresholds.sessionCostUsd,
    __efficiencyScoreMin__:  thresholds.efficiencyScoreMin,
    __stuckLoopCountMax__:   thresholds.stuckLoopCountMax,
    __antiPatternCountMax__: thresholds.antiPatternCountMax,
  };

  const conditions: AlertConditionDefinition[] = conditionFiles.map((f) => {
    let raw = readFileSync(resolve(conditionsDir, f), 'utf-8');

    // Substitute developer name and threshold placeholders
    raw = raw.replaceAll('{{developer}}', developer);
    for (const [placeholder, value] of Object.entries(thresholdMap)) {
      // The placeholder appears as a quoted string in JSON: "__dailyCostUsd__"
      // Replace with a bare number so it becomes a valid JSON number after re-parse
      raw = raw.replace(`"${placeholder}"`, String(value));
    }

    return JSON.parse(raw) as AlertConditionDefinition;
  });

  return { policy, conditions };
}

function loadPersonalThresholds(): PersonalAlertThresholds {
  const configPath = resolve(homedir(), '.nr-ai-observe', 'config.json');
  try {
    const file = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const alertsSection = file.alerts;
    if (typeof alertsSection !== 'object' || alertsSection === null) return DEFAULT_PERSONAL_THRESHOLDS;
    const personal = (alertsSection as Record<string, unknown>).personal;
    if (typeof personal !== 'object' || personal === null) return DEFAULT_PERSONAL_THRESHOLDS;
    const t = personal as Record<string, unknown>;
    return {
      dailyCostUsd:         typeof t.dailyCostUsd === 'number'        ? t.dailyCostUsd        : DEFAULT_PERSONAL_THRESHOLDS.dailyCostUsd,
      sessionCostUsd:       typeof t.sessionCostUsd === 'number'      ? t.sessionCostUsd      : DEFAULT_PERSONAL_THRESHOLDS.sessionCostUsd,
      efficiencyScoreMin:   typeof t.efficiencyScoreMin === 'number'  ? t.efficiencyScoreMin  : DEFAULT_PERSONAL_THRESHOLDS.efficiencyScoreMin,
      stuckLoopCountMax:    typeof t.stuckLoopCountMax === 'number'   ? t.stuckLoopCountMax   : DEFAULT_PERSONAL_THRESHOLDS.stuckLoopCountMax,
      antiPatternCountMax:  typeof t.antiPatternCountMax === 'number' ? t.antiPatternCountMax : DEFAULT_PERSONAL_THRESHOLDS.antiPatternCountMax,
    };
  } catch {
    return DEFAULT_PERSONAL_THRESHOLDS;
  }
}

function buildConditionInput(cond: AlertConditionDefinition): Record<string, unknown> {
  return {
    name: cond.name,
    description: cond.description,
    enabled: cond.enabled,
    nrql: { query: cond.nrqlQuery },
    signal: {
      aggregationMethod: cond.aggregationMethod,
      aggregationWindow: cond.aggregationWindow,
      ...(cond.aggregationDelay !== undefined ? { aggregationDelay: cond.aggregationDelay } : {}),
      ...(cond.aggregationTimer !== undefined ? { aggregationTimer: cond.aggregationTimer } : {}),
    },
    terms: [
      {
        threshold: cond.thresholdCritical.value,
        thresholdDuration: cond.thresholdCritical.duration,
        thresholdOccurrences: cond.thresholdCritical.occurrences,
        operator: cond.thresholdOperator,
        priority: 'CRITICAL',
      },
      ...(cond.thresholdWarning ? [{
        threshold: cond.thresholdWarning.value,
        thresholdDuration: cond.thresholdWarning.duration,
        thresholdOccurrences: cond.thresholdWarning.occurrences,
        operator: cond.thresholdOperator,
        priority: 'WARNING',
      }] : []),
    ],
    violationTimeLimitSeconds: cond.violationTimeLimitSeconds,
  };
}

/**
 * Sync conditions on an existing policy to match the local JSON definitions.
 *
 *   - Conditions whose name matches a local file → updated in place
 *     (preserves the condition's id and any incident history).
 *   - Local conditions with no remote match → created.
 *   - Remote conditions with no local match → deleted (assumed obsolete).
 *
 * Policy metadata (name, incidentPreference) is NOT updated. Renaming a
 * policy or changing incidentPreference still requires teardown + redeploy.
 */
async function syncConditions(
  apiKey: string,
  accountId: number,
  policyId: string,
  localConditions: AlertConditionDefinition[],
): Promise<void> {
  const listResult = await nerdgraph<ListConditionsResult>(apiKey, LIST_CONDITIONS_QUERY, {
    accountId,
    policyId,
  });
  const remoteConditions = listResult.actor.account.alerts.nrqlConditionsSearch.nrqlConditions;
  const remoteByName = new Map(remoteConditions.map((c) => [c.name, c]));
  const localNames = new Set(localConditions.map((c) => c.name));

  for (const cond of localConditions) {
    const existing = remoteByName.get(cond.name);
    if (existing) {
      process.stdout.write(`  Updating condition "${cond.name}" (id: ${existing.id})...\n`);
      const result = await nerdgraph<UpdateConditionResult>(
        apiKey,
        UPDATE_NRQL_CONDITION_MUTATION,
        { accountId, id: existing.id, condition: buildConditionInput(cond) },
      );
      const updated = result.alertsNrqlConditionStaticUpdate;
      const status = updated.enabled ? 'enabled' : 'disabled';
      process.stdout.write(`    -> Updated (${status})\n`);
    } else {
      process.stdout.write(`  Creating condition "${cond.name}"...\n`);
      const result = await nerdgraph<CreateConditionResult>(
        apiKey,
        CREATE_NRQL_CONDITION_MUTATION,
        { accountId, policyId, condition: buildConditionInput(cond) },
      );
      const created = result.alertsNrqlConditionStaticCreate;
      const status = created.enabled ? 'enabled' : 'disabled';
      process.stdout.write(`    -> Created (${status})\n`);
    }
  }

  for (const remote of remoteConditions) {
    if (!localNames.has(remote.name)) {
      await nerdgraph(apiKey, DELETE_CONDITION_MUTATION, { accountId, id: remote.id });
      process.stdout.write(`  Deleted obsolete condition "${remote.name}" (id: ${remote.id})\n`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const teardown = args.includes('--teardown');
  const update = args.includes('--update');
  const staging = args.includes('--staging');
  const eu = args.includes('--eu');

  if (staging && eu) {
    console.error('Error: --staging and --eu are mutually exclusive.');
    process.exit(1);
  }

  if ([dryRun, teardown, update].filter(Boolean).length > 1) {
    console.error('Error: --dry-run, --teardown, and --update are mutually exclusive.');
    process.exit(1);
  }

  if (staging) {
    NERDGRAPH_URL = 'https://staging-api.newrelic.com/graphql';
    process.stdout.write('Targeting staging API: https://staging-api.newrelic.com/graphql\n');
  } else if (eu) {
    NERDGRAPH_URL = 'https://api.eu.newrelic.com/graphql';
    process.stdout.write('Targeting EU API: https://api.eu.newrelic.com/graphql\n');
  }

  const developerFlagIndex = args.indexOf('--developer');
  const developerRaw: string | null = developerFlagIndex !== -1
    ? (args[developerFlagIndex + 1] ?? null)
    : null;

  const developer: string | null = developerRaw ? normalizeDeveloperName(developerRaw) : null;

  const accountIdStr = process.env.NEW_RELIC_ACCOUNT_ID;
  if (!accountIdStr) {
    console.error('Error: NEW_RELIC_ACCOUNT_ID environment variable is required.');
    process.exit(1);
  }
  const accountId = parseInt(accountIdStr, 10);
  if (Number.isNaN(accountId)) {
    console.error(`Error: NEW_RELIC_ACCOUNT_ID must be a number. Got: "${accountIdStr}"`);
    process.exit(1);
  }

  if (dryRun) {
    if (developer) {
      const thresholds = loadPersonalThresholds();
      const { policy, conditions } = loadPersonalDefinitions(developer, thresholds);
      process.stdout.write(`--- Dry run: personal policy for ${developer} ---\n`);
      process.stdout.write(`${JSON.stringify(policy, null, 2)}\n`);
      process.stdout.write(`--- Would create ${conditions.length} personal conditions ---\n`);
      for (const c of conditions) {
        process.stdout.write(`  [${c.enabled ? 'enabled' : 'disabled'}] ${c.name}\n`);
      }
    } else {
      const { policy, conditions } = loadDefinitions();
      process.stdout.write('--- Dry run: would create policy ---\n');
      process.stdout.write(`${JSON.stringify(policy, null, 2)}\n`);
      process.stdout.write(`--- Would create ${conditions.length} conditions ---\n`);
      for (const c of conditions) {
        process.stdout.write(`  [${c.enabled ? 'enabled' : 'disabled'}] ${c.name}\n`);
      }
    }
    return;
  }

  const apiKey = process.env.NEW_RELIC_API_KEY;
  if (!apiKey) {
    console.error('Error: NEW_RELIC_API_KEY environment variable is required (User API key, not license key).');
    process.exit(1);
  }

  if (teardown) {
    const policyName = developer
      ? `AI Coding — Personal — ${developer}`
      : loadDefinitions().policy.name;

    const listResult = await nerdgraph<ListPoliciesResult>(apiKey, LIST_POLICIES_QUERY, {
      accountId,
      name: policyName,
    });
    const existing = listResult.actor.account.alerts.policiesSearch.policies;
    if (existing.length === 0) {
      process.stdout.write(`No policy named "${policyName}" found. Nothing to delete.\n`);
      return;
    }
    for (const p of existing) {
      await nerdgraph(apiKey, DELETE_POLICY_MUTATION, { accountId, policyId: p.id });
      process.stdout.write(`Deleted policy "${p.name}" (id: ${p.id})\n`);
    }
    return;
  }

  if (update) {
    const { policy, conditions } = developer
      ? loadPersonalDefinitions(developer, loadPersonalThresholds())
      : loadDefinitions();

    const listResult = await nerdgraph<ListPoliciesResult>(apiKey, LIST_POLICIES_QUERY, {
      accountId,
      name: policy.name,
    });
    const existing = listResult.actor.account.alerts.policiesSearch.policies;
    if (existing.length === 0) {
      console.error(`Error: No policy named "${policy.name}" found. Use deploy (without --update) to create it.`);
      process.exit(1);
    }
    const policyId = existing[0].id;
    process.stdout.write(`Syncing conditions on policy "${policy.name}" (id: ${policyId})...\n`);
    await syncConditions(apiKey, accountId, policyId, conditions);
    process.stdout.write('\nDone. Tip: --update only syncs conditions. Policy name and incidentPreference changes still require --teardown then re-deploy.\n');
    return;
  }

  if (developer) {
    const thresholds = loadPersonalThresholds();
    const { policy, conditions } = loadPersonalDefinitions(developer, thresholds);

    // Idempotent: skip if already exists
    const listResult = await nerdgraph<ListPoliciesResult>(apiKey, LIST_POLICIES_QUERY, {
      accountId,
      name: policy.name,
    });
    if (listResult.actor.account.alerts.policiesSearch.policies.length > 0) {
      const existing = listResult.actor.account.alerts.policiesSearch.policies[0];
      process.stdout.write(`Personal policy for "${developer}" already exists (id: ${existing.id}). Use --teardown to reset.\n`);
      return;
    }

    const createResult = await nerdgraph<CreatePolicyResult>(apiKey, CREATE_POLICY_MUTATION, {
      accountId,
      name: policy.name,
      incidentPreference: policy.incidentPreference,
    });
    const policyId = createResult.alertsPolicyCreate.id;
    process.stdout.write(`Created personal policy "${policy.name}" (id: ${policyId})\n`);

    for (const cond of conditions) {
      const result = await nerdgraph<CreateConditionResult>(
        apiKey, CREATE_NRQL_CONDITION_MUTATION,
        { accountId, policyId, condition: buildConditionInput(cond) },
      );
      const created = result.alertsNrqlConditionStaticCreate;
      process.stdout.write(`  Created condition "${created.name}" (${created.enabled ? 'enabled' : 'disabled'})\n`);
    }
    return;
  }

  // Team policy deployment
  const { policy, conditions } = loadDefinitions();

  // Idempotent: skip if policy already exists
  const listResult = await nerdgraph<ListPoliciesResult>(apiKey, LIST_POLICIES_QUERY, {
    accountId,
    name: policy.name,
  });
  const existing = listResult.actor.account.alerts.policiesSearch.policies;

  if (existing.length > 0) {
    const policyId = existing[0].id;
    process.stdout.write(`Policy "${policy.name}" already exists (id: ${policyId}). Skipping creation.\n`);
    process.stdout.write('Tip: run with --teardown to delete it first, then re-deploy.\n');
    return;
  }

  // Create policy
  const createPolicyResult = await nerdgraph<CreatePolicyResult>(apiKey, CREATE_POLICY_MUTATION, {
    accountId,
    name: policy.name,
    incidentPreference: policy.incidentPreference,
  });
  const policyId = createPolicyResult.alertsPolicyCreate.id;
  process.stdout.write(`Created policy "${policy.name}" (id: ${policyId})\n`);

  // Create each condition
  for (const cond of conditions) {
    const result = await nerdgraph<CreateConditionResult>(
      apiKey,
      CREATE_NRQL_CONDITION_MUTATION,
      { accountId, policyId, condition: buildConditionInput(cond) },
    );
    const created = result.alertsNrqlConditionStaticCreate;
    const status = created.enabled ? 'enabled' : 'disabled';
    process.stdout.write(`  Created condition "${created.name}" (${status})\n`);
  }

  process.stdout.write('\nDone. Tip: adjust threshold values in src/alerts/conditions/ to match your usage.\n');
}

main().catch((err: unknown) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
