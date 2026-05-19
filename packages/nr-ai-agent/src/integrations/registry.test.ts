import { describe, it, expect, beforeEach } from '@jest/globals';
import { IntegrationRegistry } from './registry.js';

describe('IntegrationRegistry', () => {
  let registry: IntegrationRegistry;

  beforeEach(() => {
    registry = new IntegrationRegistry();
  });

  describe('framework loading', () => {
    it('loads LangChain integration', async () => {
      await registry.registerIntegration('langchain');
      expect(registry.isLoaded('langchain')).toBe(true);
    });

    it('loads Vercel AI integration', async () => {
      await registry.registerIntegration('vercel-ai');
      expect(registry.isLoaded('vercel-ai')).toBe(true);
    });

    it('throws error for unknown framework', async () => {
      await expect(registry.registerIntegration('unknown-framework')).rejects.toThrow('Unknown framework');
    });

    it('returns integration after registration', async () => {
      await registry.registerIntegration('langchain');
      const integration = registry.getIntegration('langchain');
      expect(integration).toBeDefined();
      expect(integration?.name).toBe('langchain');
    });

    it('does not load same framework twice', async () => {
      await registry.registerIntegration('langchain');
      const integration1 = registry.getIntegration('langchain');

      await registry.registerIntegration('langchain');
      const integration2 = registry.getIntegration('langchain');

      expect(integration1).toBe(integration2);
    });
  });

  describe('integration tracking', () => {
    it('tracks loaded frameworks', async () => {
      await registry.registerIntegration('langchain');
      await registry.registerIntegration('vercel-ai');

      const loaded = registry.getLoadedFrameworks();
      expect(loaded).toContain('langchain');
      expect(loaded).toContain('vercel-ai');
    });

    it('returns empty loaded frameworks initially', () => {
      const loaded = registry.getLoadedFrameworks();
      expect(loaded).toHaveLength(0);
    });

    it('returns undefined for unloaded framework', () => {
      const integration = registry.getIntegration('langchain');
      expect(integration).toBeUndefined();
    });
  });

  describe('reset', () => {
    it('clears all loaded integrations', async () => {
      await registry.registerIntegration('langchain');
      await registry.registerIntegration('vercel-ai');

      expect(registry.getLoadedFrameworks()).toHaveLength(2);

      registry.reset();

      expect(registry.getLoadedFrameworks()).toHaveLength(0);
      expect(registry.getIntegration('langchain')).toBeUndefined();
      expect(registry.getIntegration('vercel-ai')).toBeUndefined();
    });

    it('allows reloading after reset', async () => {
      await registry.registerIntegration('langchain');
      registry.reset();
      await registry.registerIntegration('langchain');

      expect(registry.isLoaded('langchain')).toBe(true);
    });
  });

  describe('options passing', () => {
    it('passes options to integration initialization', async () => {
      const options = { tracer: 'test-tracer', captureErrors: true };
      await registry.registerIntegration('langchain', options);

      expect(registry.isLoaded('langchain')).toBe(true);
    });
  });

  describe('vercel-ai alternative names', () => {
    it('loads vercel-ai with "vercelai" alias', async () => {
      await registry.registerIntegration('vercelai');
      expect(registry.isLoaded('vercelai')).toBe(true);
    });
  });
});
