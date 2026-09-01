import { randomUUID } from 'node:crypto';

import {
  DEVELOPER_REPORT_SCHEMA,
  type DeveloperAttempt,
  type DeveloperReport,
  type ManagedWorkspace,
  type ResolvedWorkerProfileSnapshot,
} from '@mesh/v2-contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DeveloperAttemptService,
  type StartDeveloperAttemptEnvelope,
  type TaskExecutionAuthority,
} from './developer-attempt-service.js';
import { createV2TestDatabase } from '../test/create-v2-test-database.js';
import { PlanningRepository } from '../planning/planning-repository.js';
import { approveTestDeliveryPlan } from '../test/approved-delivery-plan.js';
import { DeveloperReportConsumer } from './developer-report-consumer.js';
import { canonicalJson } from '../storage/canonical-json.js';
import { V2EventStore } from '../storage/event-store.js';
import { DeveloperRepository } from './developer-repository.js';

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
      create: async (workspace: ManagedWorkspace) => ({
        ...workspace,
        lifecycle: 'ready' as const,
        observedHead: fixture.project.headCommit,
        observedDirty: false,
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
  const result = await start.start({
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
  });
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
  };
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
    executionReservationFails?: boolean;
  } = {},
) => {
  const fixture = createV2TestDatabase();
  fixtures.push(fixture);
  let authority = options.authority ?? createAuthority(fixture);
  let profile = options.profile ?? createProfile();
  const phases: string[] = [];
  const attempts: DeveloperAttempt[] = options.existingAttempt
    ? [options.existingAttempt]
    : [];
  const commands = new Map<string, { requestHash: string; result: unknown }>();
  const workspaceCalls: ManagedWorkspace[] = [];
  const workspaceDerivations: unknown[] = [];
  const inspectionCalls: unknown[] = [];
  const executionCalls: unknown[] = [];
  const events: unknown[] = [];
  const reports: unknown[] = [];
  const receipts: unknown[] = [];
  const receiptsByRuntimeEvent = new Map<string, unknown>();
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
      reserveAttemptInTransaction: (attempt) => {
        attempts.push(attempt);
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
          executionIds: [executionId],
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
          throw new Error('conflict');
        return stored as never;
      },
      storeInTransaction: (stored) => {
        commands.set(stored.idempotencyKey, stored);
      },
    },
    events: {
      appendDomainInTransaction: (_projectId, event) => {
        events.push(event);
        return event;
      },
    },
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
                code: 'invalid_request',
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
    },
    barrier: {
      assertHealthy: () => {
        if (options.healthy === false) throw new Error('audit barrier tripped');
      },
      trip: () => undefined,
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
    events,
    reports,
    receipts,
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

    context.service.acceptReport(execution as never, event as never, report);

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

      context.service.acceptReport(
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

    context.service.acceptReport(
      execution as never,
      event(randomUUID()),
      report,
    );
    context.service.acceptReport(
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

    context.service.acceptReport(execution as never, event as never, report);
    const published = context.events.length;
    context.service.acceptReport(execution as never, event as never, report);
    expect(context.receipts).toHaveLength(1);
    expect(context.reports).toHaveLength(1);
    expect(context.events).toHaveLength(published);
    expect(() =>
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
    ).toThrow('conflicts with prior receipt');
    expect(context.reports).toHaveLength(1);
  });

  it.each(['receipt', 'report', 'attempt', 'event', 'task'] as const)(
    'rolls back the real persisted settlement graph when %s persistence fails',
    async (failure) => {
      const context = await setupPersistedAttempt({ failure });
      const runtimeEventId = randomUUID();
      const event = context.insertRuntimeEvent(runtimeEventId, context.report);

      expect(() =>
        context.service.acceptReport(context.execution, event, context.report),
      ).toThrow(`${failure} failure`);
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

    consumer.structuredOutput(context.execution, event);

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

    context.service.acceptReport(execution as never, event as never, report);

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

    context.service.acceptReport(
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

    expect(result).toMatchObject({ ok: true });
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
  });

  it('links a durably rejected execution before marking the attempt attention-required', async () => {
    const context = setup({ executionReservationFails: true });

    const result = await context.service.start(context.command);

    expect(result).toMatchObject({ ok: true });
    expect(context.attempts[0]).toMatchObject({
      lifecycle: 'attention_required',
      controllingExecutionId: context.attempts[0].executionIds[0],
    });
    expect(context.attempts[0].executionIds).toHaveLength(1);
  });

  it('drains committed active reservations through ExecutionRuntime activation', async () => {
    const context = setup();
    const attemptId = randomUUID();
    context.attempts.push({
      id: attemptId,
      lifecycle: 'active',
      controllingExecutionId: context.getAuthority()!.project.id,
    } as DeveloperAttempt);

    await (
      context.service as DeveloperAttemptService & {
        drainPendingActivations(): Promise<void>;
      }
    ).drainPendingActivations();

    expect(context.executionCalls).toEqual([
      context.getAuthority()!.project.id,
    ]);
  });
});
