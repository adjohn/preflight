export interface IntegrationOptions {
  [key: string]: unknown;
}

export interface Integration {
  name: string;
  initialize(): Promise<void>;
}

export class IntegrationRegistry {
  private integrations: Map<string, Integration> = new Map();
  private loadedFrameworks: Set<string> = new Set();

  async registerIntegration(frameworkName: string, options?: IntegrationOptions): Promise<void> {
    if (this.loadedFrameworks.has(frameworkName)) {
      return;
    }

    try {
      let integration: Integration | null = null;

      switch (frameworkName.toLowerCase()) {
        case 'langchain':
          integration = await this.loadLangChainIntegration(options);
          break;
        case 'vercel-ai':
        case 'vercelai':
          integration = await this.loadVercelAiIntegration(options);
          break;
        default:
          throw new Error(`Unknown framework: ${frameworkName}`);
      }

      if (integration) {
        this.integrations.set(frameworkName, integration);
        await integration.initialize();
        this.loadedFrameworks.add(frameworkName);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load ${frameworkName} integration: ${errorMsg}`);
    }
  }

  private async loadLangChainIntegration(options?: IntegrationOptions): Promise<Integration> {
    try {
      const module = await import('./langchain.js');
      return {
        name: 'langchain',
        initialize: async () => {
          if (module.initializeLangChainIntegration) {
            await module.initializeLangChainIntegration(options);
          }
        },
      };
    } catch (_error) {
      throw new Error('langchain not found. Install with: npm install langchain');
    }
  }

  private async loadVercelAiIntegration(options?: IntegrationOptions): Promise<Integration> {
    try {
      const module = await import('./vercel-ai.js');
      return {
        name: 'vercel-ai',
        initialize: async () => {
          if (module.initializeVercelAiIntegration) {
            await module.initializeVercelAiIntegration(options);
          }
        },
      };
    } catch (_error) {
      throw new Error('ai (Vercel AI SDK) not found. Install with: npm install ai');
    }
  }

  getIntegration(frameworkName: string): Integration | undefined {
    return this.integrations.get(frameworkName);
  }

  isLoaded(frameworkName: string): boolean {
    return this.loadedFrameworks.has(frameworkName);
  }

  getLoadedFrameworks(): string[] {
    return Array.from(this.loadedFrameworks);
  }

  reset(): void {
    this.integrations.clear();
    this.loadedFrameworks.clear();
  }
}

export const globalIntegrationRegistry = new IntegrationRegistry();
