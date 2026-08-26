import {
  developerBlockerReportSchema,
  developerCompletionReportSchema,
  idSchema,
} from '@mesh-session-platform/contracts';
import { describe, expect, it, vi } from 'vitest';

import { FakeClaudeSessionDriver } from './fake-driver.js';

const completionReport = developerCompletionReportSchema.parse({
  id: 'report-complete',
  cycleId: 'cycle-1',
  summary: 'Implemented the task.',
  criterionResults: [
    { criterionId: 'criterion-1', status: 'met' as const, evidence: 'Tested.' },
  ],
  verification: [],
  limitations: '',
  workspaceState: {
    summary: 'Focused changes.',
    hasUncommittedChanges: false,
    commitsCreated: true,
  },
  reviewerNotes: null,
  createdAt: '2026-08-25T12:00:00.000Z',
});

const blockerReport = developerBlockerReportSchema.parse({
  id: 'report-blocked',
  cycleId: 'cycle-1',
  reason: 'Human input required.',
  evidence: 'The required choice is absent.',
  attemptedWork: 'Inspected the available configuration.',
  suggestedHumanAction: 'Choose the target.',
  preserveWorkspace: true,
  createdAt: '2026-08-25T12:00:00.000Z',
});

describe('FakeClaudeSessionDriver', () => {
  it('emits queued events after being resumed and records session commands', async () => {
    const driver = new FakeClaudeSessionDriver();
    const session = await driver.create({ title: 'test' });
    const iterator = session.events()[Symbol.asyncIterator]();

    session.pause();
    session.enqueue({ kind: 'text_delta', text: 'queued' });
    const waiting = iterator.next();
    session.resumeEmission();

    await expect(waiting).resolves.toEqual({
      done: false,
      value: { kind: 'text_delta', text: 'queued' },
    });
    await session.sendPrompt('continue');
    await session.resolvePermission('permission-1', 'approve');

    expect(session.prompts).toEqual(['continue']);
    expect(session.permissionDecisions).toEqual([
      { requestId: 'permission-1', decision: 'approve' },
    ]);
  });

  it('simulates a subscription limit, streaming crash, and interruption acknowledgement', async () => {
    const driver = new FakeClaudeSessionDriver({ subscriptionLimit: 1 });
    await driver.create({ title: 'first' });
    await expect(driver.create({ title: 'second' })).rejects.toMatchObject({
      code: 'subscription_limit_reached',
    });

    const session = await new FakeClaudeSessionDriver().create({
      title: 'crash',
    });
    const iterator = session.events()[Symbol.asyncIterator]();
    session.crash(new Error('stream failed'));
    await expect(iterator.next()).rejects.toThrow('stream failed');

    await session.interrupt();
    expect(session.interrupted).toBe(true);
  });

  it('retains Developer configuration, delivers initial prompts once, and invokes controls directly', async () => {
    const submitForReview = vi.fn(async () => undefined);
    const markBlocked = vi.fn(async () => undefined);
    const developer = {
      initialPrompt: 'Execute the assigned task.',
      controls: { submitForReview, markBlocked },
    };
    const driver = new FakeClaudeSessionDriver();

    const created = await driver.create({ title: 'Developer', developer });
    const resumed = await driver.resume({
      claudeResumeId: 'resume-developer',
      developer,
    });
    const {
      id: completionId,
      cycleId: completionCycle,
      createdAt: completionAt,
      ...completionEvidence
    } = completionReport;
    const {
      id: blockerId,
      cycleId: blockerCycle,
      createdAt: blockerAt,
      ...blockerEvidence
    } = blockerReport;
    void completionId;
    void completionCycle;
    void completionAt;
    void blockerId;
    void blockerCycle;
    void blockerAt;
    await driver.submitForReview(0, {
      idempotencyKey: idSchema.parse('submit-1'),
      ...completionEvidence,
    });
    await driver.markBlocked(1, {
      idempotencyKey: idSchema.parse('blocked-1'),
      ...blockerEvidence,
    });

    expect(driver.createdRequests[0]?.developer).toBe(developer);
    expect(driver.resumedRequests[0]?.developer).toBe(developer);
    expect(created.prompts).toEqual(['Execute the assigned task.']);
    expect(resumed.prompts).toEqual(['Execute the assigned task.']);
    expect(submitForReview).toHaveBeenCalledOnce();
    expect(submitForReview).toHaveBeenCalledWith({
      idempotencyKey: 'submit-1',
      ...completionEvidence,
    });
    expect(markBlocked).toHaveBeenCalledOnce();
    expect(markBlocked).toHaveBeenCalledWith({
      idempotencyKey: 'blocked-1',
      ...blockerEvidence,
    });
  });
});
