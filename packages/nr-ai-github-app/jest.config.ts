import type { Config } from 'jest';
import baseConfig from '../../jest.config.base.ts';

const config: Config = {
  ...baseConfig,
  displayName: 'nr-ai-github-app',
  moduleNameMapper: {
    ...baseConfig.moduleNameMapper,
    '^nr-ai-cicd$': '<rootDir>/../nr-ai-cicd/src/index.ts',
  },
};

export default config;
