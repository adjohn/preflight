export interface AttributionTags {
  readonly feature?: string;
  readonly team?: string;
  readonly user?: string;
  readonly environment?: string;
  readonly [key: string]: string | undefined;
}

export function resolveAttribution(
  requestMetadata: Record<string, unknown> | null | undefined,
  contextTags: AttributionTags | undefined,
  globalTags: AttributionTags | undefined,
): AttributionTags {
  // Extract per-request tags from metadata.nr.*
  const requestTags: Record<string, string> = {};
  if (requestMetadata && typeof requestMetadata === 'object' && 'nr' in requestMetadata) {
    const nr = requestMetadata.nr;
    if (nr && typeof nr === 'object') {
      for (const [key, value] of Object.entries(nr)) {
        if (typeof value === 'string') {
          requestTags[key] = value;
        }
      }
    }
  }

  // Merge: per-request > context > global (specific overrides general)
  const merged: Record<string, string> = {};

  // Apply global defaults first
  if (globalTags) {
    for (const [key, value] of Object.entries(globalTags)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
  }

  // Apply context tags (override globals)
  if (contextTags) {
    for (const [key, value] of Object.entries(contextTags)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
  }

  // Apply per-request tags (override both)
  for (const [key, value] of Object.entries(requestTags)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  return merged as AttributionTags;
}

export function attributionTagsToCustomAttributes(tags: AttributionTags): Record<string, string | number> {
  const attrs: Record<string, string | number> = {};

  // Standard attribution tags
  if (tags.feature) {
    attrs['ai.attribution.feature'] = tags.feature;
  }
  if (tags.team) {
    attrs['ai.attribution.team'] = tags.team;
  }
  if (tags.user) {
    attrs['ai.attribution.user'] = tags.user;
  }
  if (tags.environment) {
    attrs['ai.attribution.environment'] = tags.environment;
  }

  // Custom tags with ai.custom.* prefix
  for (const [key, value] of Object.entries(tags)) {
    if (
      key !== 'feature' &&
      key !== 'team' &&
      key !== 'user' &&
      key !== 'environment' &&
      value !== undefined
    ) {
      attrs[`ai.custom.${key}`] = value;
    }
  }

  return attrs;
}

export function stripNrMetadata(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== 'object') {
    return metadata;
  }

  const meta = metadata as Record<string, unknown>;

  // If metadata has nr field, create a copy without it
  if ('nr' in meta) {
    const { nr: _nr, ...rest } = meta;
    return rest;
  }

  return metadata;
}
