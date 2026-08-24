import { describe, expect, it } from 'vitest';

import { detectBillingOverrides } from '../config.js';

describe('detectBillingOverrides', () => {
  it('reports API billing overrides without returning secret values', () => {
    expect(
      detectBillingOverrides({
        ANTHROPIC_API_KEY: 'secret-value-must-not-escape',
        UNRELATED_SETTING: 'present',
      }),
    ).toEqual([{ variable: 'ANTHROPIC_API_KEY' }]);
  });

  it('ignores an empty API key override', () => {
    expect(detectBillingOverrides({ ANTHROPIC_API_KEY: '' })).toEqual([]);
  });
});
