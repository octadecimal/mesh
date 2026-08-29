import { randomUUID } from 'node:crypto';

import type {
  DomainEvent,
  ProfileApprovalEnvelope,
  V2CommandResult,
} from '@mesh/v2-contracts';

import {
  createV2TestDatabase,
  type V2TestDatabase,
} from '../test/create-v2-test-database.js';
import {
  WorkerProfileService,
  type ProfileProjectReader,
} from './profile-service.js';

const globalYaml = (
  instructions = 'Base instruction.',
) => `apiVersion: mesh.dev/v1alpha1
kind: WorkerProfile
metadata:
  name: profile-service-worker
  displayName: Profile service worker
  scope: global
spec:
  assignmentKinds:
    - foundation-check
  preferredRuntime:
    harness: fake
    model: deterministic
  alternatives: []
  requiredCapabilities:
    - execution.stream
  skills:
    preferred: []
    required: []
  instructions: ${instructions}
  outputSchema: mesh.dev/foundation-report/v1`;

const projectYaml = (baseRevision = 1) => `apiVersion: mesh.dev/v1alpha1
kind: WorkerProfile
metadata:
  name: todo-specialist
  displayName: Todo specialist
  scope: project
extends:
  profile: global/profile-service-worker
  revision: ${baseRevision}
spec:
  instructions: Project instruction.`;

const envelope = (
  sourceYaml: string,
  expectedLatestRevision: number,
  options: {
    idempotencyKey?: string;
    projectId?: string;
    scope?: 'global' | 'project';
  } = {},
): ProfileApprovalEnvelope => ({
  idempotencyKey: options.idempotencyKey ?? randomUUID(),
  actor: { kind: 'human' },
  command: {
    type: 'worker_profile.approve_revision',
    scope: options.scope ?? 'global',
    ...(options.projectId ? { projectId: options.projectId } : {}),
    sourceYaml,
    expectedLatestRevision,
  },
});

describe('WorkerProfileService', () => {
  let fixture: V2TestDatabase;
  let published: DomainEvent[];
  let projects: ProfileProjectReader;
  let service: WorkerProfileService;

  beforeEach(() => {
    fixture = createV2TestDatabase();
    published = [];
    projects = { exists: (projectId) => projectId === fixture.project.id };
    service = new WorkerProfileService({
      database: fixture.database,
      commands: fixture.commands,
      events: fixture.events,
      projects,
      publishDomain: (event) => {
        expect(fixture.database.inTransaction).toBe(false);
        published.push(event);
      },
      now: () => '2026-08-28T01:00:00.000Z',
    });
  });

  afterEach(() => fixture.close());

  const approveGlobal = (
    sourceYaml = globalYaml(),
    expectedLatestRevision = 0,
    idempotencyKey?: string,
  ) =>
    service.approveRevision(
      envelope(sourceYaml, expectedLatestRevision, { idempotencyKey }),
    );

  it('approves an immutable global revision without creating a project event', () => {
    const result = approveGlobal();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected profile approval');
    expect(result.profileRevision).toMatchObject({
      scope: 'global',
      projectId: null,
      revision: 1,
      name: 'profile-service-worker',
      approvedBy: { kind: 'human' },
    });
    expect(
      service
        .approvedGlobal()
        .find((profile) => profile.name === 'profile-service-worker'),
    ).toEqual(result.profileRevision);
    expect(fixture.events.cursors(fixture.project.id).domain).toBe(0);
    expect(published).toEqual([]);
  });

  it('returns the stored result for an idempotent approval', () => {
    const key = randomUUID();
    const first = approveGlobal(globalYaml(), 0, key);
    const second = approveGlobal(globalYaml(), 0, key);

    expect(second).toEqual(first);
    expect(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count FROM worker_profile_revisions
           WHERE profile_id = ?`,
        )
        .get(first.ok ? first.profileRevision.profileId : '') as {
        count: number;
      },
    ).toEqual({ count: 1 });
  });

  it('rejects a stale expected revision as an atomic no-op', () => {
    const approved = approveGlobal();
    if (!approved.ok) throw new Error('Expected initial approval');
    const before = fixture.database
      .prepare(
        `SELECT approved_revision AS approvedRevision
         FROM worker_profiles WHERE id = ?`,
      )
      .get(approved.profileRevision.profileId);

    const stale = approveGlobal(globalYaml('Changed.'), 0);

    expect(stale).toMatchObject({
      ok: false,
      commandType: 'worker_profile.approve_revision',
      error: { code: 'profile_revision_conflict' },
    });
    expect(
      fixture.database
        .prepare(
          'SELECT approved_revision AS approvedRevision FROM worker_profiles WHERE id = ?',
        )
        .get(approved.profileRevision.profileId),
    ).toEqual(before);
    expect(
      fixture.database
        .prepare(
          'SELECT COUNT(*) AS count FROM worker_profile_revisions WHERE profile_id = ?',
        )
        .get(approved.profileRevision.profileId),
    ).toEqual({ count: 1 });
  });

  it('creates the next revision on the same stable profile identity', () => {
    const first = approveGlobal();
    if (!first.ok) throw new Error('Expected first approval');
    const oldSource = first.profileRevision.sourceYaml;

    const second = approveGlobal(globalYaml('Second base instruction.'), 1);

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('Expected second approval');
    expect(second.profileRevision.profileId).toBe(
      first.profileRevision.profileId,
    );
    expect(second.profileRevision.revision).toBe(2);
    expect(
      service.resolveApproved(first.profileRevision.profileId, 1).document.spec
        .instructions,
    ).toBe('Base instruction.');
    expect(
      fixture.database
        .prepare(
          `SELECT source_yaml AS sourceYaml FROM worker_profile_revisions
           WHERE profile_id = ? AND revision = 1`,
        )
        .get(first.profileRevision.profileId),
    ).toEqual({ sourceYaml: oldSource });
  });

  it('reconstructs an old revision with its immutable display name', () => {
    const first = approveGlobal();
    if (!first.ok) throw new Error('Expected first approval');
    const renamedSource = globalYaml().replace(
      'displayName: Profile service worker',
      'displayName: Renamed service worker',
    );

    const second = approveGlobal(renamedSource, 1);

    expect(second.ok).toBe(true);
    expect(
      service.resolveApproved(first.profileRevision.profileId, 1).document
        .metadata.displayName,
    ).toBe('Profile service worker');
  });

  it('checks project existence inside the transaction before writing identity', () => {
    projects = {
      exists: () => {
        expect(fixture.database.inTransaction).toBe(true);
        return false;
      },
    };
    service = new WorkerProfileService({
      database: fixture.database,
      commands: fixture.commands,
      events: fixture.events,
      projects,
      publishDomain: (event) => published.push(event),
      now: () => '2026-08-28T01:00:00.000Z',
    });

    const result = service.approveRevision(
      envelope(projectYaml(), 0, {
        scope: 'project',
        projectId: fixture.project.id,
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'project_not_found' },
    });
    expect(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count FROM worker_profiles
           WHERE name = 'todo-specialist'`,
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it('rejects envelope and document scope mismatch without writing', () => {
    const result = service.approveRevision(
      envelope(globalYaml(), 0, {
        scope: 'project',
        projectId: fixture.project.id,
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'profile_scope_invalid' },
    });
    expect(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count FROM worker_profiles
           WHERE name = 'profile-service-worker'`,
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it('rejects a missing pinned global base without writing a project profile', () => {
    const result = service.approveRevision(
      envelope(projectYaml(), 0, {
        scope: 'project',
        projectId: fixture.project.id,
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'profile_not_found' },
    });
    expect(service.approvedForProject(fixture.project.id)).toEqual([]);
  });

  it('appends and publishes one project approval event only after commit', () => {
    const base = approveGlobal();
    if (!base.ok) throw new Error('Expected global approval');

    const result = service.approveRevision(
      envelope(projectYaml(), 0, {
        scope: 'project',
        projectId: fixture.project.id,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected project approval');
    expect(result.profileRevision).toMatchObject({
      scope: 'project',
      projectId: fixture.project.id,
      baseProfileId: base.profileRevision.profileId,
      baseRevision: 1,
    });
    expect(service.approvedForProject(fixture.project.id)).toEqual([
      result.profileRevision,
    ]);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      projectId: fixture.project.id,
      sequence: 1,
      type: 'worker_profile.revision_approved',
      payload: { profileRevision: result.profileRevision },
    });
  });

  it('keeps a project snapshot and digest stable after a later base revision', () => {
    const baseOne = approveGlobal();
    if (!baseOne.ok) throw new Error('Expected base revision one');
    const child = service.approveRevision(
      envelope(projectYaml(), 0, {
        scope: 'project',
        projectId: fixture.project.id,
      }),
    );
    if (!child.ok) throw new Error('Expected project approval');
    const before = service.resolveApproved(
      child.profileRevision.profileId,
      child.profileRevision.revision,
    );

    const baseTwo = approveGlobal(globalYaml('New base instruction.'), 1);

    expect(baseTwo.ok).toBe(true);
    expect(
      service.resolveApproved(
        child.profileRevision.profileId,
        child.profileRevision.revision,
      ),
    ).toEqual(before);
    expect(before.document.spec.instructions).toBe(
      'Base instruction.\n\nProject specialization:\nProject instruction.',
    );
  });

  it('returns invalid_request for strict YAML failures and stores no profile', () => {
    const result: V2CommandResult = approveGlobal(
      `${globalYaml()}\ncredentials: forbidden`,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count FROM worker_profiles
           WHERE name = 'profile-service-worker'`,
        )
        .get(),
    ).toEqual({ count: 0 });
  });
});
