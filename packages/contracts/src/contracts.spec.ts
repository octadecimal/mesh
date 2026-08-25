import { describe, expect, it } from 'vitest';

import {
  blockedConditionSchema,
  commandSchema,
  commandEnvelopeSchema,
  projectEventSchema,
  projectHistorySchema,
  projectSchema,
  projectSnapshotSchema,
  serverMessageSchema,
  sessionDiagnosticsSchema,
  sessionEventSchema,
  sessionHistorySchema,
  sessionSnapshotSchema,
  sessionSchema,
  taskActorSchema,
  taskAttemptSchema,
  taskCommandSchema,
  taskSchema,
  taskTransitionSchema,
} from './index.js';

describe('session platform contracts', () => {
  const now = '2026-08-25T00:00:00.000Z';
  const actor = { type: 'human' as const, id: 'operator-1' };

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
        payload: { taskId: 'task-1', expectedRevision: 2, actor },
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
});
