import type { ProjectPlanProposalInput } from '@mesh-session-platform/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  PlanningCapabilityRegistry,
  type PlanningCapabilityBinding,
  type PlanningCapabilityContext,
} from './planning-capability-registry.js';

const binding: PlanningCapabilityBinding = {
  planId: 'plan-1',
  planRevision: 4,
  sessionId: 'session-1',
  baseId: 'base-3',
  policyVersion: 'pm-read-only-v1',
  generation: 6,
  expiresAt: '2026-08-27T12:10:00.000Z',
};

const context: PlanningCapabilityContext = {
  planId: binding.planId,
  planRevision: binding.planRevision,
  sessionId: binding.sessionId,
  baseId: binding.baseId,
  policyVersion: binding.policyVersion,
  generation: binding.generation,
};

const proposal: ProjectPlanProposalInput = {
  tasks: [],
  dependencies: [],
  assumptions: [],
  risks: [],
  exclusions: [],
};

const registry = () =>
  new PlanningCapabilityRegistry({
    now: () => new Date('2026-08-27T12:00:00.000Z'),
  });

describe('PlanningCapabilityRegistry', () => {
  it.each([
    ['planId', 'other-plan'],
    ['planRevision', 5],
    ['sessionId', 'other-session'],
    ['baseId', 'other-base'],
    ['policyVersion', 'other-policy'],
    ['generation', 7],
  ] as const)(
    'rejects a mismatched %s without invoking or consuming the capability',
    async (field, value) => {
      const capabilities = registry();
      const token = capabilities.issue(binding);
      const accept = vi.fn(async () => 'accepted');

      await expect(
        capabilities.submit({
          token,
          context: { ...context, [field]: value },
          proposal,
          accept,
        }),
      ).rejects.toMatchObject({ code: 'planning_capability_mismatch' });
      expect(accept).not.toHaveBeenCalled();

      await expect(
        capabilities.submit({ token, context, proposal, accept }),
      ).resolves.toBe('accepted');
      expect(accept).toHaveBeenCalledOnce();
    },
  );

  it('rejects an invalid payload without consuming the generation', async () => {
    const capabilities = registry();
    const token = capabilities.issue(binding);
    const accept = vi.fn(async () => 'accepted');

    await expect(
      capabilities.submit({ token, context, proposal: {}, accept }),
    ).rejects.toMatchObject({
      code: 'planning_proposal_invalid',
      problems: expect.any(Array),
    });
    expect(accept).not.toHaveBeenCalled();

    await expect(
      capabilities.submit({ token, context, proposal, accept }),
    ).resolves.toBe('accepted');
    expect(accept).toHaveBeenCalledOnce();
  });

  it('expires and removes a capability before submission', async () => {
    const capabilities = new PlanningCapabilityRegistry({
      now: () => new Date('2026-08-27T12:10:00.000Z'),
    });
    const token = capabilities.issue(binding);
    const accept = vi.fn(async () => undefined);

    await expect(
      capabilities.submit({ token, context, proposal, accept }),
    ).rejects.toMatchObject({ code: 'planning_capability_expired' });
    await expect(
      capabilities.submit({ token, context, proposal, accept }),
    ).rejects.toMatchObject({ code: 'planning_capability_invalid' });
    expect(accept).not.toHaveBeenCalled();
  });

  it('loses capabilities across registry restart and explicit session invalidation', async () => {
    const original = registry();
    const tokenLostOnRestart = original.issue(binding);
    const restarted = registry();
    const accept = vi.fn(async () => undefined);

    await expect(
      restarted.submit({
        token: tokenLostOnRestart,
        context,
        proposal,
        accept,
      }),
    ).rejects.toMatchObject({ code: 'planning_capability_invalid' });

    const tokenInvalidatedWithSession = original.issue({
      ...binding,
      generation: 7,
    });
    original.invalidateSession(binding.sessionId);
    await expect(
      original.submit({
        token: tokenInvalidatedWithSession,
        context: { ...context, generation: 7 },
        proposal,
        accept,
      }),
    ).rejects.toMatchObject({ code: 'planning_capability_invalid' });
    expect(accept).not.toHaveBeenCalled();
  });

  it('consumes an accepted generation exactly once under concurrent and replayed calls', async () => {
    const capabilities = registry();
    const token = capabilities.issue(binding);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const accept = vi.fn(async () => {
      await blocked;
      return 'accepted';
    });

    const first = capabilities.submit({ token, context, proposal, accept });
    await expect(
      capabilities.submit({ token, context, proposal, accept }),
    ).rejects.toMatchObject({ code: 'planning_capability_in_use' });
    release();
    await expect(first).resolves.toBe('accepted');
    await expect(
      capabilities.submit({ token, context, proposal, accept }),
    ).rejects.toMatchObject({ code: 'planning_capability_invalid' });
    expect(accept).toHaveBeenCalledOnce();
  });

  it('fails closed instead of issuing two tokens for one generation', async () => {
    const capabilities = registry();
    const token = capabilities.issue(binding);
    const accept = vi.fn(async () => 'accepted');

    expect(() => capabilities.issue({ ...binding })).toThrow(
      'Planning capability generation has already been issued',
    );
    await expect(
      capabilities.submit({ token, context, proposal, accept }),
    ).resolves.toBe('accepted');
    expect(accept).toHaveBeenCalledOnce();
  });

  it('restores a generation when the submission callback rejects', async () => {
    const capabilities = registry();
    const token = capabilities.issue(binding);
    const rejected = Object.assign(new Error('Proposal needs correction.'), {
      code: 'planning_proposal_invalid',
    });
    const accept = vi
      .fn<(input: ProjectPlanProposalInput) => Promise<string>>()
      .mockRejectedValueOnce(rejected)
      .mockResolvedValueOnce('accepted');

    await expect(
      capabilities.submit({ token, context, proposal, accept }),
    ).rejects.toBe(rejected);
    await expect(
      capabilities.submit({ token, context, proposal, accept }),
    ).resolves.toBe('accepted');
    expect(accept).toHaveBeenCalledTimes(2);
  });
});
