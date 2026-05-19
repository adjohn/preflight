import { resolveAttribution, attributionTagsToCustomAttributes, stripNrMetadata } from './cost-attribution.js';
import type { AttributionTags } from './cost-attribution.js';

describe('resolveAttribution', () => {
  it('should extract per-request tags from metadata.nr.*', () => {
    const metadata = {
      nr: {
        feature: 'code-review',
        team: 'backend',
        user: 'alice',
      },
    };

    const tags = resolveAttribution(metadata, undefined, undefined);

    expect(tags.feature).toBe('code-review');
    expect(tags.team).toBe('backend');
    expect(tags.user).toBe('alice');
  });

  it('should apply global default tags', () => {
    const globalTags: AttributionTags = {
      feature: 'chatbot',
      environment: 'production',
    };

    const tags = resolveAttribution(null, undefined, globalTags);

    expect(tags.feature).toBe('chatbot');
    expect(tags.environment).toBe('production');
  });

  it('should apply context-scoped tags', () => {
    const contextTags: AttributionTags = {
      team: 'support',
      user: 'bob',
    };

    const tags = resolveAttribution(null, contextTags, undefined);

    expect(tags.team).toBe('support');
    expect(tags.user).toBe('bob');
  });

  it('should respect priority: per-request > context > global', () => {
    const metadata = {
      nr: {
        feature: 'per-request-feature',
        user: 'request-user',
      },
    };
    const contextTags: AttributionTags = {
      feature: 'context-feature',
      team: 'context-team',
      environment: 'staging',
    };
    const globalTags: AttributionTags = {
      feature: 'global-feature',
      team: 'global-team',
      environment: 'production',
    };

    const tags = resolveAttribution(metadata, contextTags, globalTags);

    // Per-request overrides context and global
    expect(tags.feature).toBe('per-request-feature');
    expect(tags.user).toBe('request-user');

    // Context overrides global
    expect(tags.team).toBe('context-team');

    // Global applies when no override
    expect(tags.environment).toBe('staging');
  });

  it('should merge tags from all sources', () => {
    const metadata = {
      nr: {
        feature: 'feature-from-request',
      },
    };
    const contextTags: AttributionTags = {
      team: 'team-from-context',
    };
    const globalTags: AttributionTags = {
      environment: 'production',
    };

    const tags = resolveAttribution(metadata, contextTags, globalTags);

    expect(tags.feature).toBe('feature-from-request');
    expect(tags.team).toBe('team-from-context');
    expect(tags.environment).toBe('production');
  });

  it('should handle null or undefined metadata', () => {
    const tags1 = resolveAttribution(null, undefined, undefined);
    const tags2 = resolveAttribution(undefined, undefined, undefined);

    expect(tags1).toEqual({});
    expect(tags2).toEqual({});
  });

  it('should ignore non-string values in metadata.nr', () => {
    const metadata = {
      nr: {
        feature: 'valid-feature',
        count: 123, // Should be ignored
        enabled: true, // Should be ignored
        nested: { key: 'value' }, // Should be ignored
      },
    };

    const tags = resolveAttribution(metadata, undefined, undefined);

    expect(tags.feature).toBe('valid-feature');
    expect(tags['count']).toBeUndefined();
    expect(tags['enabled']).toBeUndefined();
    expect(tags['nested']).toBeUndefined();
  });

  it('should support custom tags', () => {
    const metadata = {
      nr: {
        feature: 'testing',
        customField: 'custom-value',
        promptVersion: 'v3',
      },
    };

    const tags = resolveAttribution(metadata, undefined, undefined);

    expect(tags.feature).toBe('testing');
    expect(tags.customField).toBe('custom-value');
    expect(tags.promptVersion).toBe('v3');
  });

  it('should handle undefined values', () => {
    const contextTags: AttributionTags = {
      feature: 'test',
      team: undefined,
    };

    const tags = resolveAttribution(null, contextTags, undefined);

    expect(tags.feature).toBe('test');
    expect(tags.team).toBeUndefined();
  });

  it('should return empty object when no tags provided anywhere', () => {
    const tags = resolveAttribution(null, undefined, undefined);

    expect(tags).toEqual({});
    expect(Object.keys(tags)).toHaveLength(0);
  });

  it('should not mutate input objects', () => {
    const metadata = {
      nr: { feature: 'test' },
      other: 'field',
    };
    const contextTags: AttributionTags = { team: 'backend' };
    const globalTags: AttributionTags = { environment: 'prod' };

    resolveAttribution(metadata, contextTags, globalTags);

    expect(metadata).toEqual({
      nr: { feature: 'test' },
      other: 'field',
    });
    expect(contextTags).toEqual({ team: 'backend' });
    expect(globalTags).toEqual({ environment: 'prod' });
  });
});

describe('attributionTagsToCustomAttributes', () => {
  it('should convert standard attribution tags to custom attributes', () => {
    const tags: AttributionTags = {
      feature: 'code-review',
      team: 'backend',
      user: 'alice',
      environment: 'production',
    };

    const attrs = attributionTagsToCustomAttributes(tags);

    expect(attrs['ai.attribution.feature']).toBe('code-review');
    expect(attrs['ai.attribution.team']).toBe('backend');
    expect(attrs['ai.attribution.user']).toBe('alice');
    expect(attrs['ai.attribution.environment']).toBe('production');
  });

  it('should prefix custom tags with ai.custom.*', () => {
    const tags: AttributionTags = {
      feature: 'test',
      promptVersion: 'v3',
      deploymentId: 'deploy-123',
      customField: 'custom-value',
    };

    const attrs = attributionTagsToCustomAttributes(tags);

    expect(attrs['ai.attribution.feature']).toBe('test');
    expect(attrs['ai.custom.promptVersion']).toBe('v3');
    expect(attrs['ai.custom.deploymentId']).toBe('deploy-123');
    expect(attrs['ai.custom.customField']).toBe('custom-value');
  });

  it('should omit undefined values', () => {
    const tags: AttributionTags = {
      feature: 'test',
      team: undefined,
      customField: 'value',
    };

    const attrs = attributionTagsToCustomAttributes(tags);

    expect(attrs['ai.attribution.feature']).toBe('test');
    expect(attrs['ai.attribution.team']).toBeUndefined();
    expect(attrs['ai.custom.customField']).toBe('value');
  });

  it('should handle empty tags object', () => {
    const tags: AttributionTags = {};

    const attrs = attributionTagsToCustomAttributes(tags);

    expect(attrs).toEqual({});
    expect(Object.keys(attrs)).toHaveLength(0);
  });

  it('should handle only standard tags', () => {
    const tags: AttributionTags = {
      feature: 'feature-value',
      team: 'team-value',
    };

    const attrs = attributionTagsToCustomAttributes(tags);

    expect(attrs['ai.attribution.feature']).toBe('feature-value');
    expect(attrs['ai.attribution.team']).toBe('team-value');
    expect(Object.keys(attrs)).toHaveLength(2);
  });

  it('should handle only custom tags', () => {
    const tags: AttributionTags = {
      customField1: 'value1',
      customField2: 'value2',
    };

    const attrs = attributionTagsToCustomAttributes(tags);

    expect(attrs['ai.custom.customField1']).toBe('value1');
    expect(attrs['ai.custom.customField2']).toBe('value2');
    expect(Object.keys(attrs)).toHaveLength(2);
  });

  it('should handle mixed standard and custom tags', () => {
    const tags: AttributionTags = {
      feature: 'chatbot',
      team: 'support',
      environment: 'staging',
      promptVersion: 'v2',
      deploymentRegion: 'us-west-2',
    };

    const attrs = attributionTagsToCustomAttributes(tags);

    expect(attrs['ai.attribution.feature']).toBe('chatbot');
    expect(attrs['ai.attribution.team']).toBe('support');
    expect(attrs['ai.attribution.environment']).toBe('staging');
    expect(attrs['ai.custom.promptVersion']).toBe('v2');
    expect(attrs['ai.custom.deploymentRegion']).toBe('us-west-2');
    expect(Object.keys(attrs)).toHaveLength(5);
  });
});

describe('stripNrMetadata', () => {
  it('should remove nr field from metadata', () => {
    const metadata = {
      nr: { feature: 'test' },
      other: 'value',
    };

    const stripped = stripNrMetadata(metadata);

    expect(stripped).toEqual({ other: 'value' });
    expect((stripped as Record<string, unknown>).nr).toBeUndefined();
  });

  it('should preserve metadata without nr field', () => {
    const metadata = {
      userId: '123',
      timestamp: Date.now(),
    };

    const stripped = stripNrMetadata(metadata);

    expect(stripped).toEqual(metadata);
  });

  it('should not mutate original metadata', () => {
    const metadata = {
      nr: { feature: 'test' },
      other: 'value',
    };
    const original = JSON.stringify(metadata);

    stripNrMetadata(metadata);

    expect(JSON.stringify(metadata)).toBe(original);
  });

  it('should handle null metadata', () => {
    const stripped = stripNrMetadata(null);
    expect(stripped).toBeNull();
  });

  it('should handle undefined metadata', () => {
    const stripped = stripNrMetadata(undefined);
    expect(stripped).toBeUndefined();
  });

  it('should handle non-object metadata', () => {
    expect(stripNrMetadata('string')).toBe('string');
    expect(stripNrMetadata(123)).toBe(123);
    expect(stripNrMetadata(true)).toBe(true);
  });

  it('should handle empty nr field', () => {
    const metadata = {
      nr: {},
      other: 'value',
    };

    const stripped = stripNrMetadata(metadata);

    expect(stripped).toEqual({ other: 'value' });
  });

  it('should preserve other fields when removing nr', () => {
    const metadata = {
      nr: { feature: 'test', team: 'backend' },
      userId: 'user-123',
      requestId: 'req-456',
      customData: { nested: true },
    };

    const stripped = stripNrMetadata(metadata);

    const strippedRecord = stripped as Record<string, unknown>;
    expect(strippedRecord.nr).toBeUndefined();
    expect(strippedRecord.userId).toBe('user-123');
    expect(strippedRecord.requestId).toBe('req-456');
    expect(strippedRecord.customData).toEqual({ nested: true });
  });
});
