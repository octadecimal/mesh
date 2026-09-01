import { randomUUID } from 'node:crypto';

import {
  DEVELOPER_REPORT_SCHEMA,
  type DeveloperAttempt,
  type DeveloperReport,
  type ManagedWorkspace,
  type ResolvedWorkerProfileSnapshot,
  type V2CommandResult,
  type WorkerExecution,
} from '@mesh/v2-contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DeveloperAttemptService,
  type StartDeveloperAttemptEnvelope,
  type TaskExecutionAuthority,
} from './developer-attempt-service.js';
import { reconcileDeveloperAttempts } from './reconcile-developer-attempts.js';
import { createV2TestDatabase } from '../test/create-v2-test-database.js';
import { PlanningRepository } from '../planning/planning-repository.js';
import { approveTestDeliveryPlan } from '../test/approved-delivery-plan.js';
import { DeveloperReportConsumer } from './developer-report-consumer.js';
import { canonicalJson } from '../storage/canonical-json.js';
import {
  hashV2Command,
  V2IdempotencyConflictError,
} from '../storage/command-repository.js';
import { V2EventStore } from '../storage/event-store.js';
import { DeveloperRepository } from './developer-repository.js';
import { ExecutionRepository } from '../executions/execution-repository.js';
import { AuditBarrier } from '../executions/audit-barrier.js';
import { inImmediateTransaction } from '../db/database.js';

const now = '2026-09-01T12:00:00.000Z';
const later = '2026-09-01T12:01:00.000Z';
const fixtures: ReturnType<typeof createV2TestDatabase>[] = [];

const createAuthority = (
  fixture: ReturnType<typeof createV2TestDatabase>,
): TaskExecutionAuthority => {
  const taskId = randomUUID();
  const planId = randomUUID();
  const requirementId = randomUUID();
  return {
    project: fixture.project,
    deliveryPlan: {
      plan: {
        id: planId,
        projectId: fixture.project.id,
        revision: 1,
        projectIntentId: randomUUID(),
        projectIntentRevision: 1,
        ledgerId: randomUUID(),
        ledgerRevision: 1,
      },
    } as TaskExecutionAuthority['deliveryPlan'],
    intentRevision: 1,
    ledgerRevision: 1,
    task: {
      id: taskId,
      projectId: fixture.project.id,
      revision: 1,
      contractRevision: 1,
      lifecycle: 'pending',
      title: 'Persist Todo items',
      outcome: 'Todo items survive reload.',
      acceptanceCriteria: ['Reload: restores one Todo item.'],
      verificationCriteria: ['Run the Todo persistence test.'],
      expectedArtifacts: ['src/todos.ts'],
    } as TaskExecutionAuthority['task'],
    requirementRevisions: [{ recordId: requirementId, recordRevision: 1 }],
    board: { projectId: fixture.project.id } as TaskExecutionAuthority['board'],
    card: {
      taskId,
      taskContractRevision: 1,
      taskCurrentRevision: 1,
      title: 'Persist Todo items',
      outcome: 'Todo items survive reload.',
      readiness: { state: 'actionable', blockers: [] },
      detail: {
        acceptanceCriteria: ['Reload: restores one Todo item.'],
        verificationCriteria: ['Run the Todo persistence test.'],
        expectedArtifacts: ['src/todos.ts'],
      },
    } as TaskExecutionAuthority['card'],
  };
};

const createProfile = (compatible = true): ResolvedWorkerProfileSnapshot =>
  ({
    profileId: randomUUID(),
    profileRevision: 1,
    projectId: null,
    baseProfileId: null,
    baseRevision: null,
    digest: 'a'.repeat(64),
    document: {
      spec: {
        assignmentKinds: compatible ? ['developer_task'] : ['foundation-check'],
        outputSchema: compatible
          ? DEVELOPER_REPORT_SCHEMA
          : 'mesh.dev/foundation-report/v1',
      },
    },
  }) as ResolvedWorkerProfileSnapshot;

const createEnvelope = (
  authority: TaskExecutionAuthority,
): StartDeveloperAttemptEnvelope => ({
  idempotencyKey: 'developer-attempt-start-1',
  actor: { kind: 'human' },
  command: {
    type: 'developer_attempt.start',
    projectId: authority.project.id,
    taskId: authority.task.id,
    expectedTaskRevision: authority.task.revision,
    expectedDeliveryPlanId: authority.deliveryPlan.plan.id,
    expectedDeliveryPlanRevision: authority.deliveryPlan.plan.revision,
    profileId: randomUUID(),
    profileRevision: 1,
  },
});

const completionReport = (
  attempt: DeveloperAttempt,
): Extract<DeveloperReport, { disposition: 'completed' }> => ({
  schema: DEVELOPER_REPORT_SCHEMA,
  disposition: 'completed',
  attemptId: attempt.id,
  executionId: attempt.controllingExecutionId!,
  taskId: attempt.taskId,
  taskContractRevision: attempt.taskContractRevision,
  requirementCoverage: attempt.requirementRevisions.map((requirement) => ({
    ...requirement,
    passed: true,
    evidence: [],
  })),
  criterionCoverage: attempt.assignment.acceptanceCriteria.map(
    (text, index) => ({
      index,
      text,
      passed: true,
      evidence: [],
    }),
  ),
  changedArtifacts: [
    { path: 'src/todos.ts', summary: 'Persisted Todo items.' },
  ],
  verification: [{ command: 'pnpm test todos', passed: true, evidence: [] }],
  unresolvedConcerns: [],
  workspace: { headCommit: attempt.baseCommit, dirty: false },
});

const setupPersistedAttempt = async ({
  failure,
}: { failure?: 'receipt' | 'report' | 'attempt' | 'event' | 'task' } = {}) => {
  const fixture = createV2TestDatabase();
  fixtures.push(fixture);
  const planning = new PlanningRepository(fixture.database);
  const developers = new DeveloperRepository(fixture.database);
  const events = new V2EventStore(fixture.database);
  const profile = {
    ...createProfile(),
    profileId: fixture.profileRevision.profileId,
    profileRevision: fixture.profileRevision.revision,
  };
  const published: unknown[] = [];
  const trips: unknown[] = [];
  const workspaceCalls: ManagedWorkspace[] = [];
  const reserveStartCalls: unknown[] = [];
  let execution = fixture.execution;
  const dependencies = {
    database: fixture.database,
    planning,
    developers,
    profiles: { resolveApproved: () => profile },
    commands: fixture.commands,
    events,
    execution: {
      reserveStart: async (input: {
        command: {
          profileId: string;
          profileRevision: number;
          assignment: unknown;
        };
      }) => {
        reserveStartCalls.push(input);
        execution = {
          ...fixture.execution,
          profileId: input.command.profileId,
          profileRevision: input.command.profileRevision,
          assignment: input.command.assignment as never,
          profileSnapshot: {
            ...fixture.execution.profileSnapshot,
            profileId: input.command.profileId,
            profileRevision: input.command.profileRevision,
            document: profile.document,
            digest: profile.digest,
          },
          updatedAt: later,
        };
        fixture.database
          .prepare(
            `UPDATE worker_executions SET
              profile_id = ?, profile_revision = ?, assignment_json = ?,
              profile_snapshot_json = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            execution.profileId,
            execution.profileRevision,
            canonicalJson(execution.assignment),
            canonicalJson(execution.profileSnapshot),
            execution.updatedAt,
            execution.id,
          );
        return {
          execution,
          result: {
            ok: true,
            commandType: 'worker_execution.start' as const,
            execution,
          },
          activationRequired: true,
        };
      },
      activateReserved: async () => undefined,
    },
    workspace: {
      inspectProject: async () => ({
        repositoryIdentity: fixture.project.repositoryIdentity,
        headCommit: fixture.project.headCommit,
      }),
      derive: (input: {
        managedRoot: string;
        projectId: string;
        taskId: string;
        attemptId: string;
        repositoryPath: string;
        repositoryIdentity: string;
        baseCommit: string;
        createdAt: string;
      }): ManagedWorkspace => ({
        attemptId: input.attemptId as ManagedWorkspace['attemptId'],
        repositoryPath: input.repositoryPath,
        repositoryIdentity: input.repositoryIdentity,
        branch: `mesh/dev/${input.projectId}/${input.taskId}/${input.attemptId}`,
        path: `${input.managedRoot}/${input.projectId}/${input.taskId}/${input.attemptId}`,
        baseCommit: input.baseCommit,
        lifecycle: 'creating',
        ownershipToken: `owner-${input.attemptId}`,
        observedHead: null,
        observedDirty: null,
        failure: null,
        revision: 0,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      }),
      create: async (workspace: ManagedWorkspace) => {
        workspaceCalls.push(workspace);
        return {
          ...workspace,
          lifecycle: 'ready' as const,
          observedHead: fixture.project.headCommit,
          observedDirty: false,
        };
      },
      recover: async (workspace: ManagedWorkspace) =>
        workspace.lifecycle === 'ready' ? workspace : undefined,
      observe: async (workspace: ManagedWorkspace) => ({
        ...workspace,
        lifecycle: 'ready' as const,
        observedHead: fixture.project.headCommit,
        observedDirty: workspace.observedDirty ?? false,
        failure: null,
      }),
    },
    barrier: {
      assertHealthy: () => undefined,
      trip: (error: unknown) => trips.push(error),
    },
    billingConflicts: [],
    managedWorkspaceRoot: 'C:/mesh-managed-workspaces',
    now: () => now,
    publishDomain: (event: unknown) => published.push(event),
  };
  const seeded = approveTestDeliveryPlan(fixture, planning);
  const authority = planning.taskExecutionAuthority(
    fixture.project.id,
    seeded.taskId,
  );
  if (!authority) throw new Error('Test authority was not created');
  const start = new DeveloperAttemptService(dependencies as never);
  const startEnvelope: StartDeveloperAttemptEnvelope = {
    idempotencyKey: 'persisted-developer-attempt-start',
    actor: { kind: 'human' },
    command: {
      type: 'developer_attempt.start',
      projectId: fixture.project.id,
      taskId: authority.task.id,
      expectedTaskRevision: authority.task.revision,
      expectedDeliveryPlanId: authority.deliveryPlan.plan.id,
      expectedDeliveryPlanRevision: authority.deliveryPlan.plan.revision,
      profileId: profile.profileId,
      profileRevision: profile.profileRevision,
    },
  };
  const result = await start.start(startEnvelope);
  if (!result.ok) throw new Error(result.error.message);
  const attempt = developers.attempt(result.attempt.id);
  if (!attempt || attempt.lifecycle !== 'active')
    throw new Error('Test attempt was not activated');
  const activeAuthority = planning.taskExecutionAuthority(
    fixture.project.id,
    attempt.taskId,
  );
  if (!activeAuthority) throw new Error('Test authority was not retained');
  const domainEvents = events.domainAfter(fixture.project.id, 0).events;
  published.splice(0);
  const service = failure
    ? new DeveloperAttemptService({
        ...dependencies,
        planning: {
          taskExecutionAuthority:
            planning.taskExecutionAuthority.bind(planning),
          taskExecutionAuthorityInTransaction:
            planning.taskExecutionAuthorityInTransaction.bind(planning),
          appendOperationalTaskLifecycleInTransaction: (input) => {
            if (failure === 'task') throw new Error('task failure');
            return planning.appendOperationalTaskLifecycleInTransaction(input);
          },
        },
        developers: {
          attempt: developers.attempt.bind(developers),
          attemptsForProject: developers.attemptsForProject.bind(developers),
          nonterminalAttempts: developers.nonterminalAttempts.bind(developers),
          reserveAttemptInTransaction:
            developers.reserveAttemptInTransaction.bind(developers),
          recordWorkspaceObservationInTransaction:
            developers.recordWorkspaceObservationInTransaction.bind(developers),
          linkExecutionInTransaction:
            developers.linkExecutionInTransaction.bind(developers),
          transitionAttemptInTransaction: (input, expected) => {
            if (failure === 'attempt') throw new Error('attempt failure');
            return developers.transitionAttemptInTransaction(input, expected);
          },
          insertReportInTransaction: (input) => {
            if (failure === 'report') throw new Error('report failure');
            return developers.insertReportInTransaction(input);
          },
          outputReceipt: developers.outputReceipt.bind(developers),
          recordOutputReceiptInTransaction: (input) => {
            if (failure === 'receipt') throw new Error('receipt failure');
            return developers.recordOutputReceiptInTransaction(input);
          },
        },
        events: {
          appendDomainInTransaction: (projectId, draft) => {
            if (failure === 'event') throw new Error('event failure');
            return events.appendDomainInTransaction(projectId, draft);
          },
        },
      } as never)
    : start;
  const report = completionReport(attempt);
  const insertRuntimeEvent = (runtimeEventId: string, value: unknown) => {
    const diagnosticId = randomUUID();
    fixture.database
      .prepare(
        `INSERT INTO raw_diagnostics (
          id, project_id, execution_id, adapter_id, adapter_cursor, received_at, payload_json
        ) VALUES (?, ?, ?, 'fake', 1, ?, '{}')`,
      )
      .run(diagnosticId, fixture.project.id, execution.id, now);
    fixture.database
      .prepare(
        `INSERT INTO runtime_events (
          id, project_id, execution_id, diagnostic_id, sequence, adapter_cursor,
          occurred_at, type, payload_json
        ) VALUES (?, ?, ?, ?, 1, 1, ?, 'worker_execution.structured_output', '{}')`,
      )
      .run(
        runtimeEventId,
        fixture.project.id,
        execution.id,
        diagnosticId,
        later,
      );
    return {
      id: runtimeEventId,
      type: 'worker_execution.structured_output',
      executionId: execution.id,
      projectId: fixture.project.id,
      occurredAt: later,
      payload: { schema: DEVELOPER_REPORT_SCHEMA, value },
    } as never;
  };
  return {
    fixture,
    planning,
    developers,
    events,
    service,
    attempt,
    authority: activeAuthority,
    report,
    execution,
    domainEvents,
    published,
    trips,
    insertRuntimeEvent,
    dependencies,
    startEnvelope,
    workspaceCalls,
    reserveStartCalls,
  };
};

const rewindPersistedStart = (
  context: Awaited<ReturnType<typeof setupPersistedAttempt>>,
) => {
  const active = context.attempt;
  const reserved: DeveloperAttempt = {
    ...active,
    lifecycle: 'reserved',
    revision: 0,
    controllingExecutionId: null,
    executionIds: [],
    workspace: {
      ...active.workspace,
      lifecycle: 'creating',
      observedHead: null,
      observedDirty: null,
      failure: null,
      revision: 0,
    },
    attention: null,
    endedAt: null,
  };
  inImmediateTransaction(context.fixture.database, () => {
    context.fixture.database
      .prepare(
        `UPDATE developer_attempts SET
          lifecycle = 'reserved', revision = 0, controlling_execution_id = NULL,
          attention_json = NULL, updated_at = ?, ended_at = NULL
         WHERE id = ?`,
      )
      .run(now, reserved.id);
    context.fixture.database
      .prepare('DELETE FROM developer_attempt_executions WHERE attempt_id = ?')
      .run(reserved.id);
    context.fixture.database
      .prepare(
        `UPDATE developer_workspaces SET
          lifecycle = 'creating', observed_head = NULL, observed_dirty = NULL,
          failure_json = NULL, revision = 0, workspace_json = ?, updated_at = ?
         WHERE attempt_id = ?`,
      )
      .run(canonicalJson(reserved.workspace), now, reserved.id);
    context.fixture.database
      .prepare(
        `UPDATE developer_workspace_operations SET
          state = 'creating', observation_json = NULL, updated_at = ?
         WHERE attempt_id = ? AND ordinal = 1`,
      )
      .run(now, reserved.id);
    context.fixture.database
      .prepare('DELETE FROM command_results WHERE idempotency_key = ?')
      .run(context.startEnvelope.idempotencyKey);
    context.fixture.database
      .prepare(
        `INSERT INTO developer_start_reservations (
          attempt_id, project_id, idempotency_key, command_type,
          request_hash, board_json, created_at
        ) VALUES (?, ?, ?, 'developer_attempt.start', ?, ?, ?)`,
      )
      .run(
        reserved.id,
        reserved.projectId,
        context.startEnvelope.idempotencyKey,
        hashV2Command(context.startEnvelope.command),
        canonicalJson(context.authority.board),
        now,
      );
  });
  context.workspaceCalls.splice(0);
  context.reserveStartCalls.splice(0);
  context.published.splice(0);
  context.trips.splice(0);
  return reserved;
};

const setup = (
  options: {
    authority?: TaskExecutionAuthority | undefined;
    profile?: ResolvedWorkerProfileSnapshot;
    billingConflicts?: readonly { variable: string }[];
    healthy?: boolean;
    repositoryIdentity?: string;
    headCommit?: string;
    existingAttempt?: DeveloperAttempt;
    workspaceObservation?: (workspace: ManagedWorkspace) => ManagedWorkspace;
    settlementWorkspaceObservation?: (
      workspace: ManagedWorkspace,
    ) => ManagedWorkspace;
    executionReservationFails?: boolean;
  } = {},
) => {
  const fixture = createV2TestDatabase();
  fixtures.push(fixture);
  let authority = options.authority ?? createAuthority(fixture);
  let profile = options.profile ?? createProfile();
  const executionRecords = new Map<string, WorkerExecution>([
    [
      fixture.execution.id,
      {
        ...fixture.execution,
        lifecycle: 'running',
        revision: 1,
      },
    ],
  ]);
  const phases: string[] = [];
  const attempts: DeveloperAttempt[] = options.existingAttempt
    ? [options.existingAttempt]
    : [];
  const commands = new Map<string, { requestHash: string; result: unknown }>();
  const startReservations = new Map<
    string,
    {
      attemptId: string;
      projectId: string;
      commandType: 'developer_attempt.start';
      requestHash: string;
      board: TaskExecutionAuthority['board'];
    }
  >();
  const workspaceCalls: ManagedWorkspace[] = [];
  const workspaceDerivations: unknown[] = [];
  const inspectionCalls: unknown[] = [];
  const executionCalls: unknown[] = [];
  const events: unknown[] = [];
  const reports: unknown[] = [];
  const receipts: unknown[] = [];
  const receiptsByRuntimeEvent = new Map<string, unknown>();
  const trips: unknown[] = [];
  let inspectionHook: (() => void) | undefined;
  const dependencies = {
    database: fixture.database,
    planning: {
      taskExecutionAuthority: () => authority,
      taskExecutionAuthorityInTransaction: () => authority,
      appendOperationalTaskLifecycleInTransaction: (input: {
        taskId: string;
        expectedCurrentRevision: number;
        lifecycle: 'completed' | 'pending';
      }) => {
        if (
          authority?.task.id !== input.taskId ||
          authority.task.revision !== input.expectedCurrentRevision
        ) {
          throw new Error('Task lifecycle revision conflict');
        }
        authority = {
          ...authority,
          task: {
            ...authority.task,
            revision: authority.task.revision + 1,
            lifecycle: input.lifecycle,
          },
        };
        return authority.task;
      },
    },
    developers: {
      attempt: (id) => attempts.find((attempt) => attempt.id === id),
      attemptsForProject: () => attempts,
      nonterminalAttempts: () => attempts,
      startReservation: (idempotencyKey) => {
        const reservation = startReservations.get(idempotencyKey);
        return reservation
          ? { ...reservation, idempotencyKey, createdAt: now }
          : undefined;
      },
      startReservationForAttempt: (attemptId) => {
        for (const [idempotencyKey, reservation] of startReservations) {
          if (reservation.attemptId === attemptId)
            return { ...reservation, idempotencyKey, createdAt: now };
        }
        return undefined;
      },
      reserveAttemptInTransaction: (attempt, start) => {
        attempts.push(attempt);
        if (start) {
          startReservations.set(start.idempotencyKey, {
            attemptId: start.attemptId,
            projectId: start.projectId,
            commandType: start.commandType,
            requestHash: start.requestHash,
            board: start.board,
          });
        }
        return attempt;
      },
      recordWorkspaceObservationInTransaction: (workspace) => {
        const current = attempts.find(({ id }) => id === workspace.attemptId)!;
        const next = { ...current, workspace };
        attempts.splice(attempts.indexOf(current), 1, next);
        return workspace;
      },
      linkExecutionInTransaction: ({ attemptId, executionId }) => {
        const current = attempts.find(({ id }) => id === attemptId)!;
        const next = {
          ...current,
          revision: current.revision + 1,
          controllingExecutionId: executionId,
          executionIds: [...current.executionIds, executionId],
        };
        attempts.splice(attempts.indexOf(current), 1, next);
        return next;
      },
      transitionAttemptInTransaction: (attempt) => {
        const current = attempts.find(({ id }) => id === attempt.id)!;
        attempts.splice(attempts.indexOf(current), 1, attempt);
        return attempt;
      },
      insertReportInTransaction: (report) => {
        reports.push(report);
        return report;
      },
      outputReceipt: (runtimeEventId) =>
        receiptsByRuntimeEvent.get(runtimeEventId) as never,
      recordOutputReceiptInTransaction: (receipt) => {
        receipts.push(receipt);
        receiptsByRuntimeEvent.set(receipt.runtimeEventId, receipt);
        return receipt;
      },
    },
    profiles: { resolveApproved: () => profile },
    commands: {
      find: (key, requestHash) => {
        const stored = commands.get(key);
        if (stored && requestHash !== stored.requestHash)
          throw new V2IdempotencyConflictError(key);
        return stored
          ? ({
              idempotencyKey: key,
              commandType: (stored.result as V2CommandResult).commandType,
              createdAt: now,
              ...stored,
            } as never)
          : undefined;
      },
      storeInTransaction: (stored) => {
        const existing = commands.get(stored.idempotencyKey);
        if (existing) {
          if (existing.requestHash !== stored.requestHash)
            throw new V2IdempotencyConflictError(stored.idempotencyKey);
          return;
        }
        commands.set(stored.idempotencyKey, stored);
        const reservation = startReservations.get(stored.idempotencyKey);
        if (
          reservation &&
          stored.commandType === reservation.commandType &&
          stored.requestHash === reservation.requestHash
        )
          startReservations.delete(stored.idempotencyKey);
      },
    },
    events: {
      appendDomainInTransaction: (_projectId, event) => {
        events.push(event);
        return event;
      },
    },
    executions: { get: (id: string) => executionRecords.get(id) },
    execution: {
      reserveStart: async () => {
        phases.push('workspace_observed_ready', 'execution_reserved');
        executionCalls.push('reserve');
        if (options.executionReservationFails) {
          return {
            execution: fixture.execution,
            result: {
              ok: false,
              commandType: 'worker_execution.start',
              error: {
                code: 'adapter_unavailable',
                message: 'Worker execution reservation failed',
              },
            },
            activationRequired: false,
          };
        }
        return {
          execution: fixture.execution,
          result: {
            ok: true,
            commandType: 'worker_execution.start',
            execution: fixture.execution,
          },
          activationRequired: true,
        };
      },
      activateReserved: async (executionId: string) => {
        expect(attempts[0]).toMatchObject({ lifecycle: 'active' });
        executionCalls.push(executionId);
        phases.push('attempt_activated', 'execution_activated');
      },
      interrupt: async (envelope) => {
        const current = executionRecords.get(envelope.command.executionId)!;
        const interrupted = {
          ...current,
          lifecycle: 'interrupted' as const,
          revision: current.revision + 1,
          updatedAt: later,
          endedAt: later,
        };
        executionRecords.set(interrupted.id, interrupted);
        return {
          ok: true,
          commandType: 'worker_execution.interrupt' as const,
          execution: interrupted,
        };
      },
      reserveReplacement: async (envelope, replacementForExecutionId) => {
        const replacement = {
          ...fixture.execution,
          id: randomUUID(),
          projectId: envelope.command.projectId,
          profileId: envelope.command.profileId,
          profileRevision: envelope.command.profileRevision,
          assignment: envelope.command.assignment,
          profileSnapshot: {
            ...fixture.execution.profileSnapshot,
            profileId: envelope.command.profileId,
            profileRevision: envelope.command.profileRevision,
            document: profile.document,
            digest: profile.digest,
          },
          lifecycle: 'starting' as const,
          revision: 0,
          nativeHandle: null,
          replacementForExecutionId,
          failure: null,
          createdAt: later,
          updatedAt: later,
          endedAt: null,
        };
        executionRecords.set(replacement.id, replacement);
        return {
          execution: replacement,
          result: {
            ok: true,
            commandType: 'worker_execution.start' as const,
            execution: replacement,
          },
          activationRequired: true,
        };
      },
    },
    workspace: {
      inspectProject: async () => {
        inspectionCalls.push('inspect');
        inspectionHook?.();
        return {
          repositoryIdentity:
            options.repositoryIdentity ?? fixture.project.repositoryIdentity,
          headCommit: options.headCommit ?? fixture.project.headCommit,
        };
      },
      derive: (input: {
        managedRoot: string;
        projectId: string;
        taskId: string;
        attemptId: string;
        repositoryPath: string;
        repositoryIdentity: string;
        baseCommit: string;
        createdAt: string;
      }): ManagedWorkspace => {
        workspaceDerivations.push(input);
        return {
          attemptId: input.attemptId as ManagedWorkspace['attemptId'],
          repositoryPath: input.repositoryPath,
          repositoryIdentity: input.repositoryIdentity,
          branch: `mesh/dev/${input.projectId}/${input.taskId}/${input.attemptId}`,
          path: `${input.managedRoot}/${input.projectId}/${input.taskId}/${input.attemptId}`,
          baseCommit: input.baseCommit,
          lifecycle: 'creating',
          ownershipToken: `owner-${input.attemptId}`,
          observedHead: null,
          observedDirty: null,
          failure: null,
          revision: 0,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        };
      },
      create: async (workspace: ManagedWorkspace) => {
        phases.push('attempt_reserved', 'workspace_effect_started');
        workspaceCalls.push(workspace);
        const observation = options.workspaceObservation?.(workspace) ?? {
          ...workspace,
          lifecycle: 'ready' as const,
          observedHead: fixture.project.headCommit,
          observedDirty: false,
        };
        return observation;
      },
      recover: async (workspace: ManagedWorkspace) =>
        workspace.lifecycle === 'ready'
          ? {
              ...workspace,
              lifecycle: 'ready' as const,
              observedHead: fixture.project.headCommit,
              observedDirty: false,
              failure: null,
            }
          : undefined,
      observe: async (workspace: ManagedWorkspace) => ({
        ...(options.settlementWorkspaceObservation?.(workspace) ?? {
          ...workspace,
          lifecycle: 'ready' as const,
          observedHead: fixture.project.headCommit,
          observedDirty: workspace.observedDirty ?? false,
          failure: null,
        }),
      }),
    },
    barrier: {
      assertHealthy: () => {
        if (options.healthy === false) throw new Error('audit barrier tripped');
      },
      trip: (error: unknown) => trips.push(error),
    },
    billingConflicts: options.billingConflicts ?? [],
    managedWorkspaceRoot: 'C:/mesh-managed-workspaces',
    now: () => now,
    publishDomain: (event) => events.push(event),
  };
  const service = new DeveloperAttemptService(dependencies);
  return {
    service,
    phases,
    attempts,
    workspaceCalls,
    workspaceDerivations,
    inspectionCalls,
    executionCalls,
    commands,
    startReservations,
    executionRecords,
    events,
    reports,
    receipts,
    trips,
    fixture,
    dependencies,
    getAuthority: () => authority,
    setAuthority: (value: TaskExecutionAuthority | undefined) => {
      authority = value;
    },
    setProfile: (value: ResolvedWorkerProfileSnapshot) => {
      profile = value;
    },
    setInspectionHook: (hook: (() => void) | undefined) => {
      inspectionHook = hook;
    },
    command: createEnvelope(authority),
  };
};

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

describe('DeveloperAttemptService', () => {
  it('settles an exactly covered completion without mutating its contract', async () => {
    const context = setup();
    await context.service.start(context.command);
    const attempt = context.attempts[0];
    const report = completionReport(attempt);
    const execution = {
      ...context.fixture.execution,
      id: attempt.controllingExecutionId,
      projectId: attempt.projectId,
      assignment: attempt.assignment,
    };
    const event = {
      id: randomUUID(),
      type: 'worker_execution.structured_output',
      executionId: execution.id,
      projectId: execution.projectId,
      occurredAt: later,
      payload: { schema: DEVELOPER_REPORT_SCHEMA, value: report },
    };

    await context.service.acceptReport(
      execution as never,
      event as never,
      report,
    );

    expect(context.attempts[0]).toMatchObject({
      lifecycle: 'completed',
      reportIds: [expect.any(String)],
      taskContractRevision: 1,
    });
    expect(context.getAuthority()!.task).toMatchObject({
      revision: 2,
      contractRevision: 1,
      lifecycle: 'completed',
    });
    expect(context.receipts).toHaveLength(1);
    expect(context.reports).toHaveLength(1);
  });

  it('rejects missing, duplicate, and failed completion evidence', async () => {
    for (const revise of [
      (report: ReturnType<typeof completionReport>) => ({
        ...report,
        criterionCoverage: [],
      }),
      (report: ReturnType<typeof completionReport>) => ({
        ...report,
        criterionCoverage: [
          ...report.criterionCoverage,
          { ...report.criterionCoverage[0], index: 99 },
        ],
      }),
      (report: ReturnType<typeof completionReport>) => ({
        ...report,
        criterionCoverage: [
          { ...report.criterionCoverage[0], text: 'Wrong exact text.' },
        ],
      }),
      (report: ReturnType<typeof completionReport>) => ({
        ...report,
        requirementCoverage: [
          ...report.requirementCoverage,
          report.requirementCoverage[0],
        ],
      }),
      (report: ReturnType<typeof completionReport>) => ({
        ...report,
        requirementCoverage: [
          ...report.requirementCoverage,
          { ...report.requirementCoverage[0], recordId: randomUUID() },
        ],
      }),
      (report: ReturnType<typeof completionReport>) => ({
        ...report,
        requirementCoverage: [
          { ...report.requirementCoverage[0], recordRevision: 2 },
        ],
      }),
      (report: ReturnType<typeof completionReport>) => ({
        ...report,
        verification: [{ ...report.verification[0], passed: false }],
      }),
    ]) {
      const context = setup();
      await context.service.start(context.command);
      const attempt = context.attempts[0];
      const report = revise(completionReport(attempt));
      const execution = {
        ...context.fixture.execution,
        id: attempt.controllingExecutionId,
        projectId: attempt.projectId,
        assignment: attempt.assignment,
      };

      await context.service.acceptReport(
        execution as never,
        {
          id: randomUUID(),
          type: 'worker_execution.structured_output',
          executionId: execution.id,
          projectId: execution.projectId,
          occurredAt: later,
          payload: { schema: DEVELOPER_REPORT_SCHEMA, value: report },
        } as never,
        report,
      );

      expect(context.attempts[0]).toMatchObject({
        lifecycle: 'active',
        reportIds: [],
      });
      expect(context.reports).toHaveLength(0);
      expect(context.receipts).toEqual([
        expect.objectContaining({
          status: 'rejected',
          rejectionReason: 'report_coverage_invalid',
        }),
      ]);
    }
  });

  it('interrupts a terminal Developer execution without an accepted report', async () => {
    const context = setup();
    await context.service.start(context.command);
    const attempt = context.attempts[0];

    context.service.terminal({
      ...context.fixture.execution,
      id: attempt.controllingExecutionId!,
      projectId: attempt.projectId,
      assignment: attempt.assignment,
      lifecycle: 'completed',
      revision: context.fixture.execution.revision + 1,
      updatedAt: later,
    });

    expect(context.attempts[0]).toMatchObject({
      lifecycle: 'interrupted',
      controllingExecutionId: attempt.controllingExecutionId,
      reportIds: [],
      attention: null,
    });
    expect(context.events).toContainEqual(
      expect.objectContaining({ type: 'developer_attempt.changed' }),
    );
  });

  it('requires attention when a live controlling execution requires attention', async () => {
    const context = setup();
    await context.service.start(context.command);
    const attempt = context.attempts[0];

    context.service.terminal({
      ...context.fixture.execution,
      id: attempt.controllingExecutionId!,
      projectId: attempt.projectId,
      assignment: attempt.assignment,
      lifecycle: 'attention_required',
      revision: context.fixture.execution.revision + 1,
      updatedAt: later,
    });

    expect(context.attempts[0]).toMatchObject({
      lifecycle: 'attention_required',
      attention: {
        code: 'developer_attempt_transition_conflict',
        message: 'Controlling execution requires attention',
      },
      endedAt: later,
    });
  });

  it('records the current workspace observation before accepting report evidence', async () => {
    const context = setup({
      settlementWorkspaceObservation: (workspace) => ({
        ...workspace,
        lifecycle: 'ready',
        observedHead: workspace.baseCommit,
        observedDirty: true,
        failure: null,
      }),
    });
    await context.service.start(context.command);
    const attempt = context.attempts[0];
    const report = {
      ...completionReport(attempt),
      workspace: {
        headCommit: context.fixture.project.headCommit,
        dirty: true,
      },
    };
    const execution = {
      ...context.fixture.execution,
      id: attempt.controllingExecutionId,
      projectId: attempt.projectId,
      assignment: attempt.assignment,
    };

    await context.service.acceptReport(
      execution as never,
      {
        id: randomUUID(),
        type: 'worker_execution.structured_output',
        executionId: execution.id,
        projectId: execution.projectId,
        occurredAt: later,
        payload: { schema: DEVELOPER_REPORT_SCHEMA, value: report },
      } as never,
      report,
    );

    expect(context.attempts[0]).toMatchObject({
      lifecycle: 'completed',
      workspace: {
        observedHead: context.fixture.project.headCommit,
        observedDirty: true,
      },
    });
    expect(context.reports).toHaveLength(1);
  });

  it('records a rejected receipt without overwriting a settled report', async () => {
    const context = setup();
    await context.service.start(context.command);
    const attempt = context.attempts[0];
    const report = completionReport(attempt);
    const execution = {
      ...context.fixture.execution,
      id: attempt.controllingExecutionId,
      projectId: attempt.projectId,
      assignment: attempt.assignment,
    };
    const event = (id: string) =>
      ({
        id,
        type: 'worker_execution.structured_output',
        executionId: execution.id,
        projectId: execution.projectId,
        occurredAt: later,
        payload: { schema: DEVELOPER_REPORT_SCHEMA, value: report },
      }) as never;

    await context.service.acceptReport(
      execution as never,
      event(randomUUID()),
      report,
    );
    await context.service.acceptReport(
      execution as never,
      event(randomUUID()),
      report,
    );

    expect(context.reports).toHaveLength(1);
    expect(context.attempts[0]).toMatchObject({ lifecycle: 'completed' });
    expect(context.receipts).toEqual([
      expect.objectContaining({ status: 'accepted' }),
      expect.objectContaining({
        status: 'rejected',
        rejectionReason: 'report_binding_mismatch',
      }),
    ]);
  });

  it('makes a matching runtime-event replay idempotent and rejects a digest conflict', async () => {
    const context = setup();
    await context.service.start(context.command);
    const attempt = context.attempts[0];
    const report = completionReport(attempt);
    const execution = {
      ...context.fixture.execution,
      id: attempt.controllingExecutionId,
      projectId: attempt.projectId,
      assignment: attempt.assignment,
    };
    const runtimeEventId = randomUUID();
    const event = {
      id: runtimeEventId,
      type: 'worker_execution.structured_output',
      executionId: execution.id,
      projectId: execution.projectId,
      occurredAt: later,
      payload: { schema: DEVELOPER_REPORT_SCHEMA, value: report },
    };

    await context.service.acceptReport(
      execution as never,
      event as never,
      report,
    );
    const published = context.events.length;
    let observations = 0;
    context.dependencies.workspace.observe = async () => {
      observations += 1;
      throw new Error('workspace should not be observed for receipt replay');
    };
    context.dependencies.barrier.assertHealthy = () => {
      throw new Error('audit barrier is already tripped');
    };
    await context.service.acceptReport(
      execution as never,
      event as never,
      report,
    );
    expect(observations).toBe(0);
    expect(context.receipts).toHaveLength(1);
    expect(context.reports).toHaveLength(1);
    expect(context.events).toHaveLength(published);
    expect(context.trips).toEqual([]);
    await expect(
      context.service.acceptReport(
        execution as never,
        {
          ...event,
          payload: {
            ...event.payload,
            value: { ...report, changedArtifacts: [] },
          },
        } as never,
        report,
      ),
    ).rejects.toThrow('conflicts with prior receipt');
    expect(context.reports).toHaveLength(1);
    expect(context.trips).toHaveLength(1);
  });

  it.each(['projectId', 'attemptId', 'executionId'] as const)(
    'trips the barrier when a runtime-event receipt has the wrong %s',
    async (field) => {
      const context = setup();
      await context.service.start(context.command);
      const attempt = context.attempts[0];
      const report = completionReport(attempt);
      const execution = {
        ...context.fixture.execution,
        id: attempt.controllingExecutionId,
        projectId: attempt.projectId,
        assignment: attempt.assignment,
      };
      const event = {
        id: randomUUID(),
        type: 'worker_execution.structured_output',
        executionId: execution.id,
        projectId: execution.projectId,
        occurredAt: later,
        payload: { schema: DEVELOPER_REPORT_SCHEMA, value: report },
      };
      await context.service.acceptReport(
        execution as never,
        event as never,
        report,
      );
      const prior = context.receipts[0] as Record<string, unknown>;
      context.dependencies.developers.outputReceipt = () =>
        ({ ...prior, [field]: randomUUID() }) as never;
      let observations = 0;
      context.dependencies.workspace.observe = async () => {
        observations += 1;
        throw new Error('workspace should not be observed for corrupt replay');
      };

      await expect(
        context.service.acceptReport(
          execution as never,
          event as never,
          report,
        ),
      ).rejects.toThrow('conflicts with prior receipt');
      expect(observations).toBe(0);
      expect(context.trips).toHaveLength(1);
    },
  );

  it('trips the barrier when a durable receipt cannot be read', async () => {
    const context = setup();
    await context.service.start(context.command);
    const attempt = context.attempts[0];
    const report = completionReport(attempt);
    const execution = {
      ...context.fixture.execution,
      id: attempt.controllingExecutionId,
      projectId: attempt.projectId,
      assignment: attempt.assignment,
    };
    const event = {
      id: randomUUID(),
      type: 'worker_execution.structured_output',
      executionId: execution.id,
      projectId: execution.projectId,
      occurredAt: later,
      payload: { schema: DEVELOPER_REPORT_SCHEMA, value: report },
    };
    context.dependencies.developers.outputReceipt = () => {
      throw new Error('stored receipt is corrupt');
    };

    await expect(
      context.service.acceptReport(execution as never, event as never, report),
    ).rejects.toThrow('stored receipt is corrupt');
    expect(context.trips).toHaveLength(1);
  });

  it('rechecks the full receipt identity after workspace observation', async () => {
    const context = setup();
    await context.service.start(context.command);
    const attempt = context.attempts[0];
    const report = completionReport(attempt);
    const execution = {
      ...context.fixture.execution,
      id: attempt.controllingExecutionId,
      projectId: attempt.projectId,
      assignment: attempt.assignment,
    };
    const event = {
      id: randomUUID(),
      type: 'worker_execution.structured_output',
      executionId: execution.id,
      projectId: execution.projectId,
      occurredAt: later,
      payload: { schema: DEVELOPER_REPORT_SCHEMA, value: report },
    };
    context.dependencies.workspace.observe = async (workspace) => {
      context.dependencies.developers.recordOutputReceiptInTransaction({
        runtimeEventId: event.id,
        projectId: execution.projectId,
        attemptId: attempt.id,
        executionId: execution.id,
        outputDigest: 'a'.repeat(64),
        status: 'accepted',
        rejectionReason: null,
        createdAt: later,
      });
      return { ...workspace, lifecycle: 'ready', failure: null };
    };

    await expect(
      context.service.acceptReport(execution as never, event as never, report),
    ).rejects.toThrow('conflicts with prior receipt');
    expect(context.reports).toHaveLength(0);
    expect(context.trips.length).toBeGreaterThan(0);
  });

  it('fails closed on a digest-corrupt receipt from the real repository', async () => {
    const context = await setupPersistedAttempt();
    const runtimeEventId = randomUUID();
    const event = context.insertRuntimeEvent(runtimeEventId, context.report);
    inImmediateTransaction(context.fixture.database, () => {
      context.developers.recordOutputReceiptInTransaction({
        runtimeEventId,
        projectId: context.attempt.projectId,
        attemptId: context.attempt.id,
        executionId: context.execution.id,
        outputDigest: 'a'.repeat(64),
        status: 'accepted',
        rejectionReason: null,
        createdAt: later,
      });
    });
    const barrier = new AuditBarrier();
    const service = new DeveloperAttemptService({
      ...context.dependencies,
      barrier,
    } as never);
    const published = context.published.length;
    const observed = context.workspaceCalls.length;

    await expect(
      service.acceptReport(context.execution, event, context.report),
    ).rejects.toThrow('conflicts with prior receipt');
    expect(barrier.health()).toMatchObject({
      status: 'tripped',
      diagnostics: [
        {
          message: 'Durable audit persistence failed',
          cause: 'Developer output receipt conflicts with prior receipt',
        },
      ],
    });
    expect(context.workspaceCalls).toHaveLength(observed);
    expect(context.published).toHaveLength(published);
  });

  it('settles a durably emitted report before a concurrent interrupt', async () => {
    const context = setup();
    await context.service.start(context.command);
    const attempt = context.attempts[0];
    const report = completionReport(attempt);
    const execution = {
      ...context.fixture.execution,
      id: attempt.controllingExecutionId,
      projectId: attempt.projectId,
      assignment: attempt.assignment,
    };
    const event = {
      id: randomUUID(),
      type: 'worker_execution.structured_output',
      executionId: execution.id,
      projectId: execution.projectId,
      occurredAt: later,
      payload: { schema: DEVELOPER_REPORT_SCHEMA, value: report },
    };
    let observationStarted!: () => void;
    const observing = new Promise<void>((resolve) => {
      observationStarted = resolve;
    });
    let releaseObservation!: () => void;
    const observationReleased = new Promise<void>((resolve) => {
      releaseObservation = resolve;
    });
    const publications: unknown[] = [];
    context.dependencies.publishDomain = (domainEvent) =>
      publications.push(domainEvent);
    context.dependencies.workspace.observe = async (workspace) => {
      observationStarted();
      await observationReleased;
      return {
        ...workspace,
        lifecycle: 'ready' as const,
        observedHead: context.fixture.project.headCommit,
        observedDirty: false,
        failure: null,
      };
    };

    const settling = context.service.acceptReport(
      execution as never,
      event as never,
      report,
    );
    await observing;
    const interrupting = context.service.interrupt({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'developer_attempt.interrupt',
        projectId: attempt.projectId,
        attemptId: attempt.id,
        expectedAttemptRevision: attempt.revision,
      },
    });
    releaseObservation();

    await settling;
    await expect(interrupting).resolves.toMatchObject({
      ok: false,
      error: { code: 'developer_attempt_transition_conflict' },
    });
    expect(context.attempts[0]).toMatchObject({ lifecycle: 'completed' });
    expect(context.getAuthority()!.task.lifecycle).toBe('completed');
    expect(context.receipts).toEqual([
      expect.objectContaining({ status: 'accepted' }),
    ]);
    expect(context.reports).toHaveLength(1);
    expect(
      publications.filter(
        (domainEvent) =>
          (domainEvent as { type?: string }).type ===
          'developer_report.recorded',
      ),
    ).toHaveLength(1);

    await context.service.acceptReport(
      execution as never,
      event as never,
      report,
    );
    expect(publications).toHaveLength(3);
    await context.service.acceptReport(
      execution as never,
      { ...event, id: randomUUID() } as never,
      report,
    );
    expect(context.receipts).toEqual([
      expect.objectContaining({ status: 'accepted' }),
      expect.objectContaining({
        status: 'rejected',
        rejectionReason: 'report_binding_mismatch',
      }),
    ]);
  });

  it.each(['receipt', 'report', 'attempt', 'event', 'task'] as const)(
    'rolls back the real persisted settlement graph when %s persistence fails',
    async (failure) => {
      const context = await setupPersistedAttempt({ failure });
      const runtimeEventId = randomUUID();
      const event = context.insertRuntimeEvent(runtimeEventId, context.report);

      await expect(
        context.service.acceptReport(context.execution, event, context.report),
      ).rejects.toThrow(`${failure} failure`);
      expect(context.trips).toHaveLength(1);
      expect(context.developers.outputReceipt(runtimeEventId)).toBeUndefined();
      expect(
        context.developers.reportsForProject(context.fixture.project.id),
      ).toEqual([]);
      expect(context.developers.attempt(context.attempt.id)).toEqual(
        context.attempt,
      );
      const authority = context.planning.taskExecutionAuthority(
        context.fixture.project.id,
        context.attempt.taskId,
      )!;
      expect(authority.task).toEqual(context.authority.task);
      expect(authority.card).toEqual(context.authority.card);
      expect(authority.card.readiness).toEqual(
        context.authority.card.readiness,
      );
      expect(
        context.events.domainAfter(context.fixture.project.id, 0).events,
      ).toEqual(context.domainEvents);
      expect(context.published).toEqual([]);
    },
  );

  it('persists a malformed Developer output receipt through the real consumer', async () => {
    const context = await setupPersistedAttempt();
    const runtimeEventId = randomUUID();
    const event = context.insertRuntimeEvent(runtimeEventId, {
      schema: DEVELOPER_REPORT_SCHEMA,
    });
    const consumer = new DeveloperReportConsumer({ attempts: context.service });

    await consumer.structuredOutput(context.execution, event);

    expect(context.developers.outputReceipt(runtimeEventId)).toMatchObject({
      status: 'rejected',
      rejectionReason: 'report_binding_mismatch',
    });
    expect(
      context.developers.reportsForProject(context.fixture.project.id),
    ).toEqual([]);
    expect(context.developers.attempt(context.attempt.id)).toEqual(
      context.attempt,
    );
    const authority = context.planning.taskExecutionAuthority(
      context.fixture.project.id,
      context.attempt.taskId,
    )!;
    expect(authority.task).toEqual(context.authority.task);
    expect(authority.card).toEqual(context.authority.card);
    expect(authority.card.readiness).toEqual(context.authority.card.readiness);
    expect(
      context.events.domainAfter(context.fixture.project.id, 0).events,
    ).toEqual(context.domainEvents);
    expect(context.published).toEqual([]);
  });

  it.each([
    ['a foreign event execution id', 'eventExecutionId'],
    ['a foreign event project id', 'eventProjectId'],
    ['a foreign output schema', 'eventSchema'],
    ['a changed frozen acceptance criterion', 'assignment'],
  ] as const)('rejects %s', async (_name, mutation) => {
    const context = setup();
    await context.service.start(context.command);
    const attempt = context.attempts[0];
    const report = completionReport(attempt);
    let execution = {
      ...context.fixture.execution,
      id: attempt.controllingExecutionId,
      projectId: attempt.projectId,
      assignment: attempt.assignment,
    };
    let event = {
      id: randomUUID(),
      type: 'worker_execution.structured_output' as const,
      executionId: execution.id,
      projectId: execution.projectId,
      occurredAt: later,
      payload: { schema: DEVELOPER_REPORT_SCHEMA, value: report },
    };
    if (mutation === 'eventExecutionId')
      event = { ...event, executionId: randomUUID() as never };
    if (mutation === 'eventProjectId')
      event = { ...event, projectId: randomUUID() as never };
    if (mutation === 'eventSchema')
      event = {
        ...event,
        payload: { ...event.payload, schema: 'mesh.dev/other/v1' as never },
      };
    if (mutation === 'assignment')
      execution = {
        ...execution,
        assignment: {
          ...attempt.assignment,
          acceptanceCriteria: ['Changed text.'],
        } as never,
      };

    await context.service.acceptReport(
      execution as never,
      event as never,
      report,
    );

    expect(context.attempts[0]).toMatchObject({
      lifecycle: 'active',
      reportIds: [],
    });
    expect(context.reports).toEqual([]);
    expect(context.receipts).toEqual([
      expect.objectContaining({
        status: 'rejected',
        rejectionReason: 'report_binding_mismatch',
      }),
    ]);
  });

  it('preserves the task when a valid blocker settles the attempt', async () => {
    const context = setup();
    await context.service.start(context.command);
    const attempt = context.attempts[0];
    const report: Extract<DeveloperReport, { disposition: 'blocked' }> = {
      schema: DEVELOPER_REPORT_SCHEMA,
      disposition: 'blocked',
      attemptId: attempt.id,
      executionId: attempt.controllingExecutionId!,
      taskId: attempt.taskId,
      taskContractRevision: attempt.taskContractRevision,
      blocker: 'The repository has a conflicting lock.',
      evidence: [],
      suggestedNextAction: 'Release the lock and resume the attempt.',
      preserveWorkspace: true,
      workspace: { headCommit: attempt.baseCommit, dirty: false },
    };
    const execution = {
      ...context.fixture.execution,
      id: attempt.controllingExecutionId,
      projectId: attempt.projectId,
      assignment: attempt.assignment,
    };

    await context.service.acceptReport(
      execution as never,
      {
        id: randomUUID(),
        type: 'worker_execution.structured_output',
        executionId: execution.id,
        projectId: execution.projectId,
        occurredAt: later,
        payload: { schema: DEVELOPER_REPORT_SCHEMA, value: report },
      } as never,
      report,
    );

    expect(context.attempts[0]).toMatchObject({
      lifecycle: 'blocked',
      reportIds: [expect.any(String)],
    });
    expect(context.getAuthority()!.task).toMatchObject({
      revision: 1,
      lifecycle: 'pending',
    });
  });

  it('durably reserves and then activates one actionable Developer attempt', async () => {
    const context = setup();

    const result = await context.service.start(context.command);
    const replay = await context.service.start(context.command);

    expect(result).toMatchObject({
      ok: true,
      commandType: 'developer_attempt.start',
      attempt: {
        assignment: {
          taskCurrentRevision: context.getAuthority()!.task.revision,
        },
        workspace: { baseCommit: context.getAuthority()!.project.headCommit },
      },
    });
    expect(replay).toEqual(result);
    expect(context.phases).toEqual([
      'attempt_reserved',
      'workspace_effect_started',
      'workspace_observed_ready',
      'execution_reserved',
      'attempt_activated',
      'execution_activated',
    ]);
    expect(context.workspaceCalls).toHaveLength(1);
    expect(context.workspaceDerivations).toEqual([
      expect.objectContaining({
        managedRoot: 'C:/mesh-managed-workspaces',
        projectId: context.getAuthority()!.project.id,
        taskId: context.getAuthority()!.task.id,
        repositoryPath: context.getAuthority()!.project.repositoryPath,
        repositoryIdentity: context.getAuthority()!.project.repositoryIdentity,
        baseCommit: context.getAuthority()!.project.headCommit,
        createdAt: now,
      }),
    ]);
    expect(context.workspaceCalls[0]).toMatchObject({
      lifecycle: 'creating',
      branch: expect.stringMatching(
        new RegExp(
          `^mesh/dev/${context.getAuthority()!.project.id}/${context.getAuthority()!.task.id}/`,
        ),
      ),
    });
    expect(context.executionCalls).toHaveLength(2);
  });

  it('replays a reserved start after a process loss without duplicate effects', async () => {
    const context = await setupPersistedAttempt();
    const active = context.attempt;
    const reserved = rewindPersistedStart(context);
    expect(
      context.developers.startReservation(context.startEnvelope.idempotencyKey),
    ).toMatchObject({ attemptId: reserved.id });
    expect(
      context.fixture.commands.find(context.startEnvelope.idempotencyKey),
    ).toBeUndefined();
    context.dependencies.profiles.resolveApproved = () => {
      throw new Error('profile revision drifted after reservation');
    };
    context.dependencies.workspace.inspectProject = async () => {
      throw new Error('repository HEAD drifted after reservation');
    };
    const taskAuthority =
      context.dependencies.planning.taskExecutionAuthority.bind(
        context.dependencies.planning,
      );
    context.dependencies.planning.taskExecutionAuthority = (...input) => {
      const authority = taskAuthority(...input);
      return authority
        ? {
            ...authority,
            task: { ...authority.task, revision: authority.task.revision + 1 },
          }
        : authority;
    };

    context.dependencies.barrier.assertHealthy = () => {
      throw new Error('audit barrier is already tripped');
    };
    const blocked = await new DeveloperAttemptService(
      context.dependencies,
    ).start(context.startEnvelope);
    expect(blocked).toMatchObject({
      ok: false,
      error: { code: 'audit_barrier_tripped' },
    });
    expect(context.workspaceCalls).toHaveLength(0);
    expect(context.reserveStartCalls).toHaveLength(0);
    context.dependencies.barrier.assertHealthy = () => undefined;
    const recovered = new DeveloperAttemptService(context.dependencies);
    const result = await recovered.start(context.startEnvelope);
    const replay = await recovered.start(context.startEnvelope);

    expect(result).toMatchObject({
      ok: true,
      commandType: 'developer_attempt.start',
      attempt: { id: reserved.id, lifecycle: 'active' },
    });
    expect(replay).toEqual(result);
    expect(context.workspaceCalls).toHaveLength(1);
    expect(context.reserveStartCalls).toHaveLength(1);
    expect(context.developers.attempt(reserved.id)).toMatchObject({
      lifecycle: 'active',
      controllingExecutionId: active.controllingExecutionId,
    });
  });

  it('rolls back workspace failure settlement and replays it atomically after a crash', async () => {
    const context = await setupPersistedAttempt();
    const reserved = rewindPersistedStart(context);
    context.dependencies.workspace.create = async (workspace) => ({
      ...workspace,
      lifecycle: 'attention_required' as const,
      observedHead: 'b'.repeat(40),
      observedDirty: true,
      failure: {
        code: 'workspace_create_failed',
        message: 'Git worktree creation failed',
      },
    });
    const crashing = new DeveloperAttemptService({
      ...context.dependencies,
      events: {
        appendDomainInTransaction: () => {
          throw new Error('simulated crash before workspace settlement commit');
        },
      },
    } as never);

    const interrupted = await crashing.start(context.startEnvelope);

    expect(interrupted).toMatchObject({
      ok: false,
      error: { code: 'audit_barrier_tripped' },
    });
    expect(context.developers.attempt(reserved.id)).toMatchObject({
      lifecycle: 'reserved',
      revision: 0,
      workspace: { lifecycle: 'creating', revision: 0 },
    });
    expect(
      context.fixture.commands.find(context.startEnvelope.idempotencyKey),
    ).toBeUndefined();
    expect(
      context.developers.startReservation(context.startEnvelope.idempotencyKey),
    ).toMatchObject({ attemptId: reserved.id });

    const healthy = new DeveloperAttemptService(context.dependencies);
    const settled = await healthy.start(context.startEnvelope);
    const replay = await healthy.start(context.startEnvelope);

    expect(settled).toMatchObject({
      ok: false,
      error: { code: 'developer_workspace_conflict' },
    });
    expect(replay).toEqual(settled);
    expect(context.developers.attempt(reserved.id)).toMatchObject({
      lifecycle: 'attention_required',
      workspace: {
        lifecycle: 'attention_required',
        failure: { code: 'workspace_create_failed' },
      },
    });
    expect(
      context.developers.startReservation(context.startEnvelope.idempotencyKey),
    ).toBeUndefined();
  });

  it('rolls back failed execution settlement and replays it atomically after a crash', async () => {
    const context = await setupPersistedAttempt();
    const reserved = rewindPersistedStart(context);
    const adapterFailure = {
      ok: false as const,
      commandType: 'worker_execution.start' as const,
      error: {
        code: 'adapter_unavailable' as const,
        message: 'Adapter reservation failed',
      },
    };
    context.dependencies.execution.reserveStart = async () => ({
      execution: context.execution,
      result: adapterFailure,
      activationRequired: false,
    });
    const appendDomain = context.events.appendDomainInTransaction.bind(
      context.events,
    );
    const crashing = new DeveloperAttemptService({
      ...context.dependencies,
      events: {
        appendDomainInTransaction: (projectId, draft) => {
          if (draft.type === 'developer_attempt.changed') {
            throw new Error(
              'simulated crash before execution settlement commit',
            );
          }
          return appendDomain(projectId, draft);
        },
      },
    } as never);

    const interrupted = await crashing.start(context.startEnvelope);

    expect(interrupted).toMatchObject({
      ok: false,
      error: { code: 'audit_barrier_tripped' },
    });
    expect(context.developers.attempt(reserved.id)).toMatchObject({
      lifecycle: 'provisioning',
      controllingExecutionId: null,
      executionIds: [],
      workspace: { lifecycle: 'ready' },
    });
    expect(
      context.fixture.commands.find(context.startEnvelope.idempotencyKey),
    ).toBeUndefined();
    expect(
      context.developers.startReservation(context.startEnvelope.idempotencyKey),
    ).toMatchObject({ attemptId: reserved.id });

    const healthy = new DeveloperAttemptService(context.dependencies);
    const settled = await healthy.start(context.startEnvelope);
    const replay = await healthy.start(context.startEnvelope);

    expect(settled).toMatchObject({
      ok: false,
      commandType: 'developer_attempt.start',
      error: adapterFailure.error,
    });
    expect(replay).toEqual(settled);
    expect(context.developers.attempt(reserved.id)).toMatchObject({
      lifecycle: 'attention_required',
      controllingExecutionId: context.execution.id,
      executionIds: [context.execution.id],
      attention: { code: 'developer_attempt_start_failed' },
    });
    expect(
      context.developers.startReservation(context.startEnvelope.idempotencyKey),
    ).toBeUndefined();
  });

  it.each([
    [
      'missing authority',
      (context: ReturnType<typeof setup>) => {
        context.setAuthority(undefined);
      },
    ],
    [
      'stale plan ID',
      (context: ReturnType<typeof setup>) => {
        context.command.command.expectedDeliveryPlanId = randomUUID();
      },
    ],
    [
      'stale plan revision',
      (context: ReturnType<typeof setup>) => {
        context.command.command.expectedDeliveryPlanRevision = 2;
      },
    ],
    [
      'stale task revision',
      (context: ReturnType<typeof setup>) => {
        context.command.command.expectedTaskRevision = 2;
      },
    ],
    [
      'non-actionable readiness',
      (context: ReturnType<typeof setup>) => {
        context.setAuthority({
          ...context.getAuthority()!,
          card: {
            ...context.getAuthority()!.card,
            readiness: { state: 'blocked', blockers: [] },
          },
        });
      },
    ],
    [
      'controlling attempt',
      (context: ReturnType<typeof setup>) => {
        context.attempts.push({
          taskId: context.getAuthority()!.task.id,
        } as DeveloperAttempt);
      },
    ],
    [
      'incompatible profile',
      (context: ReturnType<typeof setup>) => {
        context.setProfile(createProfile(false));
      },
    ],
  ])('rejects %s before durable reservation', async (_name, change) => {
    const context = setup();
    change(context);
    const attemptCount = context.attempts.length;

    const result = await context.service.start(context.command);

    expect(result).toMatchObject({ ok: false });
    expect(context.attempts).toHaveLength(attemptCount);
    expect(context.workspaceCalls).toHaveLength(0);
    expect(context.executionCalls).toHaveLength(0);
    expect(context.events).toHaveLength(0);
  });

  it('rejects repository, billing, and audit changes before durable reservation', async () => {
    for (const options of [
      { repositoryIdentity: 'changed-identity' },
      { headCommit: 'b'.repeat(40) },
      { billingConflicts: [{ variable: 'ANTHROPIC_API_KEY' }] },
      { healthy: false },
    ]) {
      const context = setup(options);
      const result = await context.service.start(context.command);
      expect(result).toMatchObject({ ok: false });
      expect(context.attempts).toHaveLength(0);
      expect(context.workspaceCalls).toHaveLength(0);
      expect(context.executionCalls).toHaveLength(0);
      expect(context.events).toHaveLength(0);
    }
  });

  it('rejects a project-scoped profile for another project before inspection', async () => {
    const context = setup();
    context.setProfile({ ...createProfile(), projectId: randomUUID() });

    const result = await context.service.start(context.command);

    expect(result).toMatchObject({ ok: false });
    expect(context.inspectionCalls).toHaveLength(0);
    expect(context.attempts).toHaveLength(0);
    expect(context.workspaceCalls).toHaveLength(0);
    expect(context.executionCalls).toHaveLength(0);
    expect(context.events).toHaveLength(0);
  });

  it('revalidates authority after repository inspection before reserving', async () => {
    const context = setup();
    const authority = context.getAuthority()!;
    context.setInspectionHook(() => {
      context.setAuthority({
        ...authority,
        task: { ...authority.task, revision: authority.task.revision + 1 },
      });
    });

    const result = await context.service.start(context.command);

    expect(result).toMatchObject({ ok: false });
    expect(context.inspectionCalls).toHaveLength(1);
    expect(context.attempts).toHaveLength(0);
    expect(context.workspaceCalls).toHaveLength(0);
    expect(context.executionCalls).toHaveLength(0);
    expect(context.events).toHaveLength(0);
  });

  it('single-flights concurrent starts through delayed inspection and cleans up after failure', async () => {
    const context = setup();
    let release!: () => void;
    const inspected = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inspectedStart!: () => void;
    const inspectionStarted = new Promise<void>((resolve) => {
      inspectedStart = resolve;
    });
    let inspections = 0;
    context.dependencies.workspace.inspectProject = async () => {
      inspections += 1;
      inspectedStart();
      await inspected;
      throw new Error('transient inspection failure');
    };

    const first = context.service.start(context.command);
    const second = context.service.start(context.command);
    await inspectionStarted;
    expect(inspections).toBe(1);
    await expect(
      context.service.start({
        ...context.command,
        command: {
          ...context.command.command,
          projectId: randomUUID(),
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'idempotency_conflict' },
    });
    expect(context.trips).toEqual([]);
    release();
    const [failed, joined] = await Promise.all([first, second]);

    expect(joined).toEqual(failed);
    expect(context.attempts).toHaveLength(0);
    expect(context.workspaceCalls).toHaveLength(0);
    context.dependencies.workspace.inspectProject = async () => ({
      repositoryIdentity: context.fixture.project.repositoryIdentity,
      headCommit: context.fixture.project.headCommit,
    });
    const recovered = await context.service.start(context.command);
    expect(recovered).toMatchObject({ ok: true });
    expect(context.attempts).toHaveLength(1);
    expect(context.workspaceCalls).toHaveLength(1);
  });

  it('reports Developer command idempotency conflicts without poisoning the barrier', async () => {
    const context = setup();
    const idempotencyKey = randomUUID();
    context.commands.set(idempotencyKey, {
      requestHash: 'a'.repeat(64),
      result: {
        ok: false,
        commandType: 'developer_attempt.start',
        error: { code: 'invalid_request', message: 'prior result' },
      },
    });
    const start = {
      ...context.command,
      idempotencyKey,
    };
    const interrupt = {
      idempotencyKey,
      actor: { kind: 'human' as const },
      command: {
        type: 'developer_attempt.interrupt' as const,
        projectId: context.command.command.projectId,
        attemptId: randomUUID(),
        expectedAttemptRevision: 1,
      },
    };
    const replacement = {
      ...interrupt,
      command: {
        ...interrupt.command,
        type: 'developer_attempt.replace_execution' as const,
      },
    };

    await expect(context.service.start(start)).resolves.toMatchObject({
      ok: false,
      error: { code: 'idempotency_conflict' },
    });
    await expect(context.service.interrupt(interrupt)).resolves.toMatchObject({
      ok: false,
      error: { code: 'idempotency_conflict' },
    });
    await expect(
      context.service.replaceExecution(replacement),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'idempotency_conflict' },
    });
    expect(context.trips).toEqual([]);
  });

  it.each([
    'developer_attempt.start',
    'developer_attempt.interrupt',
    'developer_attempt.replace_execution',
  ] as const)(
    'trips the barrier when durable %s replay is unreadable',
    async (commandType) => {
      const context = setup();
      context.dependencies.commands.find = () => {
        throw new Error('stored command result is corrupt');
      };
      const mutation = {
        idempotencyKey: randomUUID(),
        actor: { kind: 'human' as const },
        command: {
          type: commandType,
          projectId: context.command.command.projectId,
          ...(commandType === 'developer_attempt.start'
            ? context.command.command
            : {
                attemptId: randomUUID(),
                expectedAttemptRevision: 1,
              }),
        },
      } as never;
      const result =
        commandType === 'developer_attempt.start'
          ? context.service.start(mutation)
          : commandType === 'developer_attempt.interrupt'
            ? context.service.interrupt(mutation)
            : context.service.replaceExecution(mutation);

      await expect(result).resolves.toMatchObject({
        ok: false,
        commandType,
        error: { code: 'audit_barrier_tripped' },
      });
      expect(context.trips).toHaveLength(1);
    },
  );

  it('trips the barrier when a durable Developer replay has corrupt identity', async () => {
    const context = setup();
    await expect(context.service.start(context.command)).resolves.toMatchObject(
      {
        ok: true,
      },
    );
    const stored = context.commands.get(context.command.idempotencyKey)!;
    const result = stored.result as Extract<
      V2CommandResult,
      { ok: true; commandType: 'developer_attempt.start' }
    >;
    context.commands.set(context.command.idempotencyKey, {
      ...stored,
      result: {
        ...result,
        attempt: { ...result.attempt, projectId: randomUUID() },
      },
    });

    await expect(context.service.start(context.command)).resolves.toMatchObject(
      {
        ok: false,
        commandType: 'developer_attempt.start',
        error: { code: 'audit_barrier_tripped' },
      },
    );
    expect(context.trips).toHaveLength(1);
  });

  it('persists Task 3 attention observations with their observed facts', async () => {
    const context = setup({
      workspaceObservation: (workspace) => ({
        ...workspace,
        lifecycle: 'attention_required',
        observedHead: 'b'.repeat(40),
        observedDirty: true,
        failure: {
          code: 'workspace_create_failed',
          message: 'Git worktree creation failed',
        },
      }),
    });

    const result = await context.service.start(context.command);
    const replay = await context.service.start(context.command);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'developer_workspace_conflict' },
    });
    expect(replay).toEqual(result);
    expect(context.attempts).toHaveLength(1);
    expect(context.attempts[0]).toMatchObject({
      lifecycle: 'attention_required',
      workspace: {
        lifecycle: 'attention_required',
        observedHead: 'b'.repeat(40),
        observedDirty: true,
        failure: {
          code: 'workspace_create_failed',
          message: 'Git worktree creation failed',
        },
      },
    });
    expect(context.executionCalls).toHaveLength(0);
    expect(context.startReservations).toEqual(new Map());
  });

  it('returns the durable adapter reservation failure after marking the attempt attention-required', async () => {
    const context = setup({ executionReservationFails: true });

    const result = await context.service.start(context.command);

    expect(result).toMatchObject({
      ok: false,
      commandType: 'developer_attempt.start',
      error: { code: 'adapter_unavailable' },
    });
    expect(context.attempts[0]).toMatchObject({
      lifecycle: 'attention_required',
      controllingExecutionId: context.attempts[0].executionIds[0],
    });
    expect(context.attempts[0].executionIds).toHaveLength(1);
    expect(context.startReservations).toEqual(new Map());
  });

  it('returns the stored adapter failure when attention publication fails', async () => {
    const context = setup({ executionReservationFails: true });
    const publish = context.dependencies.publishDomain;
    context.dependencies.publishDomain = (event) => {
      if (
        (event as { payload?: { attempt?: DeveloperAttempt } }).payload?.attempt
          ?.lifecycle === 'attention_required'
      )
        throw new Error('attention publication failed');
      publish(event);
    };

    const result = await context.service.start(context.command);
    const replay = await context.service.start(context.command);

    expect(result).toMatchObject({
      ok: false,
      commandType: 'developer_attempt.start',
      error: { code: 'adapter_unavailable' },
    });
    expect(replay).toEqual(result);
  });

  it.each(['publication', 'activation'] as const)(
    'returns the stored start result after post-commit %s failure',
    async (failure) => {
      const context = setup();
      if (failure === 'publication') {
        const publish = context.dependencies.publishDomain;
        context.dependencies.publishDomain = (event) => {
          if (
            (event as { payload?: { attempt?: DeveloperAttempt } }).payload
              ?.attempt?.lifecycle === 'active'
          )
            throw new Error('active publication failed');
          publish(event);
        };
      } else {
        context.dependencies.execution.activateReserved = async () => {
          throw new Error('activation failed');
        };
      }

      const result = await context.service.start(context.command);
      const replay = await context.service.start(context.command);

      expect(result).toMatchObject({
        ok: true,
        commandType: 'developer_attempt.start',
        attempt: { lifecycle: 'active' },
      });
      expect(replay).toEqual(result);
      expect(context.attempts[0]).toMatchObject({
        lifecycle: 'attention_required',
      });
    },
  );

  it('drains committed active reservations through ExecutionRuntime activation', async () => {
    const context = setup();
    const attemptId = randomUUID();
    const executionId = context.getAuthority()!.project.id;
    context.attempts.push({
      id: attemptId,
      lifecycle: 'active',
      controllingExecutionId: executionId,
    } as DeveloperAttempt);
    context.executionRecords.set(executionId, {
      ...context.fixture.execution,
      id: executionId as WorkerExecution['id'],
      lifecycle: 'starting',
    });

    await (
      context.service as DeveloperAttemptService & {
        drainPendingActivations(): Promise<void>;
      }
    ).drainPendingActivations();

    expect(context.executionCalls).toEqual([executionId]);
  });

  it.each(['running', 'completed'] as const)(
    'does not reactivate an active attempt whose execution is already %s',
    async (lifecycle) => {
      const context = setup();
      const attemptId = randomUUID();
      const executionId = context.fixture.execution.id;
      const execution = {
        ...context.fixture.execution,
        lifecycle,
        revision: 2,
        lastAdapterCursor: 2,
      } as WorkerExecution;
      context.attempts.push({
        id: attemptId,
        lifecycle: 'active',
        controllingExecutionId: executionId,
      } as DeveloperAttempt);
      context.executionRecords.set(executionId, execution);

      await context.service.drainPendingActivations();

      expect(context.executionCalls).toEqual([]);
      expect(context.executionRecords.get(executionId)).toEqual(execution);
    },
  );

  it('settles a proven interrupt from the exact active attempt revision', async () => {
    const context = setup();
    await context.service.start(context.command);
    const active = context.attempts[0];

    const result = await context.service.interrupt({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'developer_attempt.interrupt',
        projectId: active.projectId,
        attemptId: active.id,
        expectedAttemptRevision: active.revision,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      commandType: 'developer_attempt.interrupt',
      attempt: { lifecycle: 'interrupted' },
    });
    expect(context.attempts[0]).toMatchObject({
      lifecycle: 'interrupted',
      controllingExecutionId: active.controllingExecutionId,
      executionIds: active.executionIds,
      workspace: active.workspace,
    });
  });

  it('serializes concurrent interrupt replay through runtime settlement', async () => {
    const context = setup();
    await context.service.start(context.command);
    const active = context.attempts[0];
    const envelope = {
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' as const },
      command: {
        type: 'developer_attempt.interrupt' as const,
        projectId: active.projectId,
        attemptId: active.id,
        expectedAttemptRevision: active.revision,
      },
    };
    const runtimeInterrupt = context.dependencies.execution.interrupt;
    let runtimeCalls = 0;
    let runtimeStarted!: () => void;
    const runtimeStarting = new Promise<void>((resolve) => {
      runtimeStarted = resolve;
    });
    let releaseRuntime!: () => void;
    const runtimeReleased = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    context.dependencies.execution.interrupt = async (input) => {
      runtimeCalls += 1;
      runtimeStarted();
      await runtimeReleased;
      return runtimeInterrupt(input);
    };
    const publications: unknown[] = [];
    context.dependencies.publishDomain = (event) => publications.push(event);

    const first = context.service.interrupt(envelope);
    await runtimeStarting;
    const replay = context.service.interrupt(envelope);
    releaseRuntime();

    await expect(first).resolves.toMatchObject({
      ok: true,
      commandType: 'developer_attempt.interrupt',
      attempt: { lifecycle: 'interrupted' },
    });
    await expect(replay).resolves.toEqual(await first);
    expect(runtimeCalls).toBe(1);
    expect(publications).toHaveLength(1);
    await expect(
      context.service.interrupt({
        ...envelope,
        idempotencyKey: randomUUID(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'developer_attempt_transition_conflict' },
    });
  });

  it('persists the interrupted attempt before the generic interrupt', async () => {
    const context = await setupPersistedAttempt();
    const active = context.developers.attempt(context.attempt.id)!;
    context.fixture.database
      .prepare(
        'UPDATE worker_executions SET profile_snapshot_json = ? WHERE id = ?',
      )
      .run(
        JSON.stringify({
          profileId: context.fixture.profileRevision.profileId,
          projectId: context.fixture.profileRevision.projectId,
          profileRevision: context.fixture.profileRevision.revision,
          baseProfileId: context.fixture.profileRevision.baseProfileId,
          baseRevision: context.fixture.profileRevision.baseRevision,
          document: {
            ...context.fixture.profileRevision.document,
            spec: {
              ...context.fixture.profileRevision.document.spec,
              assignmentKinds: ['developer_task'],
              outputSchema: DEVELOPER_REPORT_SCHEMA,
            },
          },
          digest: context.fixture.profileRevision.digest,
        }),
        active.controllingExecutionId,
      );
    context.fixture.database
      .prepare(
        `UPDATE worker_executions
         SET lifecycle = 'running', revision = ?, updated_at = ?, ended_at = NULL
         WHERE id = ?`,
      )
      .run(1, later, active.controllingExecutionId);
    const executions = new ExecutionRepository(context.fixture.database);
    const service = new DeveloperAttemptService({
      ...context.dependencies,
      executions,
      execution: {
        reserveStart: context.dependencies.execution.reserveStart,
        reserveReplacement: async () => {
          throw new Error('not used');
        },
        activateReserved: context.dependencies.execution.activateReserved,
        interrupt: async (envelope) => {
          expect(context.developers.attempt(active.id)).toMatchObject({
            lifecycle: 'interrupted',
            endedAt: null,
          });
          const current = executions.get(envelope.command.executionId)!;
          context.fixture.database
            .prepare(
              `UPDATE worker_executions
               SET lifecycle = 'interrupted', revision = ?, updated_at = ?, ended_at = ?
               WHERE id = ? AND revision = ?`,
            )
            .run(
              current.revision + 1,
              later,
              later,
              current.id,
              current.revision,
            );
          const execution = executions.get(current.id)!;
          return {
            ok: true as const,
            commandType: 'worker_execution.interrupt' as const,
            execution,
          };
        },
      },
    });

    await expect(
      service.interrupt({
        idempotencyKey: randomUUID(),
        actor: { kind: 'human' },
        command: {
          type: 'developer_attempt.interrupt',
          projectId: active.projectId,
          attemptId: active.id,
          expectedAttemptRevision: active.revision,
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      attempt: { lifecycle: 'interrupted' },
    });
    expect(context.developers.attempt(active.id)).toMatchObject({
      lifecycle: 'interrupted',
      endedAt: null,
    });
    expect(executions.get(active.controllingExecutionId!)?.lifecycle).toBe(
      'interrupted',
    );
  });

  it('retries a persisted interrupt after accepted publication fails', async () => {
    const context = setup();
    await context.service.start(context.command);
    const active = context.attempts[0];
    const envelope = {
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' as const },
      command: {
        type: 'developer_attempt.interrupt' as const,
        projectId: active.projectId,
        attemptId: active.id,
        expectedAttemptRevision: active.revision,
      },
    };
    const interrupt = context.dependencies.execution.interrupt;
    let genericInterrupts = 0;
    context.dependencies.execution.interrupt = async (input) => {
      genericInterrupts += 1;
      return interrupt(input);
    };
    let publicationAttempts = 0;
    context.dependencies.publishDomain = () => {
      publicationAttempts += 1;
      throw new Error('accepted publication failed');
    };

    await expect(context.service.interrupt(envelope)).rejects.toThrow(
      'accepted publication failed',
    );
    expect(context.attempts[0].lifecycle).toBe('interrupted');
    expect(
      context.executionRecords.get(active.controllingExecutionId!)?.lifecycle,
    ).toBe('running');

    await expect(context.service.interrupt(envelope)).resolves.toMatchObject({
      ok: true,
      commandType: 'developer_attempt.interrupt',
      attempt: { lifecycle: 'interrupted' },
    });
    expect(
      context.executionRecords.get(active.controllingExecutionId!)?.lifecycle,
    ).toBe('interrupted');
    expect(genericInterrupts).toBe(1);
    expect(publicationAttempts).toBe(1);
  });

  it('replays a durable interrupt after recovery preserves its pending receipt', async () => {
    const context = setup();
    await context.service.start(context.command);
    const active = context.attempts[0];
    const envelope = {
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' as const },
      command: {
        type: 'developer_attempt.interrupt' as const,
        projectId: active.projectId,
        attemptId: active.id,
        expectedAttemptRevision: active.revision,
      },
    };
    const interrupt = context.dependencies.execution.interrupt;
    let genericInterrupts = 0;
    context.dependencies.execution.interrupt = async (input) => {
      genericInterrupts += 1;
      return interrupt(input);
    };
    let publicationAttempts = 0;
    context.dependencies.publishDomain = () => {
      publicationAttempts += 1;
      throw new Error('accepted publication failed');
    };

    await expect(context.service.interrupt(envelope)).rejects.toThrow(
      'accepted publication failed',
    );

    await expect(
      reconcileDeveloperAttempts({
        database: context.dependencies.database,
        developers: context.dependencies.developers,
        executions: context.dependencies.executions,
        workspace: { observe: context.dependencies.workspace.observe },
        planning: {
          taskExecutionAuthorityInTransaction:
            context.dependencies.planning.taskExecutionAuthorityInTransaction,
        },
        events: context.dependencies.events,
        barrier: context.dependencies.barrier,
        now: context.dependencies.now,
      } as never),
    ).resolves.toEqual({
      events: [],
      pendingActivationIds: [],
      pendingStartAttemptIds: [],
      pendingInterruptAttemptIds: [active.id],
    });
    expect(context.attempts[0]).toMatchObject({
      lifecycle: 'interrupted',
      endedAt: null,
    });

    await expect(context.service.interrupt(envelope)).resolves.toMatchObject({
      ok: true,
      commandType: 'developer_attempt.interrupt',
      attempt: { lifecycle: 'interrupted' },
    });
    expect(
      context.executionRecords.get(active.controllingExecutionId!)?.lifecycle,
    ).toBe('interrupted');
    expect(genericInterrupts).toBe(1);
    expect(publicationAttempts).toBe(1);
  });

  it('replays a durable interrupt after a dirty recovery observation', async () => {
    const context = setup();
    await context.service.start(context.command);
    const active = context.attempts[0];
    const envelope = {
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' as const },
      command: {
        type: 'developer_attempt.interrupt' as const,
        projectId: active.projectId,
        attemptId: active.id,
        expectedAttemptRevision: active.revision,
      },
    };
    const interrupt = context.dependencies.execution.interrupt;
    let genericInterrupts = 0;
    context.dependencies.execution.interrupt = async (input) => {
      genericInterrupts += 1;
      return interrupt(input);
    };
    let publicationAttempts = 0;
    context.dependencies.publishDomain = () => {
      publicationAttempts += 1;
      throw new Error('accepted publication failed');
    };

    await expect(context.service.interrupt(envelope)).rejects.toThrow(
      'accepted publication failed',
    );
    const receipt = context.attempts[0];
    const beforeEvents = context.events.length;
    context.dependencies.workspace.observe = async (workspace) => ({
      ...workspace,
      observedDirty: true,
    });

    await expect(
      reconcileDeveloperAttempts({
        database: context.dependencies.database,
        developers: context.dependencies.developers,
        executions: context.dependencies.executions,
        workspace: { observe: context.dependencies.workspace.observe },
        planning: {
          taskExecutionAuthorityInTransaction:
            context.dependencies.planning.taskExecutionAuthorityInTransaction,
        },
        events: context.dependencies.events,
        barrier: context.dependencies.barrier,
        now: context.dependencies.now,
      } as never),
    ).resolves.toEqual({
      events: [],
      pendingActivationIds: [],
      pendingStartAttemptIds: [],
      pendingInterruptAttemptIds: [active.id],
    });
    expect(context.attempts[0]).toEqual(receipt);
    expect(context.events).toHaveLength(beforeEvents);

    await expect(context.service.interrupt(envelope)).resolves.toMatchObject({
      ok: true,
      commandType: 'developer_attempt.interrupt',
      attempt: { lifecycle: 'interrupted' },
    });
    expect(
      context.executionRecords.get(active.controllingExecutionId!)?.lifecycle,
    ).toBe('interrupted');
    expect(genericInterrupts).toBe(1);
    expect(publicationAttempts).toBe(1);
  });

  it('passes the exact persisted execution revision to a rejected interrupt', async () => {
    const context = setup();
    await context.service.start(context.command);
    const active = context.attempts[0];
    const controlling = context.executionRecords.get(
      active.controllingExecutionId!,
    )!;
    let receivedRevision: number | undefined;
    context.dependencies.execution.interrupt = async (envelope) => {
      receivedRevision = envelope.command.expectedRevision;
      return {
        ok: false,
        commandType: 'worker_execution.interrupt' as const,
        error: {
          code: 'execution_lifecycle_conflict',
          message: 'Execution revision changed',
        },
      };
    };

    await context.service.interrupt({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'developer_attempt.interrupt',
        projectId: active.projectId,
        attemptId: active.id,
        expectedAttemptRevision: active.revision,
      },
    });

    expect(receivedRevision).toBe(controlling.revision);
    expect(context.attempts[0]).toMatchObject({
      lifecycle: 'attention_required',
      attention: { code: 'developer_interrupt_unproven' },
    });
  });

  it('rejects a stale Developer interrupt without changing the active attempt', async () => {
    const context = setup();
    await context.service.start(context.command);
    const active = context.attempts[0];

    const result = await context.service.interrupt({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'developer_attempt.interrupt',
        projectId: active.projectId,
        attemptId: active.id,
        expectedAttemptRevision: active.revision + 1,
      },
    });

    expect(result).toMatchObject({ ok: false });
    expect(context.attempts).toEqual([active]);
  });

  it('preserves a report durably settled before an interrupt request', async () => {
    const context = setup();
    await context.service.start(context.command);
    const active = context.attempts[0];
    const execution = {
      ...context.fixture.execution,
      id: active.controllingExecutionId,
      projectId: active.projectId,
      assignment: active.assignment,
    };
    await context.service.acceptReport(
      execution as never,
      {
        id: randomUUID(),
        type: 'worker_execution.structured_output',
        executionId: execution.id,
        projectId: execution.projectId,
        occurredAt: later,
        payload: {
          schema: DEVELOPER_REPORT_SCHEMA,
          value: completionReport(active),
        },
      } as never,
      completionReport(active),
    );

    const result = await context.service.interrupt({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'developer_attempt.interrupt',
        projectId: active.projectId,
        attemptId: active.id,
        expectedAttemptRevision: active.revision,
      },
    });

    expect(result).toMatchObject({ ok: false });
    expect(context.attempts[0]).toMatchObject({ lifecycle: 'completed' });
    expect(context.reports).toHaveLength(1);
  });

  it('marks the attempt attention-required when interruption is not proven', async () => {
    const context = setup();
    await context.service.start(context.command);
    const active = context.attempts[0];
    const controlling = context.executionRecords.get(
      active.controllingExecutionId!,
    )!;
    context.dependencies.execution.interrupt = async () => {
      context.executionRecords.set(controlling.id, {
        ...controlling,
        lifecycle: 'attention_required',
        revision: controlling.revision + 1,
      });
      return {
        ok: true,
        commandType: 'worker_execution.interrupt',
        execution: controlling,
      };
    };

    await context.service.interrupt({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'developer_attempt.interrupt',
        projectId: active.projectId,
        attemptId: active.id,
        expectedAttemptRevision: active.revision,
      },
    });

    expect(context.attempts[0]).toMatchObject({
      lifecycle: 'attention_required',
      attention: { code: 'developer_interrupt_unproven' },
    });
  });

  it('replaces only an interrupted attempt with its frozen assignment', async () => {
    const context = setup();
    await context.service.start(context.command);
    const active = context.attempts[0];
    await context.service.interrupt({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'developer_attempt.interrupt',
        projectId: active.projectId,
        attemptId: active.id,
        expectedAttemptRevision: active.revision,
      },
    });
    const interrupted = context.attempts[0];

    const result = await context.service.replaceExecution({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'developer_attempt.replace_execution',
        projectId: active.projectId,
        attemptId: active.id,
        expectedAttemptRevision: interrupted.revision,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      commandType: 'developer_attempt.replace_execution',
      attempt: {
        lifecycle: 'active',
        assignment: active.assignment,
        profileId: active.profileId,
        profileRevision: active.profileRevision,
        workspace: {
          path: active.workspace.path,
          branch: active.workspace.branch,
          baseCommit: active.workspace.baseCommit,
          lifecycle: 'ready',
        },
      },
    });
    expect(context.attempts[0].executionIds).toHaveLength(2);
  });

  it('does not overwrite a newer completion when replacement reservation fails', async () => {
    const context = setup();
    await context.service.start(context.command);
    const active = context.attempts[0];
    await context.service.interrupt({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'developer_attempt.interrupt',
        projectId: active.projectId,
        attemptId: active.id,
        expectedAttemptRevision: active.revision,
      },
    });
    const interrupted = context.attempts[0];
    let releaseReservation: (() => void) | undefined;
    const reservationReleased = new Promise<void>((resolve) => {
      releaseReservation = resolve;
    });
    let reservationEntered: (() => void) | undefined;
    const reservationStarted = new Promise<void>((resolve) => {
      reservationEntered = resolve;
    });
    context.dependencies.execution.reserveReplacement = async () => {
      reservationEntered!();
      await reservationReleased;
      throw new Error('replacement unavailable');
    };
    const beforeEvents = context.events.length;
    const replacing = context.service.replaceExecution({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'developer_attempt.replace_execution',
        projectId: interrupted.projectId,
        attemptId: interrupted.id,
        expectedAttemptRevision: interrupted.revision,
      },
    });
    await reservationStarted;
    context.attempts.splice(0, 1, {
      ...context.attempts[0],
      lifecycle: 'completed',
      revision: context.attempts[0].revision + 1,
      reportIds: [randomUUID()],
      endedAt: later,
    });
    releaseReservation!();

    await expect(replacing).resolves.toMatchObject({ ok: false });
    expect(context.attempts[0]).toMatchObject({
      lifecycle: 'completed',
      reportIds: [expect.any(String)],
    });
    expect(context.events).toHaveLength(beforeEvents);
  });

  it('does not overwrite a newer replacement when replacement reservation fails', async () => {
    const context = setup();
    await context.service.start(context.command);
    const active = context.attempts[0];
    await context.service.interrupt({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'developer_attempt.interrupt',
        projectId: active.projectId,
        attemptId: active.id,
        expectedAttemptRevision: active.revision,
      },
    });
    const interrupted = context.attempts[0];
    let releaseReservation: (() => void) | undefined;
    const reservationReleased = new Promise<void>((resolve) => {
      releaseReservation = resolve;
    });
    let reservationEntered: (() => void) | undefined;
    const reservationStarted = new Promise<void>((resolve) => {
      reservationEntered = resolve;
    });
    context.dependencies.execution.reserveReplacement = async () => {
      reservationEntered!();
      await reservationReleased;
      throw new Error('replacement unavailable');
    };
    const beforeEvents = context.events.length;
    const replacing = context.service.replaceExecution({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'developer_attempt.replace_execution',
        projectId: interrupted.projectId,
        attemptId: interrupted.id,
        expectedAttemptRevision: interrupted.revision,
      },
    });
    await reservationStarted;
    const successor = {
      ...context.executionRecords.get(interrupted.controllingExecutionId!)!,
      id: randomUUID(),
      lifecycle: 'starting' as const,
      revision: 0,
      replacementForExecutionId: interrupted.controllingExecutionId,
      endedAt: null,
    };
    context.executionRecords.set(successor.id, successor);
    context.attempts.splice(0, 1, {
      ...context.attempts[0],
      lifecycle: 'active',
      revision: context.attempts[0].revision + 1,
      controllingExecutionId: successor.id,
      executionIds: [...context.attempts[0].executionIds, successor.id],
      endedAt: null,
    });
    releaseReservation!();

    await expect(replacing).resolves.toMatchObject({ ok: false });
    expect(context.attempts[0]).toMatchObject({
      lifecycle: 'active',
      controllingExecutionId: successor.id,
    });
    expect(context.events).toHaveLength(beforeEvents);
  });

  it('refuses a replacement link after the attempt controller changes', async () => {
    const context = setup();
    await context.service.start(context.command);
    const active = context.attempts[0];
    await context.service.interrupt({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'developer_attempt.interrupt',
        projectId: active.projectId,
        attemptId: active.id,
        expectedAttemptRevision: active.revision,
      },
    });
    const interrupted = context.attempts[0];
    const reserveReplacement =
      context.dependencies.execution.reserveReplacement;
    context.dependencies.execution.reserveReplacement = async (
      envelope,
      replacementForExecutionId,
    ) => {
      const reservation = await reserveReplacement(
        envelope,
        replacementForExecutionId,
      );
      const successor = {
        ...reservation.execution,
        id: randomUUID(),
        revision: 0,
      };
      context.executionRecords.set(successor.id, successor);
      context.attempts.splice(0, 1, {
        ...context.attempts[0],
        lifecycle: 'active',
        revision: context.attempts[0].revision + 1,
        controllingExecutionId: successor.id,
        executionIds: [...context.attempts[0].executionIds, successor.id],
        endedAt: null,
      });
      return reservation;
    };
    const beforeEvents = context.events.length;
    const beforeActivations = context.executionCalls.length;

    const result = await context.service.replaceExecution({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'developer_attempt.replace_execution',
        projectId: interrupted.projectId,
        attemptId: interrupted.id,
        expectedAttemptRevision: interrupted.revision,
      },
    });

    expect(result).toMatchObject({ ok: false });
    expect(context.attempts[0].controllingExecutionId).not.toBe(
      interrupted.controllingExecutionId,
    );
    expect(context.events).toHaveLength(beforeEvents);
    expect(context.executionCalls).toHaveLength(beforeActivations);
  });

  it('rolls back replacement linkage when its event cannot be written', async () => {
    const context = await setupPersistedAttempt();
    const executions = new ExecutionRepository(context.fixture.database);
    const active = context.developers.attempt(context.attempt.id)!;
    context.fixture.database
      .prepare(
        'UPDATE worker_executions SET profile_snapshot_json = ? WHERE id = ?',
      )
      .run(
        JSON.stringify({
          profileId: context.fixture.profileRevision.profileId,
          projectId: context.fixture.profileRevision.projectId,
          profileRevision: context.fixture.profileRevision.revision,
          baseProfileId: context.fixture.profileRevision.baseProfileId,
          baseRevision: context.fixture.profileRevision.baseRevision,
          document: {
            ...context.fixture.profileRevision.document,
            spec: {
              ...context.fixture.profileRevision.document.spec,
              assignmentKinds: ['developer_task'],
              outputSchema: DEVELOPER_REPORT_SCHEMA,
            },
          },
          digest: context.fixture.profileRevision.digest,
        }),
        active.controllingExecutionId,
      );
    const prior = executions.get(active.controllingExecutionId!)!;
    context.fixture.database
      .prepare(
        `UPDATE worker_executions
         SET lifecycle = 'interrupted', revision = ?, updated_at = ?, ended_at = ?
         WHERE id = ?`,
      )
      .run(prior.revision + 1, later, later, prior.id);
    inImmediateTransaction(context.fixture.database, () =>
      context.developers.transitionAttemptInTransaction(
        {
          ...active,
          lifecycle: 'interrupted',
          revision: active.revision + 1,
          updatedAt: later,
          endedAt: null,
        },
        active.revision,
      ),
    );
    const interrupted = context.developers.attempt(active.id)!;
    const before = context.developers.attempt(active.id);
    const replacement = {
      ...executions.get(prior.id)!,
      id: randomUUID(),
      lifecycle: 'starting' as const,
      revision: 0,
      nativeHandle: null,
      replacementForExecutionId: prior.id,
      failure: null,
      createdAt: later,
      updatedAt: later,
      endedAt: null,
    };
    executions.transaction(() => executions.insertInTransaction(replacement));
    const beforeLinks = context.fixture.database
      .prepare(
        'SELECT attempt_id, execution_id FROM developer_attempt_executions WHERE attempt_id = ?',
      )
      .all(active.id);
    const beforeEvents = context.events.domainAfter(
      context.fixture.project.id,
      0,
    ).events;
    let activations = 0;
    const service = new DeveloperAttemptService({
      ...context.dependencies,
      executions,
      execution: {
        reserveStart: context.dependencies.execution.reserveStart,
        interrupt: async () => {
          throw new Error('not used');
        },
        reserveReplacement: async () => ({
          execution: replacement,
          result: {
            ok: true as const,
            commandType: 'worker_execution.start' as const,
            execution: replacement,
          },
          activationRequired: true,
        }),
        activateReserved: async () => {
          activations += 1;
        },
      },
      events: {
        appendDomainInTransaction: () => {
          throw new Error('replacement event failed');
        },
      },
    });

    await expect(
      service.replaceExecution({
        idempotencyKey: randomUUID(),
        actor: { kind: 'human' },
        command: {
          type: 'developer_attempt.replace_execution',
          projectId: interrupted.projectId,
          attemptId: interrupted.id,
          expectedAttemptRevision: interrupted.revision,
        },
      }),
    ).rejects.toThrow('replacement event failed');

    expect(context.developers.attempt(active.id)).toEqual(before);
    expect(activations).toBe(0);
    expect(
      context.fixture.database
        .prepare(
          'SELECT attempt_id, execution_id FROM developer_attempt_executions WHERE attempt_id = ?',
        )
        .all(active.id),
    ).toEqual(beforeLinks);
    expect(
      context.events.domainAfter(context.fixture.project.id, 0).events,
    ).toEqual(beforeEvents);
    expect(context.published).toEqual([]);
    expect(context.trips).toHaveLength(1);
  });

  it('rejects replacement while the attempt is still active', async () => {
    const context = setup();
    await context.service.start(context.command);
    const active = context.attempts[0];

    const result = await context.service.replaceExecution({
      idempotencyKey: randomUUID(),
      actor: { kind: 'human' },
      command: {
        type: 'developer_attempt.replace_execution',
        projectId: active.projectId,
        attemptId: active.id,
        expectedAttemptRevision: active.revision,
      },
    });

    expect(result).toMatchObject({ ok: false });
    expect(context.attempts).toEqual([active]);
  });
});
