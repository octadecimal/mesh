import { afterEach, describe, expect, it } from 'vitest';

import {
  projectSchema,
  rawDiagnosticSchema,
  savedLayoutSchema,
  sessionSchema,
  workspaceSchema,
} from '@mesh-session-platform/contracts';

import { createTestRepositories } from '../test/create-test-database.js';

const project = () =>
  projectSchema.parse({
    id: 'p1',
    displayName: 'Platform',
    repositoryPath: 'C:/code/platform',
    discoveredAt: '2026-08-24T00:00:00.000Z',
    discoveryMetadata: { source: 'test' },
  });

const workspace = () =>
  workspaceSchema.parse({
    id: 'w1',
    projectId: 'p1',
    type: 'worktree',
    path: 'C:/code/platform-worktree',
    gitBranch: 'feature/persistence',
  });

const session = () =>
  sessionSchema.parse({
    id: 's1',
    projectId: 'p1',
    workspaceId: 'w1',
    title: 'Persistence',
    permissionMode: 'interactive',
    lifecycleState: 'running',
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  });

const diagnostic = (id: string, kind: string) =>
  rawDiagnosticSchema.parse({
    id,
    sessionId: 's1',
    capturedAt: '2026-08-24T00:01:00.000Z',
    payload: { kind },
  });

const userMessage = (text: string) => ({
  id: `event-${text}`,
  occurredAt: '2026-08-24T00:01:00.000Z',
  type: 'message.user' as const,
  payload: { text },
});

const assistantMessage = (text: string) => ({
  id: `event-${text}`,
  occurredAt: '2026-08-24T00:02:00.000Z',
  type: 'message.assistant' as const,
  payload: { text },
});

const seedSession = (repos: ReturnType<typeof createTestRepositories>) => {
  repos.projects.create(project());
  repos.workspaces.create(workspace());
  repos.sessions.create(session());
};

describe('repositories', () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    for (const dispose of disposers.splice(0)) {
      dispose();
    }
  });

  it('persists project and workspace records using their contract fields', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);

    repos.projects.create(project());
    repos.workspaces.create(workspace());

    expect(repos.projects.get('p1')).toMatchObject({
      displayName: 'Platform',
      discoveryMetadata: { source: 'test' },
    });
    expect(repos.workspaces.listByProject('p1')).toMatchObject([
      { id: 'w1', cleanupState: 'active' },
    ]);
  });

  it('omits archived sessions unless requested', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    seedSession(repos);

    repos.sessions.archive('s1');

    expect(repos.sessions.listByProject('p1')).toEqual([]);
    expect(repos.sessions.listByProject('p1', { includeArchived: true })).toMatchObject([
      { id: 's1', lifecycleState: 'archived' },
    ]);
  });

  it('appends normalized events and raw diagnostics atomically with consecutive sequence numbers', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    seedSession(repos);

    const first = repos.events.append('s1', userMessage('one'), diagnostic('d1', 'user'));
    const second = repos.events.append(
      's1',
      assistantMessage('two'),
      diagnostic('d2', 'assistant'),
    );

    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(repos.diagnostics.list('s1')).toMatchObject([
      { id: 'd1', normalizedEventId: 'event-one' },
      { id: 'd2', normalizedEventId: 'event-two' },
    ]);
  });

  it('rolls back event persistence when diagnostic persistence fails', () => {
    const repos = createTestRepositories({ failDiagnosticInsert: true });
    disposers.push(repos.dispose);
    seedSession(repos);

    expect(() =>
      repos.events.append('s1', userMessage('one'), diagnostic('d1', 'user')),
    ).toThrow('diagnostic insert failed');

    expect(repos.events.after('s1', 0)).toEqual([]);
    expect(repos.diagnostics.list('s1')).toEqual([]);
  });

  it('does not commit records when the normalized event is invalid', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    seedSession(repos);

    expect(() =>
      repos.events.append(
        's1',
        { ...userMessage('one'), payload: { text: 1 } },
        diagnostic('d1', 'user'),
      ),
    ).toThrow();

    expect(repos.events.after('s1', 0)).toEqual([]);
    expect(repos.diagnostics.list('s1')).toEqual([]);
  });

  it('cascades a deleted project through its session records', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    seedSession(repos);
    repos.events.append('s1', userMessage('one'), diagnostic('d1', 'user'));

    repos.projects.remove('p1');

    expect(repos.sessions.get('s1')).toBeUndefined();
    expect(repos.events.after('s1', 0)).toEqual([]);
    expect(repos.diagnostics.list('s1')).toEqual([]);
  });

  it('round-trips saved layouts with optional JSON fields', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    seedSession(repos);
    const layout = savedLayoutSchema.parse({
      id: 'layout-1',
      projectId: 'p1',
      sessionId: 's1',
      workspaceId: 'w1',
      dockview: { groups: [] },
      sidebar: { expanded: true },
      visiblePanels: ['history'],
      updatedAt: '2026-08-24T00:03:00.000Z',
    });

    repos.layouts.save(layout);

    expect(repos.layouts.get('layout-1')).toEqual(layout);
  });

  it('returns a stored command response without re-executing a duplicate key', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    let executions = 0;

    const first = repos.commands.executeOnce('command-1', () => {
      executions += 1;
      return { accepted: true };
    });
    const second = repos.commands.executeOnce('command-1', () => {
      executions += 1;
      return { accepted: false };
    });

    expect(first).toEqual({ accepted: true });
    expect(second).toEqual({ accepted: true });
    expect(executions).toBe(1);
  });
});
