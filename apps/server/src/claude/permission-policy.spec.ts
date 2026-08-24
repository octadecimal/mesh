import { describe, expect, it } from 'vitest';

import { permissionPolicy } from './permission-policy.js';

describe('permissionPolicy', () => {
  it('always prompts in interactive mode', () => {
    expect(permissionPolicy('interactive').decide({ toolName: 'Read', input: { path: 'x' } })).toEqual({
      action: 'prompt',
    });
  });

  it('delegates in inherit mode', () => {
    expect(permissionPolicy('inherit').decide({ toolName: 'Write', input: { path: 'x' } })).toEqual({
      action: 'delegate',
    });
  });

  it('safe auto-approval requires an explicitly classified read-only tool', () => {
    expect(permissionPolicy('safe_auto').decide({ toolName: 'unknown', input: {} })).toEqual({
      action: 'prompt',
    });
  });

  it('safe auto approves only a valid Read request and prompts on an ambiguous input', () => {
    expect(permissionPolicy('safe_auto').decide({ toolName: 'Read', input: { path: 'src/main.ts' } })).toEqual({
      action: 'approve',
    });
    expect(permissionPolicy('safe_auto').decide({ toolName: 'Read', input: { path: 3 } })).toEqual({
      action: 'prompt',
    });
  });
});
