import type { SessionEvent, SessionSnapshot } from '@mesh-session-platform/contracts';

import { applyEvent, createProjection, replaceSnapshot } from './reducer';

const timestamp = '2026-08-24T00:00:00.000Z';

const event = (sequence: number): SessionEvent => ({
  protocolVersion: 1,
  id: `event-${sequence}`,
  sessionId: 'session-1',
  sequence,
  occurredAt: timestamp,
  type: 'message.assistant',
  payload: { text: `message ${sequence}` },
});

const snapshot = (sequence = 3): SessionSnapshot => ({
  protocolVersion: 1,
  projects: [],
  workspaces: [],
  sessions: [],
  events: sequence === 0 ? [] : [event(sequence)],
  pendingApprovals: [],
  lastSequenceBySession: { 'session-1': sequence },
  layouts: [],
});

describe('applyEvent', () => {
  it('reports duplicate, gap, then applied without changing the input projection', () => {
    const state = createProjection(snapshot());

    expect(applyEvent(state, event(3))).toEqual({ kind: 'duplicate' });
    expect(applyEvent(state, event(5))).toEqual({
      kind: 'gap',
      expected: 4,
      received: 5,
    });

    const applied = applyEvent(state, event(4));
    expect(applied.kind).toBe('applied');
    if (applied.kind === 'applied') {
      expect(applied.state.lastSequenceBySession['session-1']).toBe(4);
      expect(applied.state.events.map((item) => item.sequence)).toEqual([3, 4]);
    }
    expect(state.lastSequenceBySession['session-1']).toBe(3);
  });
});

describe('replaceSnapshot', () => {
  it('replaces canonical data while retaining prompt drafts and transient selections', () => {
    const current = {
      ...createProjection(snapshot()),
      selectedSessionId: 'session-1',
      promptDrafts: { 'session-1': 'keep this draft' },
      unreadSessionIds: { 'session-1': true },
    };
    const fresh = {
      ...snapshot(7),
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-1',
          workspaceId: 'workspace-1',
          title: 'Fresh session',
          permissionMode: 'interactive',
          lifecycleState: 'running',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    } satisfies SessionSnapshot;

    const next = replaceSnapshot(current, fresh);

    expect(next.sessions).toEqual(fresh.sessions);
    expect(next.lastSequenceBySession).toEqual({ 'session-1': 7 });
    expect(next.promptDrafts).toEqual({ 'session-1': 'keep this draft' });
    expect(next.selectedSessionId).toBe('session-1');
    expect(next.unreadSessionIds).toEqual({ 'session-1': true });
  });
});
