import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  projectSchema,
  idSchema,
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
  repos.projects.create(
    projectSchema.parse({
      id: 'p1',
      displayName: 'Platform',
      repositoryPath: 'C:/code/platform',
      discoveredAt: timestamp,
    }),
  );
  repos.workspaces.create(
    workspaceSchema.parse({
      id: 'w1',
      projectId: 'p1',
      type: 'shared',
      path: 'C:/code/platform',
    }),
  );
  repos.sessions.create(
    sessionSchema.parse({
      id: 's1',
      projectId: 'p1',
      workspaceId: 'w1',
      title: 'Runtime',
      permissionMode,
      lifecycleState,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
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
  const driver: ClaudeSessionDriver = {
    discover: async () => [],
    create,
    resume,
  };
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
    vi.useRealTimers();
    for (const dispose of disposers.splice(0)) dispose();
  });

  it('persists lifecycle and driver events before publishing and keeps running without subscribers', async () => {
    const { repos, driverSession, create, publisher, registry } = setup();
    disposers.push(repos.dispose);
    const observedPersisted: boolean[] = [];
    const unsubscribe = publisher.subscribe('s1', (event) => {
      observedPersisted.push(
        repos.events.after('s1', 0).some(({ id }) => id === event.id),
      );
    });

    await registry.create('s1');
    expect(create).toHaveBeenCalledOnce();
    expect(repos.sessions.get('s1')).toMatchObject({
      lifecycleState: 'running',
      claudeResumeId: 'claude-resume-1',
    });

    driverSession.enqueue({ kind: 'text_completed', text: 'first' });
    await vi.waitFor(() =>
      expect(
        repos.events
          .after('s1', 0)
          .some(
            (event) =>
              event.type === 'message.assistant' &&
              event.payload.text === 'first',
          ),
      ).toBe(true),
    );
    expect(observedPersisted.every(Boolean)).toBe(true);

    unsubscribe();
    driverSession.enqueue({ kind: 'text_completed', text: 'after disconnect' });
    await vi.waitFor(() =>
      expect(
        repos.events
          .after('s1', 0)
          .some(
            (event) =>
              event.type === 'message.assistant' &&
              event.payload.text === 'after disconnect',
          ),
      ).toBe(true),
    );

    await expect(registry.create('s1')).rejects.toMatchObject({
      code: 'invalid_session_state',
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it('publishes text deltas without persisting them as transcript events', async () => {
    const { repos, driverSession, publisher, registry } = setup();
    disposers.push(repos.dispose);
    const deltas: string[] = [];
    publisher.subscribeTransient('s1', ({ text }) => deltas.push(text));
    await registry.create('s1');
    const eventsBeforeDelta = repos.events.after('s1', 0);

    driverSession.enqueue({ kind: 'text_delta', text: 'Hel' });
    driverSession.enqueue({ kind: 'text_delta', text: 'lo' });

    await vi.waitFor(() => expect(deltas).toEqual(['Hel', 'lo']));
    expect(repos.events.after('s1', 0)).toEqual(eventsBeforeDelta);
  });

  it('persists repeated source-identified activity and reported usage before publication', async () => {
    const { repos, driverSession, publisher, registry } = setup();
    disposers.push(repos.dispose);
    const observedPersisted: boolean[] = [];
    publisher.subscribe('s1', (event) => {
      if (event.type === 'session.activity' || event.type === 'session.usage')
        observedPersisted.push(
          repos.events.after('s1', 0).some(({ id }) => id === event.id),
        );
    });
    await registry.create('s1');

    driverSession.enqueue({
      kind: 'activity',
      sourceEventId: 'sdk-progress-1',
      activity: {
        kind: 'tool_progress',
        summary: 'Read is running',
        toolCallId: idSchema.parse('tool-1'),
        elapsedSeconds: 1,
      },
    });
    driverSession.enqueue({
      kind: 'activity',
      sourceEventId: 'sdk-progress-2',
      activity: {
        kind: 'tool_progress',
        summary: 'Read is running',
        toolCallId: idSchema.parse('tool-1'),
        elapsedSeconds: 1,
      },
    });
    driverSession.enqueue({
      kind: 'usage',
      sourceEventId: 'sdk-result',
      usage: { model: 'claude-opus', inputTokens: 12, durationMs: 5 },
    });

    await vi.waitFor(() =>
      expect(
        repos.events
          .after('s1', 0)
          .filter(
            (event) =>
              event.type === 'session.activity' ||
              event.type === 'session.usage',
          ),
      ).toHaveLength(3),
    );
    expect(observedPersisted).toEqual([true, true, true]);
    expect(
      repos.events
        .after('s1', 0)
        .filter((event) => event.type === 'session.activity'),
    ).toHaveLength(2);
  });

  it('isolates a throwing subscriber while other subscribers receive persisted events', async () => {
    const { repos, driverSession, publisher, registry } = setup();
    disposers.push(repos.dispose);
    await registry.create('s1');
    const received: Array<{ text: string; persisted: boolean }> = [];
    publisher.subscribe('s1', () => {
      throw new Error('disconnected listener');
    });
    publisher.subscribe('s1', (event) => {
      if (event.type === 'message.assistant') {
        received.push({
          text: event.payload.text,
          persisted: repos.events
            .after('s1', 0)
            .some(({ id }) => id === event.id),
        });
      }
    });

    driverSession.enqueue({ kind: 'text_completed', text: 'still delivered' });

    await vi.waitFor(() =>
      expect(received).toEqual([{ text: 'still delivered', persisted: true }]),
    );
    expect(registry.auditStatus).toBe('available');
    expect(driverSession.interrupted).toBe(false);
    await registry.sendPrompt('s1', 'continue');
    expect(driverSession.prompts).toEqual(['continue']);
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

    await vi.waitFor(() =>
      expect(
        repos.events
          .after('s1', 0)
          .filter((stored) => stored.type === 'message.assistant'),
      ).toHaveLength(1),
    );
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
    await vi.waitFor(() =>
      expect(repos.sessions.get('s1')?.lifecycleState).toBe(
        'waiting_for_approval',
      ),
    );

    await expect(
      registry.sendPrompt('s1', 'duplicate side effect'),
    ).rejects.toMatchObject({
      code: 'invalid_session_state',
    });
    expect(driverSession.prompts).toEqual([]);
  });

  it('blocks a subscription-limited session and rejects further prompts', async () => {
    const { repos, driverSession, registry } = setup();
    disposers.push(repos.dispose);
    await registry.create('s1');

    driverSession.enqueue({
      kind: 'limit',
      capability: 'five_hour',
      message: 'Claude subscription limit reached',
      resetAt: '2026-08-25T08:00:00.000Z',
    });

    await vi.waitFor(() =>
      expect(repos.sessions.get('s1')?.lifecycleState).toBe('failed'),
    );
    expect(
      repos.events
        .after('s1', 0)
        .find((event) => event.type === 'session.error'),
    ).toMatchObject({
      payload: {
        code: 'subscription_limit',
        details: {
          capability: 'five_hour',
          resetAt: '2026-08-25T08:00:00.000Z',
        },
      },
    });
    expect(
      repos.events
        .after('s1', 0)
        .find(
          (event) =>
            event.type === 'session.status' && event.payload.to === 'failed',
        ),
    ).toMatchObject({ payload: { reason: 'subscription_limit' } });
    await expect(
      registry.sendPrompt('s1', 'keep running'),
    ).rejects.toMatchObject({
      code: 'invalid_session_state',
      from: 'failed',
    });
    expect(driverSession.prompts).toEqual([]);
  });

  it('persists a safe-auto permission resolution before approving it in the driver', async () => {
    const { repos, driverSession, registry } = setup({
      permissionMode: 'safe_auto',
    });
    disposers.push(repos.dispose);
    const auditedBeforeDecision: boolean[] = [];
    const originalResolve = driverSession.resolvePermission.bind(driverSession);
    driverSession.resolvePermission = async (requestId, decision) => {
      auditedBeforeDecision.push(
        repos.events
          .after('s1', 0)
          .some(
            (event) =>
              event.type === 'permission.resolved' &&
              event.payload.permissionId === requestId,
          ),
      );
      await originalResolve(requestId, decision);
    };
    await registry.create('s1');

    driverSession.enqueue({
      kind: 'permission_requested',
      permissionId: 'permission-safe',
      name: 'Read',
      input: { path: 'README.md' },
    });

    await vi.waitFor(() =>
      expect(driverSession.permissionDecisions).toEqual([
        { requestId: 'permission-safe', decision: 'approve' },
      ]),
    );
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

    await vi.waitFor(() =>
      expect(registry.auditStatus).toBe('audit_unavailable'),
    );
    expect(driverSession.interrupted).toBe(true);
    await expect(registry.sendPrompt('s1', 'blocked')).rejects.toMatchObject({
      code: 'audit_unavailable',
    });
    await expect(
      registry.resolvePermission('s1', 'permission-1', 'approve'),
    ).rejects.toMatchObject({
      code: 'audit_unavailable',
    });
  });

  it('preserves partial events and the resume id when the driver crashes', async () => {
    const { repos, driverSession, registry } = setup();
    disposers.push(repos.dispose);
    await registry.create('s1');
    driverSession.enqueue({ kind: 'text_completed', text: 'before crash' });
    await vi.waitFor(() =>
      expect(
        repos.events
          .after('s1', 0)
          .some((event) => event.type === 'message.assistant'),
      ).toBe(true),
    );

    driverSession.crash(new Error('driver crashed'));

    await vi.waitFor(() =>
      expect(repos.sessions.get('s1')).toMatchObject({
        lifecycleState: 'interrupted',
        claudeResumeId: 'claude-resume-1',
      }),
    );
    expect(
      repos.events
        .after('s1', 0)
        .some(
          (event) =>
            event.type === 'session.error' &&
            event.payload.message === 'driver crashed',
        ),
    ).toBe(true);
  });

  it('bounds shutdown, interrupts and closes every live session', async () => {
    let closed = false;
    const { repos, driverSession, registry } = setup({
      shutdownTimeoutMs: 10,
      closeDatabase: () => {
        closed = true;
      },
    });
    disposers.push(repos.dispose);
    await registry.create('s1');
    driverSession.interrupt = () => new Promise<void>(() => undefined);

    await registry.shutdown();

    expect(closed).toBe(true);
    expect(repos.sessions.get('s1')?.lifecycleState).toBe('interrupted');
  });

  it('uses the shutdown deadline when driver close never resolves', async () => {
    vi.useFakeTimers();
    let closed = false;
    const { repos, driverSession, registry } = setup({
      shutdownTimeoutMs: 10,
      closeDatabase: () => {
        closed = true;
      },
    });
    disposers.push(repos.dispose);
    await registry.create('s1');
    driverSession.close = () => new Promise<void>(() => undefined);

    let resolved = false;
    const shutdown = registry.shutdown().then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();

    expect(resolved).toBe(true);
    expect(closed).toBe(true);
    expect(repos.sessions.get('s1')?.lifecycleState).toBe('interrupted');
    await shutdown;
  });
});
