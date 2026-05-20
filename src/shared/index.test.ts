import { VERSION } from './index.js';

describe('shared package', () => {
  it('exports VERSION', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
