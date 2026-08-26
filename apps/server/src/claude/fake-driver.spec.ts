import {
  developerBlockerReportSchema,
  developerCompletionReportSchema,
  idSchema,
  qaReportInputSchema,
} from '@mesh-session-platform/contracts';
import { describe, expect, it, vi } from 'vitest';

import { FakeClaudeSessionDriver } from './fake-driver.js';
import type { RoleControlResponse } from './driver.js';

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

  it.each(['verified', 'rejected'] as const)(
    'consumes an explicitly configured QA %s step through the one role control',
    async (disposition) => {
      const report = qaReportInputSchema.parse({
        disposition,
        criterionResults: [
          {
            criterionId: 'criterion-1',
            status: disposition === 'verified' ? 'passed' : 'failed',
            evidence: `${disposition} evidence`,
          },
        ],
        verificationCommands: [
          { command: 'corepack pnpm test', outcome: 'passed' },
        ],
        limitations: [],
        residualRisks: [],
        workspaceBefore: 'source-state-1',
        workspaceAfter: 'source-state-1',
      });
      const execute = vi.fn(async () => ({
        content: [{ type: 'text' as const, text: '{"status":"submitted"}' }],
      }));
      const driver = new FakeClaudeSessionDriver({
        qaSteps: [{ type: `qa.${disposition}`, report }],
      });
      const session = await driver.create({
        title: 'QA',
        role: qaRole(execute),
      });

      const consuming = consume(session.events());
      await driver.drainQaSteps();
      await session.close();
      await consuming;

      expect(execute).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledWith(report);
    },
  );

  it('keeps an explicit QA wait step idle and reports an explicit startup failure', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: '{"status":"submitted"}' }],
    }));
    const waitingDriver = new FakeClaudeSessionDriver({
      qaSteps: [{ type: 'qa.wait' }],
    });
    const waitingSession = await waitingDriver.create({
      title: 'QA wait',
      role: qaRole(execute),
    });
    const consuming = consume(waitingSession.events());

    await waitingDriver.drainQaSteps();
    await waitingSession.close();
    await consuming;

    expect(execute).not.toHaveBeenCalled();

    const failingDriver = new FakeClaudeSessionDriver({
      qaSteps: [{ type: 'qa.startup_failure', message: 'QA could not start' }],
    });
    await expect(
      failingDriver.create({ title: 'QA failure', role: qaRole(execute) }),
    ).rejects.toThrow('QA could not start');
  });
});

const qaRole = (execute: (input: unknown) => Promise<RoleControlResponse>) => ({
  role: 'qa' as const,
  initialPrompt: 'Verify the Developer submission.',
  allowedTools: [
    'Read',
    'Glob',
    'Grep',
    'Bash',
    'mcp__mesh_qa__submit_qa_verdict',
  ],
  disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
  controlServer: {
    name: 'mesh_qa',
    version: '1',
    tools: [
      {
        name: 'submit_qa_verdict',
        description: 'Submit one structured QA verdict.',
        inputSchema: qaReportInputSchema.shape,
        execute,
      },
    ],
  },
});

const consume = async (events: AsyncIterable<unknown>): Promise<void> => {
  const iterator = events[Symbol.asyncIterator]();
  while (!(await iterator.next()).done) {
    // QA fake steps use the role control rather than synthetic transcript events.
  }
};
