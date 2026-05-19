import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_PERSONAL_THRESHOLDS } from './types.js';

// __dirname is provided by ts-jest — no ESM declaration needed (matches alerts.test.ts pattern)
const conditionsDir = resolve(__dirname, '..', '..', 'alerts', 'conditions-personal');

const rawFiles = readdirSync(conditionsDir).filter(f => f.endsWith('.json')).sort();

describe('Personal alert condition files', () => {
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

  it('all files contain at least one threshold placeholder', () => {
    const placeholders = ['__dailyCostUsd__', '__sessionCostUsd__', '__efficiencyScoreMin__', '__stuckLoopCountMax__'];
    for (const file of rawFiles) {
      const raw = readFileSync(resolve(conditionsDir, file), 'utf-8');
      const hasPlaceholder = placeholders.some(p => raw.includes(p));
      expect(hasPlaceholder).toBe(true);
    }
  });

  it('after substitution with defaults + developer, produces valid AlertConditionDefinition', () => {
    const developer = 'testuser';
    const thresholdMap: Record<string, number> = {
      __dailyCostUsd__:       DEFAULT_PERSONAL_THRESHOLDS.dailyCostUsd,
      __sessionCostUsd__:     DEFAULT_PERSONAL_THRESHOLDS.sessionCostUsd,
      __efficiencyScoreMin__: DEFAULT_PERSONAL_THRESHOLDS.efficiencyScoreMin,
      __stuckLoopCountMax__:  DEFAULT_PERSONAL_THRESHOLDS.stuckLoopCountMax,
    };

    for (const file of rawFiles) {
      let raw = readFileSync(resolve(conditionsDir, file), 'utf-8');
      raw = raw.replaceAll('{{developer}}', developer);
      for (const [placeholder, value] of Object.entries(thresholdMap)) {
        raw = raw.replace(`"${placeholder}"`, String(value));
      }

      const cond = JSON.parse(raw) as Record<string, unknown>;
      expect(typeof cond.name).toBe('string');
      expect((cond.name as string)).toContain(developer);
      expect(typeof cond.nrqlQuery).toBe('string');
      expect((cond.nrqlQuery as string)).toContain(`'${developer}'`);
      expect(typeof cond.thresholdCritical).toBe('object');
      const threshold = (cond.thresholdCritical as Record<string, unknown>).value;
      expect(typeof threshold).toBe('number');
    }
  });

  it('no two conditions share the same name template', () => {
    const nameTemplates = rawFiles.map(f => {
      const raw = readFileSync(resolve(conditionsDir, f), 'utf-8');
      return (JSON.parse(raw) as Record<string, unknown>).name as string;
    });
    expect(new Set(nameTemplates).size).toBe(nameTemplates.length);
  });
});
