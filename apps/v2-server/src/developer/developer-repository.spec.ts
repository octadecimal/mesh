import { randomUUID } from 'node:crypto';

import {
  DEVELOPER_REPORT_SCHEMA,
  developerAttemptSchema,
  developerReportRecordSchema,
} from '@mesh/v2-contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { inImmediateTransaction } from '../db/database.js';
import { DeveloperRepository } from './developer-repository.js';
import {
  createV2TestDatabase,
  type V2TestDatabase,
} from '../test/create-v2-test-database.js';

const now = '2026-09-01T12:00:00.000Z';
const later = '2026-09-01T12:01:00.000Z';
const fixtures: V2TestDatabase[] = [];

const seedTaskAuthority = (fixture: V2TestDatabase) => {
  const deliveryPlanId = randomUUID();
  const proposalId = randomUUID();
  const intentId = randomUUID();
  const ledgerId = randomUUID();
  const milestoneId = randomUUID();
  const taskId = randomUUID();

  fixture.database.pragma('foreign_keys = OFF');
  fixture.database.exec(`
    INSERT INTO project_intent_revisions (
      id, project_id, revision, content_json, proposal_id, approved_by, approved_at
    ) VALUES ('${intentId}', '${fixture.project.id}', 1, '{}', '${proposalId}', 'human', '${now}');
    INSERT INTO ledger_revisions (
      id, project_id, revision, proposal_id, approved_by, approved_at
    ) VALUES ('${ledgerId}', '${fixture.project.id}', 1, '${proposalId}', 'human', '${now}');
    INSERT INTO delivery_plans (
      id, project_id, created_proposal_id, created_at
    ) VALUES ('${deliveryPlanId}', '${fixture.project.id}', '${proposalId}', '${now}');
    INSERT INTO delivery_plan_revisions (
      delivery_plan_id, project_id, revision, project_intent_id,
      project_intent_revision, ledger_id, ledger_revision,
      base_delivery_plan_revision, proposal_id, plan_json, approved_by, approved_at
    ) VALUES (
      '${deliveryPlanId}', '${fixture.project.id}', 1, '${intentId}', 1,
      '${ledgerId}', 1, NULL, '${proposalId}', '{}', 'human', '${now}'
    );
    INSERT INTO milestones (id, project_id, created_proposal_id, created_at)
    VALUES ('${milestoneId}', '${fixture.project.id}', '${proposalId}', '${now}');
    INSERT INTO tasks (id, project_id, created_proposal_id, created_at)
    VALUES ('${taskId}', '${fixture.project.id}', '${proposalId}', '${now}');
    INSERT INTO task_revisions (
      task_id, project_id, revision, contract_revision, revision_kind,
      lifecycle, milestone_id, revision_json
    ) VALUES (
      '${taskId}', '${fixture.project.id}', 1, 1, 'plan_contract',
      'pending', '${milestoneId}', '{}'
    );
  `);
  fixture.database.pragma('foreign_keys = ON');

  return { deliveryPlanId, taskId };
};

const cloneExecution = (fixture: V2TestDatabase) => {
  const id = randomUUID();
  fixture.database
    .prepare(
      `INSERT INTO worker_executions (
        id, project_id, profile_id, profile_revision, assignment_json,
        profile_snapshot_json, skill_requests_json, resolved_skills_json,
        capability_snapshot_json, adapter_id, model, native_handle, lifecycle,
        revision, last_adapter_cursor, last_runtime_sequence,
        replacement_for_execution_id, failure_json, created_at, updated_at, ended_at
      ) SELECT
        ?, project_id, profile_id, profile_revision, assignment_json,
        profile_snapshot_json, skill_requests_json, resolved_skills_json,
        capability_snapshot_json, adapter_id, model, native_handle, lifecycle,
        revision, last_adapter_cursor, last_runtime_sequence,
        replacement_for_execution_id, failure_json, created_at, updated_at, ended_at
      FROM worker_executions WHERE id = ?`,
    )
    .run(id, fixture.execution.id);
  return id;
};

const insertRuntimeEvent = (
  fixture: V2TestDatabase,
  runtimeEventId: string,
) => {
  const diagnosticId = randomUUID();
  fixture.database
    .prepare(
      `INSERT INTO raw_diagnostics (
        id, project_id, execution_id, adapter_id, adapter_cursor, received_at, payload_json
      ) VALUES (?, ?, ?, 'fake', 1, ?, '{}')`,
    )
    .run(diagnosticId, fixture.project.id, fixture.execution.id, now);
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
      fixture.execution.id,
      diagnosticId,
      now,
    );
};

const createAttempt = (fixture: V2TestDatabase, ordinal = 1) => {
  const { deliveryPlanId, taskId } = seedTaskAuthority(fixture);
  const attemptId = randomUUID();
  const requirementId = randomUUID();
  const assignment = {
    kind: 'developer_task' as const,
    projectId: fixture.project.id,
    attemptId,
    taskId,
    taskContractRevision: 1,
    taskCurrentRevision: 1,
    deliveryPlanId,
    deliveryPlanRevision: 1,
    requirementRevisions: [{ recordId: requirementId, recordRevision: 1 }],
    baseCommit: fixture.project.headCommit,
    workspacePath: `C:/mesh/${attemptId}`,
    title: 'Persist Todo items',
    outcome: 'Todo items survive reload.',
    acceptanceCriteria: ['Reload restores one Todo item.'],
    verification: ['Run the Todo persistence test.'],
    expectedArtifacts: ['src/todos.ts'],
    outputSchema: DEVELOPER_REPORT_SCHEMA,
  };
  return developerAttemptSchema.parse({
    id: attemptId,
    projectId: fixture.project.id,
    taskId,
    ordinal,
    lifecycle: 'reserved',
    revision: 0,
    deliveryPlanId,
    deliveryPlanRevision: 1,
    intentRevision: 1,
    ledgerRevision: 1,
    taskContractRevision: 1,
    taskCurrentRevision: 1,
    requirementRevisions: assignment.requirementRevisions,
    baseCommit: fixture.project.headCommit,
    profileId: fixture.profileRevision.profileId,
    profileRevision: 1,
    assignment,
    workspace: {
      attemptId,
      repositoryPath: fixture.project.repositoryPath,
      repositoryIdentity: fixture.project.repositoryIdentity,
      branch: `mesh/dev/${attemptId}`,
      path: assignment.workspacePath,
      baseCommit: fixture.project.headCommit,
      lifecycle: 'reserved',
      ownershipToken: `owner-${attemptId}`,
      observedHead: null,
      observedDirty: null,
      failure: null,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    },
    controllingExecutionId: null,
    executionIds: [],
    reportIds: [],
    attention: null,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
  });
};

const createReport = (
  attempt: ReturnType<typeof createAttempt>,
  executionId: string,
) =>
  developerReportRecordSchema.parse({
    id: randomUUID(),
    recordedAt: later,
    report: {
      schema: DEVELOPER_REPORT_SCHEMA,
      disposition: 'completed',
      attemptId: attempt.id,
      executionId,
      taskId: attempt.taskId,
      taskContractRevision: attempt.taskContractRevision,
      requirementCoverage: [
        {
          recordId: attempt.requirementRevisions[0].recordId,
          recordRevision: 1,
          passed: true,
          evidence: [],
        },
      ],
      criterionCoverage: [
        {
          index: 0,
          text: attempt.assignment.acceptanceCriteria[0],
          passed: true,
          evidence: [],
        },
      ],
      changedArtifacts: [
        { path: 'src/todos.ts', summary: 'Persisted Todo items.' },
      ],
      verification: [
        { command: 'pnpm test todos', passed: true, evidence: [] },
      ],
      unresolvedConcerns: [],
      workspace: { headCommit: attempt.baseCommit, dirty: false },
    },
  });

const createRepository = () => {
  const fixture = createV2TestDatabase();
  fixtures.push(fixture);
  return { fixture, repository: new DeveloperRepository(fixture.database) };
};

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

describe('DeveloperRepository', () => {
  it('rejects a second nonterminal reservation for the same task', () => {
    const { fixture, repository } = createRepository();
    const first = createAttempt(fixture);
    const secondAttemptId = randomUUID();
    const second = developerAttemptSchema.parse({
      ...first,
      id: secondAttemptId,
      ordinal: 2,
      assignment: { ...first.assignment, attemptId: secondAttemptId },
      workspace: {
        ...first.workspace,
        attemptId: secondAttemptId,
        branch: `mesh/dev/${secondAttemptId}`,
        path: `C:/mesh/${secondAttemptId}`,
        ownershipToken: `owner-${secondAttemptId}`,
      },
    });

    inImmediateTransaction(fixture.database, () =>
      repository.reserveAttemptInTransaction(first),
    );

    expect(() =>
      inImmediateTransaction(fixture.database, () =>
        repository.reserveAttemptInTransaction(second),
      ),
    ).toThrow(/developer attempt already controls task/i);
  });

  it('orders immutable execution and report history and validates reads', () => {
    const { fixture, repository } = createRepository();
    const attempt = createAttempt(fixture);
    const secondExecutionId = cloneExecution(fixture);
    const firstReport = createReport(attempt, fixture.execution.id);
    const secondReport = createReport(attempt, secondExecutionId);

    inImmediateTransaction(fixture.database, () => {
      repository.reserveAttemptInTransaction(attempt);
      repository.linkExecutionInTransaction({
        attemptId: attempt.id,
        executionId: fixture.execution.id,
        expectedRevision: 0,
        updatedAt: now,
      });
      repository.linkExecutionInTransaction({
        attemptId: attempt.id,
        executionId: secondExecutionId,
        expectedRevision: 1,
        updatedAt: later,
      });
      repository.insertReportInTransaction(firstReport);
      repository.insertReportInTransaction(secondReport);
    });

    expect(repository.attempt(attempt.id)?.executionIds).toEqual([
      fixture.execution.id,
      secondExecutionId,
    ]);
    expect(
      repository.reportsForProject(fixture.project.id).map(({ id }) => id),
    ).toEqual([firstReport.id, secondReport.id]);
    expect(() =>
      fixture.database
        .prepare("UPDATE developer_reports SET report_json = '{}' WHERE id = ?")
        .run(firstReport.id),
    ).toThrow(/immutable/i);

    fixture.database
      .prepare(
        "UPDATE developer_attempts SET assignment_json = '{}' WHERE id = ?",
      )
      .run(attempt.id);
    expect(() => repository.attempt(attempt.id)).toThrow();
  });

  it('uses optimistic revisions and idempotent output receipts', () => {
    const { fixture, repository } = createRepository();
    const attempt = createAttempt(fixture);
    const runtimeEventId = randomUUID();
    insertRuntimeEvent(fixture, runtimeEventId);

    inImmediateTransaction(fixture.database, () =>
      repository.reserveAttemptInTransaction(attempt),
    );
    const next = developerAttemptSchema.parse({
      ...attempt,
      lifecycle: 'provisioning',
      revision: 1,
      updatedAt: later,
    });
    inImmediateTransaction(fixture.database, () =>
      repository.transitionAttemptInTransaction(next, 0),
    );
    expect(() =>
      inImmediateTransaction(fixture.database, () =>
        repository.transitionAttemptInTransaction(next, 0),
      ),
    ).toThrow(/developer attempt revision conflict/i);

    inImmediateTransaction(fixture.database, () =>
      repository.linkExecutionInTransaction({
        attemptId: attempt.id,
        executionId: fixture.execution.id,
        expectedRevision: 1,
        updatedAt: later,
      }),
    );

    const receipt = {
      runtimeEventId,
      projectId: fixture.project.id,
      attemptId: attempt.id,
      executionId: fixture.execution.id,
      outputDigest: 'a'.repeat(64),
      status: 'rejected' as const,
      rejectionReason: 'The report is not bound to this attempt.',
      createdAt: later,
    };
    const stored = inImmediateTransaction(fixture.database, () =>
      repository.recordOutputReceiptInTransaction(receipt),
    );
    const replayed = inImmediateTransaction(fixture.database, () =>
      repository.recordOutputReceiptInTransaction(receipt),
    );
    expect(replayed).toEqual(stored);
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM developer_output_receipts')
        .get(),
    ).toEqual({ count: 1 });
  });

  it('rejects a transition that smuggles child projections', () => {
    const { fixture, repository } = createRepository();
    const attempt = createAttempt(fixture);
    const smuggled = developerAttemptSchema.parse({
      ...attempt,
      lifecycle: 'provisioning',
      revision: 1,
      updatedAt: later,
      workspace: {
        ...attempt.workspace,
        lifecycle: 'creating',
        revision: 1,
        updatedAt: later,
      },
      executionIds: [randomUUID()],
      reportIds: [randomUUID()],
    });

    inImmediateTransaction(fixture.database, () =>
      repository.reserveAttemptInTransaction(attempt),
    );
    expect(() =>
      inImmediateTransaction(fixture.database, () =>
        repository.transitionAttemptInTransaction(smuggled, 0),
      ),
    ).toThrow(/child projection/i);
  });

  it('rejects an unlinked controlling execution during transition', () => {
    const { fixture, repository } = createRepository();
    const attempt = createAttempt(fixture);
    const next = developerAttemptSchema.parse({
      ...attempt,
      lifecycle: 'provisioning',
      revision: 1,
      controllingExecutionId: fixture.execution.id,
      updatedAt: later,
    });

    inImmediateTransaction(fixture.database, () =>
      repository.reserveAttemptInTransaction(attempt),
    );
    expect(() =>
      inImmediateTransaction(fixture.database, () =>
        repository.transitionAttemptInTransaction(next, 0),
      ),
    ).toThrow(/controlling execution.*linked/i);
  });

  it('returns the persisted attempt after a transition', () => {
    const { fixture, repository } = createRepository();
    const attempt = createAttempt(fixture);
    const persistedAt = '2026-09-01T12:02:00.000Z';
    const next = developerAttemptSchema.parse({
      ...attempt,
      lifecycle: 'provisioning',
      revision: 1,
      updatedAt: later,
    });

    inImmediateTransaction(fixture.database, () =>
      repository.reserveAttemptInTransaction(attempt),
    );
    fixture.database.exec(`
      CREATE TRIGGER developer_attempts_persisted_return
      AFTER UPDATE ON developer_attempts
      BEGIN
        UPDATE developer_attempts SET updated_at = '${persistedAt}' WHERE id = NEW.id;
      END;
    `);
    const transitioned = inImmediateTransaction(fixture.database, () =>
      repository.transitionAttemptInTransaction(next, 0),
    );

    expect(transitioned).toEqual(repository.attempt(attempt.id));
    expect(transitioned.updatedAt).toBe(persistedAt);
  });

  it('rolls back an attempt, task revision, event, and receipt when report insertion fails', () => {
    const { fixture, repository } = createRepository();
    const attempt = createAttempt(fixture);
    const runtimeEventId = randomUUID();
    insertRuntimeEvent(fixture, runtimeEventId);
    const report = createReport(attempt, fixture.execution.id);
    fixture.database.exec(`
      CREATE TRIGGER developer_reports_fail_insert
      BEFORE INSERT ON developer_reports
      BEGIN SELECT RAISE(FAIL, 'report insert failed'); END;
    `);

    expect(() =>
      inImmediateTransaction(fixture.database, () => {
        repository.reserveAttemptInTransaction(attempt);
        repository.linkExecutionInTransaction({
          attemptId: attempt.id,
          executionId: fixture.execution.id,
          expectedRevision: 0,
          updatedAt: now,
        });
        repository.recordOutputReceiptInTransaction({
          runtimeEventId,
          projectId: fixture.project.id,
          attemptId: attempt.id,
          executionId: fixture.execution.id,
          outputDigest: 'b'.repeat(64),
          status: 'accepted',
          rejectionReason: null,
          createdAt: now,
        });
        fixture.database
          .prepare(
            `INSERT INTO task_revisions (
              task_id, project_id, revision, contract_revision, revision_kind,
              lifecycle, milestone_id, revision_json
            ) SELECT task_id, project_id, 2, contract_revision,
              'operational_lifecycle', 'completed', milestone_id, '{}'
            FROM task_revisions WHERE task_id = ? AND revision = 1`,
          )
          .run(attempt.taskId);
        fixture.events.appendDomainInTransaction(fixture.project.id, {
          projectId: fixture.project.id,
          occurredAt: now,
          type: 'project.registered',
          payload: { project: fixture.project },
        });
        repository.insertReportInTransaction(report);
      }),
    ).toThrow(/report insert failed/i);

    expect(repository.attempt(attempt.id)).toBeUndefined();
    expect(
      fixture.database
        .prepare(
          'SELECT COUNT(*) AS count FROM task_revisions WHERE task_id = ?',
        )
        .get(attempt.taskId),
    ).toEqual({ count: 1 });
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM domain_events')
        .get(),
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM developer_output_receipts')
        .get(),
    ).toEqual({ count: 0 });
  });
});
