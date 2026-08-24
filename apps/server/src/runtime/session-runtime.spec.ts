import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  projectSchema,
  sessionSchema,
  workspaceSchema,
  type Session,
} from '@mesh-session-platform/contracts';

import type { ClaudeSessionDriver } from '../claude/driver.js';
import { FakeDriverSession } from '../claude/fake-driver.js';
import { createTestRepositories } from '../test/create-test-database.js';
import { EventPublisher } from './event-publisher.js';
import { SessionRegistry } from './session-registry.js';

const timestamp = '2026-08-24T00:00:00.000Z';

const seed = (
  repos: ReturnType<typeof createTestRepositories>,
  lifecycleState: Session['lifecycleState'] = 'idle',
  permissionMode: Session['permissionMode'] = 'interactive',
) => {
  repos.projects.create(projectSchema.parse({
    id: 'p1',
    displayName: 'Platform',
    repositoryPath: 'C:/code/platform',
    discoveredAt: timestamp,
  }));
  repos.workspaces.create(workspaceSchema.parse({
    id: 'w1',
    projectId: 'p1',
    type: 'shared',
    path: 'C:/code/platform',
  }));
  repos.sessions.create(sessionSchema.parse({
    id: 's1',
    projectId: 'p1',
    workspaceId: 'w1',
    title: 'Runtime',
    permissionMode,
    lifecycleState,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
};

const setup = (options?: {
  shutdownTimeoutMs?: number;
  closeDatabase?: () => void;
  permissionMode?: Session['permissionMode'];
}) => {
  const repos = createTestRepositories();
  seed(repos, 'idle', options?.permissionMode);
  const driverSession = new FakeDriverSession('claude-resume-1');
  const create = vi.fn(async () => driverSession);
  const resume = vi.fn(async () => driverSession);
  const driver: ClaudeSessionDriver = { discover: async () => [], create, resume };
  const publisher = new EventPublisher();
  const registry = new SessionRegistry({
    database: repos.database,
    sessions: repos.sessions,
    workspaces: repos.workspaces,
    events: repos.events,
    diagnostics: repos.diagnostics,
    driver,
    publisher,
    shutdownTimeoutMs: options?.shutdownTimeoutMs,
    closeDatabase: options?.closeDatabase,
  });
  return { repos, driverSession, create, resume, publisher, registry };
};

describe('session runtime', () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });

  it('persists lifecycle and driver events before publishing and keeps running without subscribers', async () => {
    const { repos, driverSession, create, publisher, registry } = setup();
    disposers.push(repos.dispose);
    const observedPersisted: boolean[] = [];
    const unsubscribe = publisher.subscribe('s1', (event) => {
      observedPersisted.push(repos.events.after('s1', 0).some(({ id }) => id === event.id));
    });

    await registry.create('s1');
    expect(create).toHaveBeenCalledOnce();
    expect(repos.sessions.get('s1')).toMatchObject({
      lifecycleState: 'running',
      claudeResumeId: 'claude-resume-1',
    });

    driverSession.enqueue({ kind: 'text_completed', text: 'first' });
    await vi.waitFor(() => expect(repos.events.after('s1', 0).some(
      (event) => event.type === 'message.assistant' && event.payload.text === 'first',
    )).toBe(true));
    expect(observedPersisted.every(Boolean)).toBe(true);

    unsubscribe();
    driverSession.enqueue({ kind: 'text_completed', text: 'after disconnect' });
    await vi.waitFor(() => expect(repos.events.after('s1', 0).some(
      (event) => event.type === 'message.assistant' && event.payload.text === 'after disconnect',
    )).toBe(true));

    await expect(registry.create('s1')).rejects.toMatchObject({ code: 'invalid_session_state' });
    expect(create).toHaveBeenCalledOnce();
  });

  it('quarantines malformed events without a sequence gap and suppresses duplicate application', async () => {
    const { repos, driverSession, registry } = setup();
    disposers.push(repos.dispose);
    await registry.create('s1');

    driverSession.enqueue({ kind: 'malformed', raw: { surprise: true } });
    driverSession.enqueue({ kind: 'malformed', raw: undefined });
    const event = { kind: 'text_completed', text: 'once' } as const;
    driverSession.enqueue(event);
    driverSession.enqueue(event);

    await vi.waitFor(() => expect(repos.events.after('s1', 0).filter(
      (stored) => stored.type === 'message.assistant',
    )).toHaveLength(1));
    const events = repos.events.after('s1', 0);
    expect(events.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
    expect(repos.diagnostics.list('s1')).toHaveLength(events.length + 2);
    expect(registry.auditStatus).toBe('available');
  });

  it('rejects prompts while waiting for approval', async () => {
    const { repos, driverSession, registry } = setup();
    disposers.push(repos.dispose);
    await registry.create('s1');
    driverSession.enqueue({
      kind: 'permission_requested',
      permissionId: 'permission-1',
      name: 'Write',
      input: { path: 'file.txt' },
    });
    await vi.waitFor(() => expect(repos.sessions.get('s1')?.lifecycleState).toBe('waiting_for_approval'));

    await expect(registry.sendPrompt('s1', 'duplicate side effect')).rejects.toMatchObject({
      code: 'invalid_session_state',
    });
    expect(driverSession.prompts).toEqual([]);
  });

  it('persists a safe-auto permission resolution before approving it in the driver', async () => {
    const { repos, driverSession, registry } = setup({ permissionMode: 'safe_auto' });
    disposers.push(repos.dispose);
    const auditedBeforeDecision: boolean[] = [];
    const originalResolve = driverSession.resolvePermission.bind(driverSession);
    driverSession.resolvePermission = async (requestId, decision) => {
      auditedBeforeDecision.push(repos.events.after('s1', 0).some(
        (event) => event.type === 'permission.resolved' && event.payload.permissionId === requestId,
      ));
      await originalResolve(requestId, decision);
    };
    await registry.create('s1');

    driverSession.enqueue({
      kind: 'permission_requested',
      permissionId: 'permission-safe',
      name: 'Read',
      input: { path: 'README.md' },
    });

    await vi.waitFor(() => expect(driverSession.permissionDecisions).toEqual([
      { requestId: 'permission-safe', decision: 'approve' },
    ]));
    expect(auditedBeforeDecision).toEqual([true]);
    expect(repos.sessions.get('s1')?.lifecycleState).toBe('running');
  });

  it('sets a global audit barrier and interrupts drivers when persistence fails', async () => {
    const { repos, driverSession, registry } = setup();
    disposers.push(repos.dispose);
    await registry.create('s1');
    repos.database.exec(`
      CREATE TRIGGER fail_runtime_diagnostic
      BEFORE INSERT ON raw_diagnostics
      BEGIN SELECT RAISE(FAIL, 'audit failed'); END;
    `);

    driverSession.enqueue({ kind: 'text_completed', text: 'cannot audit' });

    await vi.waitFor(() => expect(registry.auditStatus).toBe('audit_unavailable'));
    expect(driverSession.interrupted).toBe(true);
    await expect(registry.sendPrompt('s1', 'blocked')).rejects.toMatchObject({ code: 'audit_unavailable' });
    await expect(registry.resolvePermission('s1', 'permission-1', 'approve')).rejects.toMatchObject({
      code: 'audit_unavailable',
    });
  });

  it('preserves partial events and the resume id when the driver crashes', async () => {
    const { repos, driverSession, registry } = setup();
    disposers.push(repos.dispose);
    await registry.create('s1');
    driverSession.enqueue({ kind: 'text_completed', text: 'before crash' });
    await vi.waitFor(() => expect(repos.events.after('s1', 0).some(
      (event) => event.type === 'message.assistant',
    )).toBe(true));

    driverSession.crash(new Error('driver crashed'));

    await vi.waitFor(() => expect(repos.sessions.get('s1')).toMatchObject({
      lifecycleState: 'interrupted',
      claudeResumeId: 'claude-resume-1',
    }));
    expect(repos.events.after('s1', 0).some(
      (event) => event.type === 'session.error' && event.payload.message === 'driver crashed',
    )).toBe(true);
  });

  it('bounds shutdown, interrupts and closes every live session', async () => {
    let closed = false;
    const { repos, driverSession, registry } = setup({
      shutdownTimeoutMs: 10,
      closeDatabase: () => { closed = true; },
    });
    disposers.push(repos.dispose);
    await registry.create('s1');
    driverSession.interrupt = () => new Promise<void>(() => undefined);

    await registry.shutdown();

    expect(closed).toBe(true);
    expect(repos.sessions.get('s1')?.lifecycleState).toBe('interrupted');
  });
});
