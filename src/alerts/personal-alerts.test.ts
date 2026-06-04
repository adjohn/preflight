import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AlertConditionDefinition } from './types.js';
import { DEFAULT_PERSONAL_THRESHOLDS } from './types.js';

// __dirname is provided by ts-jest — no ESM declaration needed (matches alerts.test.ts pattern)
const conditionsDir = resolve(__dirname, '..', '..', 'alerts', 'conditions-personal');

const PERSONAL_THRESHOLD_PLACEHOLDERS: Record<string, number> = {
  __dailyCostUsd__: DEFAULT_PERSONAL_THRESHOLDS.dailyCostUsd,
  __sessionCostUsd__: DEFAULT_PERSONAL_THRESHOLDS.sessionCostUsd,
  __efficiencyScoreMin__: DEFAULT_PERSONAL_THRESHOLDS.efficiencyScoreMin,
  __stuckLoopCountMax__: DEFAULT_PERSONAL_THRESHOLDS.stuckLoopCountMax,
  __antiPatternCountMax__: DEFAULT_PERSONAL_THRESHOLDS.antiPatternCountMax,
};

const VALID_EVENT_TYPES = new Set([
  'AiToolCall',
  'Metric',
  'AiCodingTask',
  'AiAntiPattern',
  'AiAuditEvent',
]);

const TEST_DEVELOPER = 'test_user';

const rawFiles = readdirSync(conditionsDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

// Substitute placeholders the same way deploy-alerts.ts does at deploy time, so
// we validate the same JSON shape NerdGraph will receive.
const personalConditions: Array<{ file: string; condition: AlertConditionDefinition }> =
  rawFiles.map((file) => {
    let raw = readFileSync(resolve(conditionsDir, file), 'utf-8');
    raw = raw.replaceAll('{{developer}}', TEST_DEVELOPER);
    for (const [placeholder, value] of Object.entries(PERSONAL_THRESHOLD_PLACEHOLDERS)) {
      raw = raw.replace(`"${placeholder}"`, String(value));
    }
    return { file, condition: JSON.parse(raw) as AlertConditionDefinition };
  });

describe('Personal alert raw files', () => {
  it('has exactly 5 condition files', () => {
    expect(rawFiles).toHaveLength(5);
  });

  it('all files contain {{developer}} in name and nrqlQuery', () => {
    for (const file of rawFiles) {
      const raw = readFileSync(resolve(conditionsDir, file), 'utf-8');
      expect(raw).toContain('{{developer}}');
      const obj = JSON.parse(raw) as Record<string, unknown>;
      expect(obj.name as string).toContain('{{developer}}');
      expect(obj.nrqlQuery as string).toContain("'{{developer}}'");
    }
  });

  it('every threshold placeholder in a personal condition has a known substitution', () => {
    for (const file of rawFiles) {
      const raw = readFileSync(resolve(conditionsDir, file), 'utf-8');
      const placeholderMatches = raw.match(/__\w+__/g) ?? [];
      for (const placeholder of placeholderMatches) {
        expect(PERSONAL_THRESHOLD_PLACEHOLDERS).toHaveProperty(placeholder);
      }
    }
  });

  it('all files contain at least one threshold placeholder', () => {
    const placeholders = Object.keys(PERSONAL_THRESHOLD_PLACEHOLDERS);
    for (const file of rawFiles) {
      const raw = readFileSync(resolve(conditionsDir, file), 'utf-8');
      const hasPlaceholder = placeholders.some((p) => raw.includes(p));
      expect(hasPlaceholder).toBe(true);
    }
  });
});

describe.each(personalConditions)('Personal condition: $file', ({ condition }) => {
  it('has required string fields', () => {
    expect(condition.name).toBeTruthy();
    expect(condition.nrqlQuery).toBeTruthy();
    expect(condition.aggregationMethod).toBeTruthy();
  });

  it('has a boolean enabled field', () => {
    expect(typeof condition.enabled).toBe('boolean');
  });

  it('nrqlQuery contains SELECT and FROM', () => {
    expect(condition.nrqlQuery).toMatch(/SELECT/i);
    expect(condition.nrqlQuery).toMatch(/FROM/i);
  });

  it('nrqlQuery references a known event type', () => {
    const match = condition.nrqlQuery.match(/FROM\s+(\w+)/i);
    expect(match).not.toBeNull();
    expect(VALID_EVENT_TYPES.has(match![1])).toBe(true);
  });

  it('has valid aggregationMethod', () => {
    expect(['EVENT_FLOW', 'EVENT_TIMER', 'CADENCE']).toContain(condition.aggregationMethod);
  });

  it('thresholdCritical.duration is a multiple of aggregationWindow', () => {
    expect(condition.thresholdCritical.duration % condition.aggregationWindow).toBe(0);
  });

  it('has a positive violationTimeLimitSeconds', () => {
    expect(condition.violationTimeLimitSeconds).toBeGreaterThan(0);
  });

  it('has a valid thresholdOperator', () => {
    expect([
      'ABOVE',
      'ABOVE_OR_EQUALS',
      'BELOW',
      'BELOW_OR_EQUALS',
      'EQUALS',
      'NOT_EQUALS',
    ]).toContain(condition.thresholdOperator);
  });

  it('thresholdCritical has valid occurrences', () => {
    expect(['ALL', 'AT_LEAST_ONCE']).toContain(condition.thresholdCritical.occurrences);
  });

  it('thresholdCritical.value is a number after substitution', () => {
    expect(typeof condition.thresholdCritical.value).toBe('number');
  });

  it('developer placeholder was substituted in name and nrqlQuery', () => {
    expect(condition.name).not.toContain('{{developer}}');
    expect(condition.nrqlQuery).not.toContain('{{developer}}');
    expect(condition.nrqlQuery).toContain(TEST_DEVELOPER);
  });

  it('NRQL filters by developer', () => {
    expect(condition.nrqlQuery).toContain(`developer = '${TEST_DEVELOPER}'`);
  });
});

describe('Personal condition set', () => {
  it('no two personal conditions share the same name', () => {
    const names = personalConditions.map((c) => c.condition.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
