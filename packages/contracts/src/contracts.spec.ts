import { describe, expect, it } from 'vitest';

import {
  blockedConditionSchema,
  compareCodeUnits,
  commandSchema,
  commandEnvelopeSchema,
  developerBlockerReportSchema,
  developerCompletionReportSchema,
  developerExecutionCycleSchema,
  developerReviewFeedbackSchema,
  projectEventSchema,
  projectHistorySchema,
  projectRunChangedEventSchema,
  projectRunItemSchema,
  projectRunSchema,
  projectPlanDetailsSchema,
  projectPlanHistoryPageSchema,
  projectPlanProposalSchema,
  projectPlanSchema,
  projectPlanSummarySchema,
  projectSchema,
  projectSnapshotSchema,
  qaExecutionCycleSchema,
  qaReportInputSchema,
  qaReportSchema,
  reviewPolicySchema,
  serverMessageSchema,
  sessionDiagnosticsSchema,
  sessionEventSchema,
  sessionHistorySchema,
  sessionSnapshotSchema,
  sessionSchema,
  stableTaskErrorCodeSchema,
  taskDependencySchema,
  taskReadinessProblemSchema,
  taskActorSchema,
  taskAttemptSourceSchema,
  taskAttemptSchema,
  taskCommandSchema,
  taskSchema,
  taskTransitionSchema,
  mutatingCommandSchema,
} from './index.js';

describe('session platform contracts', () => {
  const now = '2026-08-25T00:00:00.000Z';
  const actor = { type: 'human' as const, id: 'operator-1' };

  it.each(['project_run_stale', 'project_run_not_controllable'] as const)(
    'accepts the canonical %s operator-control error code',
    (code) => {
      expect(stableTaskErrorCodeSchema.parse(code)).toBe(code);
    },
  );

  it('accepts lightweight backlog tasks and rejects an empty blocked reason', () => {
    expect(
      taskSchema.parse({
        id: 'task-1',
        projectId: 'project-1',
        title: 'Add retry controls',
        description: '',
        acceptanceCriteria: [],
        priority: 'normal',
        rank: 'm',
        lifecycleState: 'backlog',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    ).toMatchObject({ lifecycleState: 'backlog', revision: 1 });

    expect(() =>
      blockedConditionSchema.parse({ reason: ' ', actor, blockedAt: now }),
    ).toThrow();
  });

  it('limits task priority, attempt sources, and transition audit fields', () => {
    expect(() =>
      taskSchema.parse({
        id: 'task-1',
        projectId: 'project-1',
        title: 'Add retry controls',
        description: '',
        acceptanceCriteria: [],
        priority: 'immediate',
        rank: 'm',
        lifecycleState: 'backlog',
        labels: [],
        notes: '',
        blocked: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    ).toThrow();
    expect(
      taskAttemptSourceSchema.parse({
        type: 'project_run',
        runId: 'run-1',
        runItemId: 'item-1',
      }),
    ).toEqual({
      type: 'project_run',
      runId: 'run-1',
      runItemId: 'item-1',
    });
    expect(
      taskAttemptSchema.parse({
        id: 'attempt-1',
        taskId: 'task-1',
        sessionId: 'session-1',
        ordinal: 1,
        source: 'launched',
        actor,
        createdAt: now,
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
      }).source,
    ).toBe('launched');
    expect(() =>
      taskAttemptSchema.parse({
        id: 'attempt-1',
        taskId: 'task-1',
        sessionId: 'session-1',
        ordinal: 1,
        source: 'automatic',
        actor,
        createdAt: now,
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
      }),
    ).toThrow();
    expect(
      taskTransitionSchema.parse({
        id: 'transition-1',
        taskId: 'task-1',
        commandId: 'command-1',
        previousState: 'ready',
        nextState: 'in_progress',
        actor,
        reason: null,
        occurredAt: now,
      }),
    ).toMatchObject({
      commandId: 'command-1',
      previousState: 'ready',
      nextState: 'in_progress',
    });
  });

  it('decodes legacy projects while extending project metadata', () => {
    const legacy = projectSchema.parse({
      id: 'project-1',
      displayName: 'Mesh',
      repositoryPath: 'C:/code/mesh',
      discoveredAt: now,
    });

    expect(legacy).toMatchObject({
      repositoryIdentity: 'C:/code/mesh',
      revision: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
  });

  it('accepts task, project, and attempt command variants with revision and actor metadata', () => {
    expect(
      taskCommandSchema.parse({
        type: 'task.transition',
        payload: {
          taskId: 'task-1',
          expectedRevision: 3,
          nextState: 'review',
          reason: 'Acceptance criteria implemented',
          actor,
        },
      }),
    ).toMatchObject({ type: 'task.transition' });

    for (const command of [
      {
        type: 'project.import',
        payload: { repositoryPath: 'C:/code/mesh', actor },
      },
      {
        type: 'project.archive',
        payload: { projectId: 'project-1', expectedRevision: 1, actor },
      },
      {
        type: 'project.restore',
        payload: { projectId: 'project-1', expectedRevision: 2, actor },
      },
      {
        type: 'task.create',
        payload: { projectId: 'project-1', title: 'Draft', actor },
      },
      {
        type: 'task.edit',
        payload: {
          taskId: 'task-1',
          expectedRevision: 1,
          patch: { description: 'Ready to describe.' },
          actor,
        },
      },
      {
        type: 'task.reorder',
        payload: { taskId: 'task-1', expectedRevision: 1, rank: 'n', actor },
      },
      {
        type: 'task.block',
        payload: {
          taskId: 'task-1',
          expectedRevision: 1,
          reason: 'Waiting on a decision',
          actor,
        },
      },
      {
        type: 'task.unblock',
        payload: {
          taskId: 'task-1',
          expectedRevision: 2,
          reason: 'Dependency delivered',
          actor,
        },
      },
      {
        type: 'task.attempt.launch',
        payload: {
          taskId: 'task-1',
          expectedRevision: 2,
          title: 'Implement retry controls',
          permissionMode: 'interactive',
          workspace: { type: 'shared', path: 'C:/code/mesh' },
          actor,
        },
      },
      {
        type: 'task.attempt.link',
        payload: {
          taskId: 'task-1',
          expectedRevision: 2,
          sessionId: 'session-1',
          actor,
        },
      },
      {
        type: 'task.attempt.unlink',
        payload: {
          taskId: 'task-1',
          expectedRevision: 2,
          attemptId: 'attempt-1',
          reason: 'Linked to the wrong task',
          actor,
        },
      },
    ]) {
      expect(() =>
        commandSchema.parse({ protocolVersion: 1, ...command }),
      ).toThrow();
      expect(
        commandEnvelopeSchema.parse({
          protocolVersion: 1,
          idempotencyKey: 'command-1',
          command,
        }).command.type,
      ).toBe(command.type);
    }
  });

  it('requires a non-empty reason when unblocking a task', () => {
    const envelope = (reason: string | undefined) => ({
      protocolVersion: 1,
      idempotencyKey: 'unblock-command-1',
      command: {
        type: 'task.unblock' as const,
        payload: {
          taskId: 'task-1',
          expectedRevision: 2,
          reason,
          actor,
        },
      },
    });

    expect(
      commandEnvelopeSchema.parse(envelope('Dependency delivered')),
    ).toMatchObject({
      command: { payload: { reason: 'Dependency delivered' } },
    });
    expect(() => commandEnvelopeSchema.parse(envelope(undefined))).toThrow();
    expect(() => commandEnvelopeSchema.parse(envelope('  '))).toThrow();
  });

  it('parses ordered project events, snapshots, history, and project realtime messages', () => {
    const project = projectSchema.parse({
      id: 'project-1',
      displayName: 'Mesh',
      repositoryPath: 'C:/code/mesh',
      repositoryIdentity: 'repo:mesh',
      discoveredAt: now,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    const task = taskSchema.parse({
      id: 'task-1',
      projectId: 'project-1',
      title: 'Add retry controls',
      description: '',
      acceptanceCriteria: [],
      priority: 'normal',
      rank: 'm',
      lifecycleState: 'backlog',
      labels: [],
      notes: '',
      blocked: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    const event = projectEventSchema.parse({
      protocolVersion: 1,
      id: 'project-event-1',
      projectId: 'project-1',
      sequence: 1,
      occurredAt: now,
      type: 'task.changed',
      payload: { task },
    });

    expect(
      projectSnapshotSchema.parse({
        protocolVersion: 1,
        project,
        tasks: [task],
        attempts: [],
        transitions: [],
        repairs: [],
        cursor: 1,
      }).cursor,
    ).toBe(1);
    expect(
      projectHistorySchema.parse({
        protocolVersion: 1,
        projectId: 'project-1',
        events: [event],
        cursor: 1,
      }).cursor,
    ).toBe(1);
    expect(() =>
      projectHistorySchema.parse({
        protocolVersion: 1,
        projectId: 'project-2',
        events: [event],
        cursor: 1,
      }),
    ).toThrow();
    expect(() =>
      projectHistorySchema.parse({
        protocolVersion: 1,
        projectId: 'project-1',
        events: [{ ...event, id: 'project-event-2', sequence: 2 }, event],
        cursor: 2,
      }),
    ).toThrow();
    expect(
      serverMessageSchema.parse({
        protocolVersion: 1,
        type: 'project.event',
        payload: { event },
      }).type,
    ).toBe('project.event');
    expect(
      serverMessageSchema.parse({
        protocolVersion: 1,
        type: 'project.resync_required',
        payload: { projectId: 'project-1', reason: 'cursor gap' },
      }).type,
    ).toBe('project.resync_required');
    expect(taskActorSchema.parse(actor)).toEqual(actor);
  });

  it('parses durable attempt repair project events', () => {
    const event = projectEventSchema.parse({
      protocolVersion: 1,
      id: 'project-event-repair-1',
      projectId: 'project-1',
      sequence: 4,
      occurredAt: now,
      type: 'task.attempt_repair_detected',
      payload: {
        repair: {
          taskId: 'task-1',
          attemptId: 'attempt-1',
          sessionId: 'session-1',
          reason: 'startup_outcome_unknown',
        },
      },
    });

    expect(event).toMatchObject({
      type: 'task.attempt_repair_detected',
      payload: {
        repair: {
          attemptId: 'attempt-1',
          reason: 'startup_outcome_unknown',
        },
      },
    });
    expect(
      projectHistorySchema.parse({
        protocolVersion: 1,
        projectId: 'project-1',
        events: [event],
        cursor: 4,
      }).events[0],
    ).toEqual(event);
  });

  it('parses complete immutable Developer execution records', () => {
    const cycle = {
      id: 'developer-cycle-1',
      attemptId: 'attempt-1',
      ordinal: 1,
      mode: 'new' as const,
      authorizedBy: actor,
      authorizationCommandId: 'command-launch-1',
      policyVersion: 'developer-policy-v1',
      projectInstructions: { content: 'Run focused tests.', revision: 2 },
      taskSnapshot: {
        revision: 3,
        title: 'Implement the execution model',
        description: 'Implement the execution model.',
        acceptanceCriteria: [{ id: 'criterion-1', text: 'Contracts compile.' }],
      },
      workspaceId: 'workspace-1',
      permissionMode: 'safe_auto' as const,
      startedAt: now,
      endedAt: null,
      terminalDisposition: null,
      completionReportId: null,
      blockerReportId: null,
      terminalCommandId: null,
      terminalEventId: null,
    };
    const completionReport = {
      id: 'completion-report-1',
      cycleId: 'developer-cycle-1',
      summary: 'Added the Developer execution contracts.',
      criterionResults: [
        {
          criterionId: 'criterion-1',
          status: 'met' as const,
          evidence: 'corepack pnpm nx typecheck contracts',
        },
      ],
      verification: [
        {
          command: 'corepack pnpm nx test contracts',
          outcome: 'passed' as const,
          output: 'All contract tests passed.',
        },
      ],
      limitations: 'None.',
      workspaceState: {
        summary: 'Clean worktree.',
        hasUncommittedChanges: false,
        commitsCreated: true,
      },
      reviewerNotes: null,
      createdAt: now,
    };

    for (const [schema, record] of [
      [developerExecutionCycleSchema, cycle],
      [developerCompletionReportSchema, completionReport],
      [
        developerBlockerReportSchema,
        {
          id: 'blocker-report-1',
          cycleId: 'developer-cycle-1',
          reason: 'Missing repository access.',
          evidence: 'The repository identity could not be resolved.',
          attemptedWork: 'Retried resolution with the configured path.',
          suggestedHumanAction: 'Confirm the repository is available.',
          preserveWorkspace: true,
          createdAt: now,
        },
      ],
      [
        developerReviewFeedbackSchema,
        {
          id: 'feedback-1',
          cycleId: 'developer-cycle-1',
          taskId: 'task-1',
          kind: 'rejection',
          feedback: 'Please add a regression test.',
          actor,
          commandId: 'command-reject-1',
          createdAt: now,
        },
      ],
    ] as const) {
      expect(schema.parse(record)).toMatchObject(record);
    }

    expect(() =>
      developerCompletionReportSchema.parse({
        ...completionReport,
        criterionResults: [],
      }),
    ).toThrow();
    expect(() =>
      developerExecutionCycleSchema.parse({
        ...cycle,
        terminalDisposition: 'blocked',
      }),
    ).toThrow();
    expect(
      developerExecutionCycleSchema.parse({ ...cycle, endedAt: now }),
    ).toMatchObject({ endedAt: now, terminalDisposition: null });
    expect(() =>
      developerReviewFeedbackSchema.parse({
        id: 'feedback-agent-1',
        cycleId: 'developer-cycle-1',
        taskId: 'task-1',
        kind: 'rejection',
        feedback: 'Please add a regression test.',
        actor: { type: 'agent', id: 'developer-1' },
        commandId: 'command-reject-1',
        createdAt: now,
      }),
    ).toThrow();
    const policyFeedback = {
      id: 'feedback-policy-1',
      cycleId: 'developer-cycle-1',
      taskId: 'task-1',
      kind: 'rejection' as const,
      feedback: 'criterion-1: Regression failed.',
      actor: { type: 'system' as const, id: 'review-loop' },
      commandId: 'command-policy-reject-1',
      createdAt: now,
    };
    expect(developerReviewFeedbackSchema.parse(policyFeedback)).toMatchObject({
      actor: { type: 'system', id: 'review-loop' },
      kind: 'rejection',
    });
    expect(() =>
      developerReviewFeedbackSchema.parse({
        ...policyFeedback,
        kind: 'unblock',
      }),
    ).toThrow();
  });

  it('requires each snapshotted criterion exactly once at the Developer event boundary', () => {
    const task = {
      id: 'task-1',
      projectId: 'project-1',
      title: 'Implement the execution model',
      description: 'Add the Developer execution contracts.',
      acceptanceCriteria: ['Contracts compile.', 'Tests pass.'],
      priority: 'normal' as const,
      rank: 'm',
      lifecycleState: 'review' as const,
      labels: [],
      notes: '',
      blocked: null,
      revision: 3,
      createdAt: now,
      updatedAt: now,
    };
    const attempt = {
      id: 'attempt-1',
      taskId: 'task-1',
      sessionId: 'session-1',
      ordinal: 1,
      source: 'launched' as const,
      actor,
      createdAt: now,
      unlinkedAt: null,
      unlinkedBy: null,
      unlinkReason: null,
      role: 'developer' as const,
    };
    const cycle = {
      id: 'developer-cycle-1',
      attemptId: 'attempt-1',
      ordinal: 1,
      mode: 'new' as const,
      authorizedBy: actor,
      authorizationCommandId: 'command-launch-1',
      policyVersion: 'developer-policy-v1',
      projectInstructions: { content: '', revision: 1 },
      taskSnapshot: {
        revision: 3,
        title: 'Implement the execution model',
        description: 'Add the Developer execution contracts.',
        acceptanceCriteria: [
          { id: 'criterion-1', text: 'Contracts compile.' },
          { id: 'criterion-2', text: 'Tests pass.' },
        ],
      },
      workspaceId: 'workspace-1',
      permissionMode: 'safe_auto' as const,
      startedAt: now,
      endedAt: now,
      terminalDisposition: 'submitted_for_review' as const,
      completionReportId: 'completion-report-1',
      blockerReportId: null,
      terminalCommandId: 'developer-command-1',
      terminalEventId: 'project-event-1',
    };
    const report = {
      id: 'completion-report-1',
      cycleId: 'developer-cycle-1',
      summary: 'Added the Developer execution contracts.',
      criterionResults: [
        {
          criterionId: 'criterion-1',
          status: 'met' as const,
          evidence: 'corepack pnpm nx typecheck contracts',
        },
        {
          criterionId: 'criterion-2',
          status: 'met' as const,
          evidence: 'corepack pnpm nx test contracts',
        },
      ],
      verification: [],
      limitations: '',
      workspaceState: {
        summary: 'Clean worktree.',
        hasUncommittedChanges: false,
        commitsCreated: true,
      },
      reviewerNotes: null,
      createdAt: now,
    };
    const event = {
      protocolVersion: 1,
      id: 'project-event-1',
      projectId: 'project-1',
      sequence: 1,
      occurredAt: now,
      type: 'task.developer_execution_changed' as const,
      payload: {
        task,
        attempt,
        cycle,
        completionReport: report,
        blockerReport: null,
        reviewFeedback: null,
      },
    };

    expect(projectEventSchema.parse(event)).toMatchObject(event);
    const { title: _legacyTitle, ...legacyTaskSnapshot } =
      event.payload.cycle.taskSnapshot;
    const legacyEvent = {
      ...event,
      id: 'project-event-legacy-developer-cycle',
      payload: {
        ...event.payload,
        cycle: {
          ...event.payload.cycle,
          taskSnapshot: legacyTaskSnapshot,
        },
      },
    };
    expect(
      projectEventSchema.parse(legacyEvent).payload.cycle.taskSnapshot.title,
    ).toBe('');
    expect(() =>
      projectEventSchema.parse({
        ...event,
        payload: {
          ...event.payload,
          completionReport: {
            ...report,
            criterionResults: [report.criterionResults[0]],
          },
        },
      }),
    ).toThrow();
    expect(() =>
      projectEventSchema.parse({
        ...event,
        payload: {
          ...event.payload,
          completionReport: {
            ...report,
            criterionResults: [
              report.criterionResults[0],
              { ...report.criterionResults[0], status: 'not_met' as const },
            ],
          },
        },
      }),
    ).toThrow();
  });

  it('requires an agent actor for scoped Developer commands', () => {
    const command = {
      type: 'task.developer.submit_review' as const,
      payload: {
        capability: 'developer-capability-1',
        expectedRevision: 3,
        report: {
          id: 'completion-report-1',
          cycleId: 'developer-cycle-1',
          summary: 'Added the Developer execution contracts.',
          criterionResults: [
            {
              criterionId: 'criterion-1',
              status: 'met' as const,
              evidence: 'corepack pnpm nx typecheck contracts',
            },
          ],
          verification: [
            {
              command: 'corepack pnpm nx test contracts',
              outcome: 'passed' as const,
              output: 'All contract tests passed.',
            },
          ],
          limitations: 'None.',
          workspaceState: {
            summary: 'Clean worktree.',
            hasUncommittedChanges: false,
            commitsCreated: true,
          },
          reviewerNotes: null,
          createdAt: now,
        },
        actor: { type: 'agent' as const, id: 'developer-1' },
      },
    };

    expect(
      commandEnvelopeSchema.parse({
        protocolVersion: 1,
        idempotencyKey: 'developer-command-1',
        command,
      }).command.type,
    ).toBe('task.developer.submit_review');
    expect(() =>
      commandEnvelopeSchema.parse({
        protocolVersion: 1,
        idempotencyKey: 'developer-command-2',
        command: { ...command, payload: { ...command.payload, actor } },
      }),
    ).toThrow();
  });

  it('decodes Milestone 2 project and attempt payloads with Developer defaults', () => {
    const oldProject = {
      id: 'project-1',
      displayName: 'Mesh',
      repositoryPath: 'C:/code/mesh',
      discoveredAt: now,
      updatedAt: now,
    };
    const oldAttempt = {
      id: 'attempt-1',
      taskId: 'task-1',
      sessionId: 'session-1',
      ordinal: 1,
      source: 'launched' as const,
      actor,
      createdAt: now,
      unlinkedAt: null,
      unlinkedBy: null,
      unlinkReason: null,
    };

    expect(projectSchema.parse(oldProject).developerInstructions).toEqual({
      content: '',
      revision: 1,
      updatedAt: oldProject.updatedAt,
      updatedBy: null,
    });
    expect(taskAttemptSchema.parse(oldAttempt).role).toBeNull();
  });

  it('rejects a mutating command without an idempotency key', () => {
    expect(() =>
      commandEnvelopeSchema.parse({
        type: 'session.prompt',
        payload: { sessionId: 's1', prompt: 'hi' },
      }),
    ).toThrow();
  });

  it('requires a positive per-session event sequence', () => {
    expect(() =>
      sessionEventSchema.parse({
        id: 'e1',
        sessionId: 's1',
        sequence: 0,
        occurredAt: '2026-08-23T00:00:00.000Z',
        type: 'session.status',
        payload: { from: 'idle', to: 'running' },
      }),
    ).toThrow();
  });

  it('accepts the complete lifecycle vocabulary', () => {
    for (const lifecycleState of [
      'idle',
      'starting',
      'running',
      'waiting_for_approval',
      'interrupting',
      'completed',
      'failed',
      'interrupted',
      'archived',
    ]) {
      expect(
        sessionSchema.parse({
          id: 's1',
          projectId: 'p1',
          workspaceId: 'w1',
          title: 'Session',
          permissionMode: 'interactive',
          lifecycleState,
          createdAt: '2026-08-23T00:00:00.000Z',
          updatedAt: '2026-08-23T00:00:00.000Z',
        }).lifecycleState,
      ).toBe(lifecycleState);
    }
  });

  it('accepts mutating commands only inside an idempotent envelope', () => {
    const mutatingCommands = [
      {
        type: 'session.create',
        payload: {
          projectId: 'p1',
          workspaceId: 'w1',
          title: 'Session',
          permissionMode: 'interactive',
        },
      },
      {
        type: 'session.resume',
        payload: {
          sessionId: 's1',
          workspaceId: 'w1',
          permissionMode: 'safe_auto',
        },
      },
      { type: 'session.prompt', payload: { sessionId: 's1', prompt: 'hi' } },
      { type: 'session.interrupt', payload: { sessionId: 's1' } },
      {
        type: 'permission.decide',
        payload: { permissionId: 'p1', decision: 'approve' },
      },
      { type: 'session.archive', payload: { sessionId: 's1' } },
      { type: 'session.delete', payload: { sessionId: 's1', confirmed: true } },
      {
        type: 'layout.save',
        payload: {
          id: 'l1',
          dockview: {},
          updatedAt: '2026-08-23T00:00:00.000Z',
        },
      },
    ] as const;

    for (const command of mutatingCommands) {
      expect(() =>
        commandSchema.parse({ protocolVersion: 1, ...command }),
      ).toThrow();
      expect(
        commandEnvelopeSchema.parse({
          protocolVersion: 1,
          idempotencyKey: 'key-1',
          command,
        }).command.type,
      ).toBe(command.type);
    }
  });

  it('preserves the existing session.create envelope', () => {
    expect(
      commandEnvelopeSchema.parse({
        protocolVersion: 1,
        idempotencyKey: 'legacy-create',
        command: {
          type: 'session.create',
          payload: {
            projectId: 'p1',
            workspaceId: 'w1',
            title: 'Legacy',
            permissionMode: 'interactive',
          },
        },
      }).command.payload,
    ).toMatchObject({ workspaceId: 'w1' });
  });

  it('accepts shared and worktree session.create variants', () => {
    const shared = {
      type: 'session.create' as const,
      payload: {
        projectId: 'p1',
        title: 'Shared',
        permissionMode: 'interactive' as const,
        workspace: { type: 'shared' as const, path: 'C:/code/mesh' },
      },
    };
    const worktree = {
      type: 'session.create' as const,
      payload: {
        projectId: 'p1',
        title: 'Worktree',
        permissionMode: 'safe_auto' as const,
        workspace: {
          type: 'worktree' as const,
          repositoryPath: 'C:/code/mesh',
          path: 'C:/code/mesh-worktree',
          branch: 'feature/http',
          startPoint: 'main',
        },
      },
    };

    for (const command of [shared, worktree]) {
      expect(
        commandEnvelopeSchema.parse({
          protocolVersion: 1,
          idempotencyKey: `${command.payload.workspace.type}-create`,
          command,
        }).command,
      ).toEqual(command);
      expect(() =>
        commandSchema.parse({ protocolVersion: 1, ...command }),
      ).toThrow();
    }
  });

  it('rejects malformed expanded session.create variants', () => {
    const envelope = (workspace: unknown) => ({
      protocolVersion: 1,
      idempotencyKey: 'malformed-create',
      command: {
        type: 'session.create',
        payload: {
          projectId: 'p1',
          title: 'Malformed',
          permissionMode: 'interactive',
          workspace,
        },
      },
    });

    expect(() =>
      commandEnvelopeSchema.parse(envelope({ type: 'shared', path: '' })),
    ).toThrow();
    expect(() =>
      commandEnvelopeSchema.parse(
        envelope({
          type: 'worktree',
          repositoryPath: 'C:/code/mesh',
          path: 'C:/code/worktree',
          branch: '',
          startPoint: 'main',
        }),
      ),
    ).toThrow();
    expect(() =>
      commandEnvelopeSchema.parse({
        ...envelope({ type: 'shared', path: 'C:/code/mesh' }),
        protocolVersion: 2,
      }),
    ).toThrow();
  });

  it('rejects missing and unsupported protocol versions at every wire boundary', () => {
    const event = {
      protocolVersion: 1,
      id: 'e1',
      sessionId: 's1',
      sequence: 1,
      occurredAt: '2026-08-23T00:00:00.000Z',
      type: 'message.user' as const,
      payload: { text: 'hi' },
    };
    const snapshot = {
      protocolVersion: 1,
      projects: [],
      workspaces: [],
      sessions: [],
      events: [],
    };
    const serverMessage = {
      protocolVersion: 1,
      type: 'snapshot' as const,
      payload: snapshot,
    };
    const history = { protocolVersion: 1, sessionId: 's1', events: [] };
    const diagnostics = {
      protocolVersion: 1,
      sessionId: 's1',
      diagnostics: [],
    };
    const readCommand = {
      protocolVersion: 1,
      type: 'session.history' as const,
      payload: { sessionId: 's1' },
    };

    expect(() =>
      sessionEventSchema.parse({ ...event, protocolVersion: 0 }),
    ).toThrow();
    expect(() =>
      sessionEventSchema.parse({ ...event, protocolVersion: undefined }),
    ).toThrow();
    expect(() =>
      sessionSnapshotSchema.parse({ ...snapshot, protocolVersion: 0 }),
    ).toThrow();
    expect(() =>
      sessionSnapshotSchema.parse({ ...snapshot, protocolVersion: undefined }),
    ).toThrow();
    expect(() =>
      sessionHistorySchema.parse({ ...history, protocolVersion: 0 }),
    ).toThrow();
    expect(() =>
      sessionHistorySchema.parse({ ...history, protocolVersion: undefined }),
    ).toThrow();
    expect(() =>
      sessionDiagnosticsSchema.parse({ ...diagnostics, protocolVersion: 0 }),
    ).toThrow();
    expect(() =>
      sessionDiagnosticsSchema.parse({
        ...diagnostics,
        protocolVersion: undefined,
      }),
    ).toThrow();
    expect(() =>
      commandSchema.parse({ ...readCommand, protocolVersion: 0 }),
    ).toThrow();
    expect(() =>
      commandSchema.parse({ ...readCommand, protocolVersion: undefined }),
    ).toThrow();
    expect(() =>
      serverMessageSchema.parse({
        ...serverMessage,
        protocolVersion: 0,
      }),
    ).toThrow();
    expect(() =>
      serverMessageSchema.parse({
        ...serverMessage,
        protocolVersion: undefined,
      }),
    ).toThrow();

    expect(sessionEventSchema.parse(event).protocolVersion).toBe(1);
    expect(sessionSnapshotSchema.parse(snapshot).protocolVersion).toBe(1);
    expect(sessionHistorySchema.parse(history).protocolVersion).toBe(1);
    expect(sessionDiagnosticsSchema.parse(diagnostics).protocolVersion).toBe(1);
    expect(commandSchema.parse(readCommand).protocolVersion).toBe(1);
    expect(
      serverMessageSchema.parse(serverMessage).payload.protocolVersion,
    ).toBe(1);
  });

  it('accepts transient assistant text deltas on the realtime boundary', () => {
    expect(
      serverMessageSchema.parse({
        protocolVersion: 1,
        type: 'assistant.delta',
        payload: { sessionId: 's1', text: 'Hello' },
      }),
    ).toEqual({
      protocolVersion: 1,
      type: 'assistant.delta',
      payload: { sessionId: 's1', text: 'Hello' },
    });
  });

  describe('QA execution contracts', () => {
    const qaNow = '2026-08-26T00:00:00.000Z';
    const qaActor = { type: 'human' as const, id: 'human-1' };
    const milestone3Project = {
      id: 'project-1',
      displayName: 'Mesh',
      repositoryPath: 'C:/code/mesh',
      discoveredAt: qaNow,
      updatedAt: qaNow,
    };
    const milestone3Attempt = {
      id: 'attempt-1',
      taskId: 'task-1',
      sessionId: 'session-1',
      ordinal: 1,
      source: 'launched' as const,
      actor: qaActor,
      createdAt: qaNow,
      unlinkedAt: null,
      unlinkedBy: null,
      unlinkReason: null,
      role: 'developer' as const,
    };
    const report = {
      id: 'qa-report-1',
      cycleId: 'qa-cycle-1',
      disposition: 'verified' as const,
      criterionResults: [
        {
          criterionId: 'criterion-1',
          status: 'passed' as const,
          evidence: 'corepack pnpm nx test contracts',
        },
      ],
      verificationCommands: [
        { command: 'corepack pnpm nx test contracts', outcome: 'passed' },
      ],
      limitations: [],
      residualRisks: [],
      workspaceBefore: 'Clean worktree.',
      workspaceAfter: 'Clean worktree.',
      createdAt: qaNow,
    };

    it.each(['manual', 'autonomous_review'] as const)(
      'parses the %s review policy',
      (reviewPolicy) => {
        expect(reviewPolicySchema.parse(reviewPolicy)).toBe(reviewPolicy);
      },
    );

    it('rejects agent-supplied verification and workspace state', () => {
      expect(() =>
        qaReportInputSchema.parse({
          disposition: 'verified',
          criterionResults: report.criterionResults,
          limitations: [],
          residualRisks: [],
          verificationCommands: report.verificationCommands,
          workspaceBefore: 'agent-claimed-before',
          workspaceAfter: 'agent-claimed-after',
        }),
      ).toThrow();
    });

    it('requires exactly one QA result per snapshotted criterion at the event boundary', () => {
      const task = {
        id: 'task-1',
        projectId: 'project-1',
        title: 'Verify contracts',
        description: 'Add QA contracts.',
        acceptanceCriteria: ['Contracts compile.', 'Tests pass.'],
        priority: 'normal' as const,
        rank: 'm',
        lifecycleState: 'review' as const,
        labels: [],
        notes: '',
        blocked: null,
        revision: 3,
        createdAt: qaNow,
        updatedAt: qaNow,
      };
      const cycle = {
        id: 'qa-cycle-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        sessionId: 'qa-session-1',
        ordinal: 1,
        authorizedBy: qaActor,
        authorizationCommandId: 'qa-launch-1',
        policyVersion: 'qa-policy-v1',
        qaInstructions: { content: '', revision: 1 },
        taskSnapshot: {
          revision: 3,
          title: 'Verify contracts',
          description: 'Add QA contracts.',
          acceptanceCriteria: [
            { id: 'criterion-1', text: 'Contracts compile.' },
            { id: 'criterion-2', text: 'Tests pass.' },
          ],
        },
        developerCompletionReportId: 'completion-report-1',
        workspaceId: 'workspace-1',
        reviewPolicy: 'manual' as const,
        reviewPolicyRevision: 1,
        automationGeneration: 0,
        rejectionOrdinal: 0,
        startedAt: qaNow,
        endedAt: qaNow,
        terminalDisposition: 'verified' as const,
        reportId: 'qa-report-1',
        terminalCommandId: 'qa-verdict-1',
        terminalEventId: 'project-event-1',
      };
      const event = {
        protocolVersion: 1,
        id: 'project-event-1',
        projectId: 'project-1',
        sequence: 1,
        occurredAt: qaNow,
        type: 'task.qa_execution_changed' as const,
        payload: {
          task,
          attempt: milestone3Attempt,
          cycle,
          report: {
            ...report,
            criterionResults: [
              report.criterionResults[0],
              {
                criterionId: 'criterion-2',
                status: 'passed' as const,
                evidence: 'corepack pnpm nx test contracts',
              },
            ],
          },
        },
      };

      expect(projectEventSchema.parse(event)).toMatchObject(event);
      expect(() =>
        qaExecutionCycleSchema.parse({ ...cycle, endedAt: null }),
      ).toThrow();
      expect(() =>
        qaExecutionCycleSchema.parse({
          ...cycle,
          terminalDisposition: null,
        }),
      ).toThrow();
      expect(() =>
        qaExecutionCycleSchema.parse({
          ...cycle,
          endedAt: null,
          terminalDisposition: null,
          reportId: null,
          terminalCommandId: null,
          terminalEventId: null,
        }),
      ).not.toThrow();
      expect(() =>
        qaExecutionCycleSchema.parse({ ...cycle, reportId: null }),
      ).toThrow();
      expect(() =>
        projectEventSchema.parse({
          ...event,
          payload: {
            ...event.payload,
            report: { ...report, criterionResults: report.criterionResults },
          },
        }),
      ).toThrow();
    });

    it('rejects verified reports with failed or skipped criteria', () => {
      for (const status of ['failed', 'skipped'] as const) {
        expect(() =>
          qaReportSchema.parse({
            ...report,
            criterionResults: [
              { criterionId: 'criterion-1', status, evidence: 'test failed' },
            ],
          }),
        ).toThrow();
      }
    });

    it('decodes Milestone 3 projects and attempts with QA defaults', () => {
      expect(projectSchema.parse(milestone3Project).qaConfiguration).toEqual({
        instructions: {
          content: '',
          revision: 1,
          updatedAt: milestone3Project.updatedAt,
          updatedBy: null,
        },
        reviewPolicy: 'manual',
        revision: 1,
        updatedAt: milestone3Project.updatedAt,
        updatedBy: null,
      });
      expect(taskAttemptSchema.parse(milestone3Attempt).qaCycles).toEqual([]);
    });
  });

  describe('project run contracts', () => {
    const claimedAt = '2026-08-27T00:00:10.000Z';
    const startedAt = '2026-08-27T00:00:20.000Z';
    const finishedAt = '2026-08-27T00:01:00.000Z';
    const run = {
      id: 'run-1',
      projectId: 'project-1',
      state: 'running' as const,
      revision: 1,
      concurrency: 2,
      pauseReason: null,
      completionReason: null,
      startedAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
      completedAt: null,
      items: [
        {
          id: 'item-1',
          runId: 'run-1',
          projectId: 'project-1',
          taskId: 'task-1',
          taskRevision: 3,
          policyRevision: 2,
          taskAutomationStatus: 'enabled' as const,
          taskAutomationGeneration: 4,
          queuePosition: 0,
          status: 'queued' as const,
          outcomeReason: null,
          attemptId: null,
          sessionId: null,
          launchIdempotencyKey: 'run-1:item-1:launch',
          claimedAt: null,
          startedAt: null,
          finishedAt: null,
        },
      ],
    };

    const itemStates = [
      run.items[0],
      {
        ...run.items[0],
        status: 'launch_pending' as const,
        claimedAt,
      },
      {
        ...run.items[0],
        status: 'active' as const,
        claimedAt,
        startedAt,
        attemptId: 'attempt-1',
        sessionId: 'session-1',
      },
      {
        ...run.items[0],
        status: 'completed' as const,
        outcomeReason: 'task_done',
        claimedAt,
        startedAt,
        finishedAt,
        attemptId: 'attempt-1',
        sessionId: 'session-1',
      },
      {
        ...run.items[0],
        status: 'attention_required' as const,
        outcomeReason: 'launch_failed',
        claimedAt,
        finishedAt,
      },
      {
        ...run.items[0],
        status: 'not_started' as const,
        outcomeReason: 'stopped',
        finishedAt,
      },
    ];

    it.each(itemStates)('parses the $status project run item state', (item) => {
      expect(projectRunItemSchema.parse(item)).toEqual(item);
    });

    it.each([
      ['running', null, null, null],
      ['paused', 'operator_paused', null, null],
      ['draining', null, null, null],
      ['completed', null, 'queue_finished', finishedAt],
    ] as const)(
      'parses the %s project run state',
      (state, pauseReason, completionReason, completedAt) => {
        expect(
          projectRunSchema.parse({
            ...run,
            state,
            pauseReason,
            completionReason,
            completedAt,
          }).state,
        ).toBe(state);
      },
    );

    it('rejects invalid project run item and terminal run combinations', () => {
      expect(() =>
        projectRunItemSchema.parse({
          ...run.items[0],
          status: 'completed',
          outcomeReason: null,
        }),
      ).toThrow();
      expect(() =>
        projectRunItemSchema.parse({
          ...run.items[0],
          status: 'queued',
          outcomeReason: 'completed',
        }),
      ).toThrow();
      expect(() =>
        projectRunSchema.parse({
          ...run,
          state: 'completed',
          completedAt: null,
          completionReason: 'queue_finished',
        }),
      ).toThrow();
      for (const item of [
        { ...run.items[0], attemptId: 'attempt-1' },
        { ...run.items[0], status: 'launch_pending', claimedAt: null },
        { ...run.items[0], status: 'active', claimedAt, startedAt },
        {
          ...run.items[0],
          status: 'completed',
          outcomeReason: 'task_done',
          claimedAt,
          startedAt,
          finishedAt,
        },
        {
          ...run.items[0],
          status: 'attention_required',
          outcomeReason: 'launch_failed',
          claimedAt,
          finishedAt,
          attemptId: 'attempt-1',
        },
        {
          ...run.items[0],
          status: 'not_started',
          outcomeReason: 'stopped',
          claimedAt,
          finishedAt,
        },
      ]) {
        expect(() => projectRunItemSchema.parse(item)).toThrow();
      }
    });

    it('rejects inconsistent aggregate ownership, identity, order, and lifecycle', () => {
      for (const items of [
        [{ ...run.items[0], runId: 'run-other' }],
        [{ ...run.items[0], projectId: 'project-other' }],
        [run.items[0], { ...run.items[0] }],
        [run.items[0], { ...run.items[0], id: 'item-2' }],
        [
          run.items[0],
          {
            ...run.items[0],
            id: 'item-2',
            taskId: 'task-2',
          },
        ],
      ]) {
        expect(() => projectRunSchema.parse({ ...run, items })).toThrow();
      }

      expect(() =>
        projectRunSchema.parse({ ...run, pauseReason: 'operator_paused' }),
      ).toThrow();
      expect(
        projectRunSchema.parse({
          ...run,
          state: 'paused',
          pauseReason: null,
        }).pauseReason,
      ).toBe('operator_paused');
      expect(() =>
        projectRunSchema.parse({
          ...run,
          state: 'completed',
          completionReason: 'queue_finished',
          completedAt: finishedAt,
          items: [itemStates[2]],
        }),
      ).toThrow();
    });

    it('decodes legitimate run payloads from before pause and automation snapshots', () => {
      const oldItem = {
        ...run.items[0],
        taskAutomationStatus: undefined,
      };
      expect(
        projectRunSchema.parse({
          ...run,
          state: 'paused',
          pauseReason: undefined,
          items: [oldItem],
        }),
      ).toMatchObject({
        pauseReason: 'operator_paused',
        items: [{ taskAutomationStatus: 'disabled' }],
      });
    });

    it('orders run preview text by deterministic UTF-16 code units', () => {
      expect(['\ue000', '😀', 'A'].sort(compareCodeUnits)).toEqual([
        'A',
        '😀',
        '\ue000',
      ]);
      expect(compareCodeUnits('same', 'same')).toBe(0);
    });

    it('parses runs, run commands, and authoritative run events', () => {
      expect(projectRunSchema.parse(run)).toEqual(run);

      for (const command of [
        {
          type: 'project.run.start',
          payload: {
            projectId: 'project-1',
            concurrency: 2,
            expectedPolicyRevision: 2,
            expectedTasks: [
              {
                taskId: 'task-2',
                revision: 5,
                automationStatus: 'disabled',
                automationGeneration: 0,
              },
              {
                taskId: 'task-1',
                revision: 3,
                automationStatus: 'enabled',
                automationGeneration: 4,
              },
            ],
            actor,
          },
        },
        {
          type: 'project.run.pause',
          payload: { runId: 'run-1', expectedRevision: 1, actor },
        },
        {
          type: 'project.run.resume',
          payload: { runId: 'run-1', expectedRevision: 2, actor },
        },
        {
          type: 'project.run.stop',
          payload: { runId: 'run-1', expectedRevision: 3, actor },
        },
      ]) {
        expect(
          commandEnvelopeSchema.parse({
            protocolVersion: 1,
            idempotencyKey: `project-run-${command.type}`,
            command,
          }).command.type,
        ).toBe(command.type);
      }

      expect(() =>
        commandEnvelopeSchema.parse({
          protocolVersion: 1,
          idempotencyKey: 'project-run-unbound-start',
          command: {
            type: 'project.run.start',
            payload: { projectId: 'project-1', concurrency: 2, actor },
          },
        }),
      ).toThrow();

      expect(
        projectRunChangedEventSchema.parse({
          protocolVersion: 1,
          id: 'project-event-run-1',
          projectId: 'project-1',
          sequence: 1,
          occurredAt: run.updatedAt,
          type: 'project.run_changed',
          payload: { run },
        }).payload.run,
      ).toEqual(run);
    });

    it('rejects run events and snapshots that cross project boundaries or repeat a run id', () => {
      const project = projectSchema.parse({
        id: 'project-1',
        displayName: 'Mesh',
        repositoryPath: 'C:/code/mesh',
        discoveredAt: now,
      });
      const snapshot = {
        protocolVersion: 1,
        project,
        tasks: [],
        attempts: [],
        transitions: [],
        repairs: [],
        cursor: 0,
      };

      expect(() =>
        projectRunChangedEventSchema.parse({
          protocolVersion: 1,
          id: 'project-event-run-other-project',
          projectId: 'project-1',
          sequence: 1,
          occurredAt: run.updatedAt,
          type: 'project.run_changed',
          payload: { run: { ...run, projectId: 'project-2' } },
        }),
      ).toThrow();
      expect(() =>
        projectSnapshotSchema.parse({
          ...snapshot,
          runs: [{ ...run, projectId: 'project-2' }],
        }),
      ).toThrow();
      expect(() =>
        projectSnapshotSchema.parse({ ...snapshot, runs: [run, { ...run }] }),
      ).toThrow();
    });

    it('decodes project snapshots created before runs existed', () => {
      const project = projectSchema.parse({
        id: 'project-1',
        displayName: 'Mesh',
        repositoryPath: 'C:/code/mesh',
        discoveredAt: now,
      });

      expect(
        projectSnapshotSchema.parse({
          protocolVersion: 1,
          project,
          tasks: [],
          attempts: [],
          transitions: [],
          repairs: [],
          cursor: 0,
        }),
      ).toMatchObject({ runs: [], projectRunLimits: { maxConcurrency: 1 } });
    });
  });

  describe('project planning and dependency contracts', () => {
    const planningNow = '2026-08-27T12:00:00.000Z';
    const planningActor = { type: 'human' as const, id: 'operator-1' };
    const proposedTask = {
      key: 'contracts',
      title: 'Add contracts',
      description: 'Define the public planning boundary.',
      acceptanceCriteria: ['All new payloads parse through Zod.'],
      priority: 'high' as const,
      labels: ['planning'],
      rationale: 'Consumers need stable types.',
      goalMapping: 'Enables durable planning.',
    };
    const proposal = {
      id: 'proposal-1',
      planId: 'plan-1',
      baseId: 'base-2',
      ordinal: 2,
      planRevision: 4,
      capabilityGeneration: 2,
      sessionId: 'session-1',
      tasks: [proposedTask],
      dependencies: [],
      assumptions: ['The repository is already imported.'],
      risks: ['Board state may change during planning.'],
      exclusions: ['No continuous scheduling.'],
      submittedAt: planningNow,
    };

    it.each([
      'planning',
      'awaiting_review',
      'revising',
      'attention_required',
      'approved',
      'rejected',
      'cancelled',
    ] as const)('parses the %s planning lifecycle status', (status) => {
      expect(
        projectPlanSchema.parse({
          id: 'plan-1',
          projectId: 'project-1',
          goal: 'Add proposal-only planning.',
          constraints: [],
          nonGoals: [],
          policyVersion: 'pm-policy-v1',
          status,
          revision: 1,
          currentBaseId: 'base-1',
          currentSessionId: 'session-1',
          latestProposalOrdinal: 0,
          feedback: [],
          attention: null,
          createdBy: planningActor,
          createdAt: planningNow,
          updatedAt: planningNow,
          terminalAt: null,
          terminalBy: null,
          terminalReason: null,
        }).status,
      ).toBe(status);
    });

    it('parses immutable planning bases, proposal-local references, feedback, and full plan details', () => {
      const base = {
        id: 'base-2',
        planId: 'plan-1',
        ordinal: 2,
        repositoryIdentity: 'C:/code/mesh',
        tasks: [
          {
            id: 'task-existing-1',
            revision: 3,
            lifecycleState: 'ready',
            blocked: null,
          },
        ],
        dependencies: [
          {
            projectId: 'project-1',
            taskId: 'task-existing-2',
            prerequisiteTaskId: 'task-existing-1',
            createdBy: planningActor,
            createdAt: planningNow,
          },
        ],
        projectArchivedAt: null,
        projectRevision: 7,
        policyRevision: 3,
        createdAt: planningNow,
      };
      const fullProposal = {
        ...proposal,
        dependencies: [
          {
            dependentTaskKey: 'contracts',
            prerequisite: {
              type: 'existing_task' as const,
              taskId: 'task-existing-1',
            },
          },
        ],
      };
      const plan = {
        id: 'plan-1',
        projectId: 'project-1',
        goal: 'Add proposal-only planning.',
        constraints: ['Keep canonical tasks unchanged until approval.'],
        nonGoals: ['Do not create a scheduler.'],
        policyVersion: 'pm-policy-v1',
        status: 'awaiting_review' as const,
        revision: 4,
        currentBaseId: 'base-2',
        currentSessionId: 'session-1',
        latestProposalOrdinal: 2,
        feedback: [
          {
            id: 'feedback-1',
            planId: 'plan-1',
            proposalId: 'proposal-1',
            content: 'Separate planning state from canonical tasks.',
            actor: planningActor,
            createdAt: planningNow,
          },
        ],
        attention: {
          type: 'stale_board',
          addedTaskIds: ['task-added-1'],
          addedTaskTotal: 1,
          addedTaskIdsTruncated: false,
          removedTaskIds: [],
          removedTaskTotal: 0,
          removedTaskIdsTruncated: false,
          changedTaskIds: ['task-existing-1'],
          changedTaskTotal: 1,
          changedTaskIdsTruncated: false,
          dependenciesChanged: true,
          policyChanged: false,
        },
        createdBy: planningActor,
        createdAt: planningNow,
        updatedAt: planningNow,
        terminalAt: null,
        terminalBy: null,
        terminalReason: null,
      };

      expect(
        projectPlanProposalSchema.parse(fullProposal).dependencies[0],
      ).toEqual({
        dependentTaskKey: 'contracts',
        prerequisite: { type: 'existing_task', taskId: 'task-existing-1' },
      });
      expect(
        projectPlanProposalSchema.parse({
          ...proposal,
          tasks: [
            proposedTask,
            { ...proposedTask, key: 'runtime', title: 'Add PM runtime' },
          ],
          dependencies: [
            {
              dependentTaskKey: 'contracts',
              prerequisite: { type: 'proposal_task', taskKey: 'runtime' },
            },
          ],
        }).dependencies[0],
      ).toEqual({
        dependentTaskKey: 'contracts',
        prerequisite: { type: 'proposal_task', taskKey: 'runtime' },
      });
      expect(projectPlanSchema.parse(plan)).toMatchObject({
        status: 'awaiting_review',
        currentBaseId: base.id,
      });
      expect(
        projectPlanDetailsSchema.parse({
          plan,
          bases: [base],
          proposals: [fullProposal],
          feedback: plan.feedback,
        }),
      ).toMatchObject({ proposals: [{ baseId: base.id }] });
    });

    it('accepts exactly fifty proposal tasks and two hundred proposal edges', () => {
      const tasks = Array.from({ length: 50 }, (_, index) => ({
        ...proposedTask,
        key: `task-${index + 1}`,
      }));
      const dependencies = Array.from({ length: 200 }, (_, index) => ({
        dependentTaskKey: 'task-1',
        prerequisite: {
          type: 'existing_task' as const,
          taskId: `existing-${index + 1}`,
        },
      }));

      expect(
        projectPlanProposalSchema.parse({ ...proposal, tasks, dependencies }),
      ).toMatchObject({ tasks, dependencies });
      expect(() =>
        projectPlanProposalSchema.parse({
          ...proposal,
          tasks: [...tasks, { ...proposedTask, key: 'task-51' }],
        }),
      ).toThrow();
      expect(() =>
        projectPlanProposalSchema.parse({
          ...proposal,
          dependencies: [
            ...dependencies,
            {
              dependentTaskKey: 'task-1',
              prerequisite: { type: 'proposal_task', taskKey: 'task-2' },
            },
          ],
        }),
      ).toThrow();
    });

    it('rejects invalid proposal-local dependency references and graphs', () => {
      const tasks = ['a', 'b', 'c'].map((key) => ({
        ...proposedTask,
        key,
        title: `Task ${key}`,
      }));
      const edge = (dependentTaskKey: string, taskKey: string) => ({
        dependentTaskKey,
        prerequisite: { type: 'proposal_task' as const, taskKey },
      });

      for (const dependencies of [
        [edge('missing', 'a')],
        [edge('a', 'missing')],
        [edge('a', 'b'), edge('a', 'b')],
        [edge('a', 'a')],
        [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')],
      ]) {
        expect(() =>
          projectPlanProposalSchema.parse({ ...proposal, tasks, dependencies }),
        ).toThrow();
      }
    });

    it('preserves bounded stale evidence and stable planning error codes', () => {
      expect(() =>
        projectPlanSchema.parse({
          id: 'plan-1',
          projectId: 'project-1',
          goal: 'Add proposal-only planning.',
          constraints: [],
          nonGoals: [],
          policyVersion: 'pm-policy-v1',
          status: 'attention_required',
          revision: 1,
          currentBaseId: 'base-1',
          currentSessionId: null,
          latestProposalOrdinal: 0,
          feedback: [],
          attention: {
            type: 'stale_board',
            addedTaskIds: Array.from(
              { length: 51 },
              (_, index) => `task-${index}`,
            ),
            addedTaskTotal: 51,
            addedTaskIdsTruncated: true,
            removedTaskIds: [],
            removedTaskTotal: 0,
            removedTaskIdsTruncated: false,
            changedTaskIds: [],
            changedTaskTotal: 0,
            changedTaskIdsTruncated: false,
            dependenciesChanged: false,
            policyChanged: false,
          },
          createdBy: planningActor,
          createdAt: planningNow,
          updatedAt: planningNow,
          terminalAt: null,
          terminalBy: null,
          terminalReason: null,
        }),
      ).toThrow();
      expect(stableTaskErrorCodeSchema.parse('project_plan_stale')).toBe(
        'project_plan_stale',
      );
      expect(stableTaskErrorCodeSchema.parse('task_dependency_cycle')).toBe(
        'task_dependency_cycle',
      );
    });

    it('requires revision-checked human planning and dependency commands', () => {
      const commands = [
        {
          type: 'project.plan.start',
          payload: {
            projectId: 'project-1',
            expectedProjectRevision: 7,
            goal: 'Add proposal-only planning.',
            constraints: [],
            nonGoals: [],
            actor: planningActor,
          },
        },
        {
          type: 'project.plan.request_revision',
          payload: {
            projectId: 'project-1',
            planId: 'plan-1',
            expectedPlanRevision: 4,
            feedback: 'Clarify dependency readiness.',
            actor: planningActor,
          },
        },
        {
          type: 'project.plan.approve',
          payload: {
            projectId: 'project-1',
            planId: 'plan-1',
            proposalId: 'proposal-1',
            expectedPlanRevision: 4,
            actor: planningActor,
          },
        },
        {
          type: 'project.plan.reject',
          payload: {
            projectId: 'project-1',
            planId: 'plan-1',
            expectedPlanRevision: 4,
            reason: 'Not enough implementation detail.',
            actor: planningActor,
          },
        },
        {
          type: 'project.plan.cancel',
          payload: {
            projectId: 'project-1',
            planId: 'plan-1',
            expectedPlanRevision: 4,
            reason: 'The goal changed.',
            actor: planningActor,
          },
        },
        {
          type: 'project.plan.resume',
          payload: {
            projectId: 'project-1',
            planId: 'plan-1',
            expectedPlanRevision: 4,
            actor: planningActor,
          },
        },
        {
          type: 'project.plan.retry',
          payload: {
            projectId: 'project-1',
            planId: 'plan-1',
            expectedPlanRevision: 4,
            actor: planningActor,
          },
        },
        {
          type: 'task.dependency.add',
          payload: {
            taskId: 'task-2',
            prerequisiteTaskId: 'task-1',
            expectedRevision: 3,
            actor: planningActor,
          },
        },
        {
          type: 'task.dependency.remove',
          payload: {
            taskId: 'task-2',
            prerequisiteTaskId: 'task-1',
            expectedRevision: 3,
            actor: planningActor,
          },
        },
      ] as const;

      for (const command of commands) {
        expect(mutatingCommandSchema.parse(command).type).toBe(command.type);
      }
      expect(() =>
        mutatingCommandSchema.parse({
          ...commands[2],
          payload: {
            ...commands[2].payload,
            actor: { type: 'agent', id: 'agent-1' },
          },
        }),
      ).toThrow();
      expect(() =>
        mutatingCommandSchema.parse({
          ...commands[0],
          payload: {
            ...commands[0].payload,
            expectedProjectRevision: undefined,
          },
        }),
      ).toThrow();
    });

    it('round trips plan and dependency events, snapshots, summaries, and readiness evidence', () => {
      const plan = projectPlanSchema.parse({
        id: 'plan-1',
        projectId: 'project-1',
        goal: 'Add proposal-only planning.',
        constraints: [],
        nonGoals: [],
        policyVersion: 'pm-policy-v1',
        status: 'approved',
        revision: 5,
        currentBaseId: 'base-2',
        currentSessionId: 'session-1',
        latestProposalOrdinal: 2,
        feedback: [],
        attention: null,
        createdBy: planningActor,
        createdAt: planningNow,
        updatedAt: planningNow,
        terminalAt: planningNow,
        terminalBy: planningActor,
        terminalReason: null,
      });
      const dependency = taskDependencySchema.parse({
        projectId: 'project-1',
        taskId: 'task-2',
        prerequisiteTaskId: 'task-1',
        createdBy: planningActor,
        createdAt: planningNow,
      });
      const planEvent = projectEventSchema.parse({
        protocolVersion: 1,
        id: 'project-event-plan-1',
        projectId: 'project-1',
        sequence: 1,
        occurredAt: planningNow,
        type: 'project.plan_changed',
        payload: { plan },
      });
      const dependencyEvent = projectEventSchema.parse({
        protocolVersion: 1,
        id: 'project-event-dependencies-1',
        projectId: 'project-1',
        sequence: 2,
        occurredAt: planningNow,
        type: 'task.dependencies_changed',
        payload: {
          taskId: 'task-2',
          taskRevision: 7,
          taskUpdatedAt: planningNow,
          dependencies: [dependency],
        },
      });
      const project = projectSchema.parse({
        id: 'project-1',
        displayName: 'Mesh',
        repositoryPath: 'C:/code/mesh',
        discoveredAt: planningNow,
      });
      const snapshot = projectSnapshotSchema.parse({
        protocolVersion: 1,
        project,
        tasks: [],
        attempts: [],
        transitions: [],
        repairs: [],
        activePlan: null,
        terminalPlanSummaries: [
          projectPlanSummarySchema.parse({
            id: plan.id,
            projectId: plan.projectId,
            goal: plan.goal,
            status: plan.status,
            revision: plan.revision,
            latestProposalOrdinal: plan.latestProposalOrdinal,
            createdAt: plan.createdAt,
            updatedAt: plan.updatedAt,
            terminalAt: plan.terminalAt,
          }),
        ],
        dependencies: [dependency],
        cursor: 2,
      });

      expect(planEvent.type).toBe('project.plan_changed');
      expect(dependencyEvent.type).toBe('task.dependencies_changed');
      expect(dependencyEvent.payload).toMatchObject({
        taskRevision: 7,
        taskUpdatedAt: planningNow,
      });
      expect(() =>
        projectEventSchema.parse({
          ...dependencyEvent,
          payload: {
            taskId: dependencyEvent.payload.taskId,
            taskUpdatedAt: planningNow,
            dependencies: dependencyEvent.payload.dependencies,
          },
        }),
      ).toThrow();
      expect(snapshot.terminalPlanSummaries).toHaveLength(1);
      expect(snapshot.dependencies).toEqual([dependency]);
      expect(() =>
        projectSnapshotSchema.parse({
          ...snapshot,
          terminalPlanSummaries: Array.from({ length: 21 }, (_, index) => ({
            ...snapshot.terminalPlanSummaries[0],
            id: `plan-${index}`,
          })),
        }),
      ).toThrow();
      expect(
        taskReadinessProblemSchema.parse({
          type: 'dependency_incomplete',
          taskId: 'task-1',
        }),
      ).toEqual({ type: 'dependency_incomplete', taskId: 'task-1' });
      expect(
        projectPlanHistoryPageSchema.parse({
          plans: snapshot.terminalPlanSummaries,
          nextAfter: undefined,
        }).plans,
      ).toHaveLength(1);
    });
  });
});
