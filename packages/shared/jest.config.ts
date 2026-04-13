import type { Config } from 'jest';
import baseConfig from '../../jest.config.base.ts';

const config: Config = {
  ...baseConfig,
  displayName: 'shared',
};

export default config;
