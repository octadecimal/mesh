import { afterEach, describe, expect, it } from 'vitest';

import { projectSchema, sessionSchema, workspaceSchema, type LifecycleState } from '@mesh-session-platform/contracts';

import { createTestRepositories } from '../test/create-test-database.js';
import { recoverInterruptedSessions } from './recovery.js';

describe('runtime recovery', () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });

  it('atomically reconciles formerly live sessions without creating a driver or replaying a prompt', () => {
    const repos = createTestRepositories();
    disposers.push(repos.dispose);
    const timestamp = '2026-08-24T00:00:00.000Z';
    repos.projects.create(projectSchema.parse({
      id: 'p1', displayName: 'Platform', repositoryPath: 'C:/code/platform', discoveredAt: timestamp,
    }));
    repos.workspaces.create(workspaceSchema.parse({
      id: 'w1', projectId: 'p1', type: 'shared', path: 'C:/code/platform',
    }));
    const live: LifecycleState[] = ['starting', 'running', 'waiting_for_approval', 'interrupting'];
    for (const [index, lifecycleState] of live.entries()) {
      repos.sessions.create(sessionSchema.parse({
        id: `s${index + 1}`,
        claudeResumeId: `resume-${index + 1}`,
        projectId: 'p1', workspaceId: 'w1', title: `Session ${index + 1}`,
        permissionMode: 'interactive', lifecycleState, createdAt: timestamp, updatedAt: timestamp,
      }));
    }

    expect(recoverInterruptedSessions(repos.database)).toBe(4);

    for (const index of live.keys()) {
      const id = `s${index + 1}`;
      expect(repos.sessions.get(id)).toMatchObject({
        lifecycleState: 'interrupted',
        claudeResumeId: `resume-${index + 1}`,
      });
      expect(repos.events.after(id, 0)).toMatchObject([
        { sequence: 1, type: 'session.status', payload: { to: 'interrupted', reason: 'backend_restart' } },
      ]);
    }
  });
});
