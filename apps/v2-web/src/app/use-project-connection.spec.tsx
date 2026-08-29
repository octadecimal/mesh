import { act, render, screen, waitFor } from '@testing-library/react';
import {
  V2_PROTOCOL_VERSION,
  v2ProjectSnapshotSchema,
  type ServerRealtimeMessage,
  type V2ProjectSnapshot,
} from '@mesh/v2-contracts';
import { expect, it, vi } from 'vitest';

import type { V2Api } from '../api/client';
import type { WebSocketLike } from '../api/socket';
import { useProjectConnection } from './use-project-connection';

const projectOne = '11111111-1111-4111-8111-111111111111';
const projectTwo = '22222222-2222-4222-8222-222222222222';
const executionId = '33333333-3333-4333-8333-333333333333';
const diagnosticId = '44444444-4444-4444-8444-444444444444';

const snapshot = (
  projectId: string,
  displayName: string,
  domain: number,
  runtime: number,
): V2ProjectSnapshot =>
  v2ProjectSnapshotSchema.parse({
    protocolVersion: V2_PROTOCOL_VERSION,
    project: {
      id: projectId,
      displayName,
      repositoryIdentity: `repo-${projectId}`,
      repositoryPath: `C:\\repos\\${displayName.toLowerCase()}`,
      gitCommonDirectory: `C:\\repos\\${displayName.toLowerCase()}\\.git`,
      headCommit: 'a'.repeat(40),
      revision: 1,
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    },
    profiles: [],
    executions: [],
    attentionItems: [],
    cursors: { domain, runtime },
  });

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

class FakeSocket extends EventTarget implements WebSocketLike {
  readonly OPEN = 1;
  readyState = this.OPEN;
  sent: string[] = [];
  close = vi.fn(() => this.dispatchEvent(new Event('close')));

  send(data: string) {
    this.sent.push(data);
  }

  open() {
    this.dispatchEvent(new Event('open'));
  }

  message(message: ServerRealtimeMessage) {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(message) }),
    );
  }
}

const Harness = ({
  api,
  projectId,
  socketFactory,
  protocol = 'https:',
}: {
  api: V2Api;
  projectId: string;
  socketFactory: (url: string) => WebSocketLike;
  protocol?: string;
}) => {
  const connection = useProjectConnection({
    api,
    projectId,
    socketFactory,
    location: { protocol, host: 'mesh.test' },
  });
  return (
    <>
      <p data-testid="project-id">{connection.projection.projectId}</p>
      <p data-testid="project-name">
        {connection.projection.project?.displayName ?? 'none'}
      </p>
      <p data-testid="connection">{connection.projection.connection.status}</p>
      <p data-testid="resyncing">{String(connection.resyncing)}</p>
      {connection.error ? <p role="alert">{connection.error}</p> : null}
    </>
  );
};

it('fetches before socket creation, replaces a stale projection once, and reconnects from current cursors', async () => {
  const calls: string[] = [];
  const replacement = deferred<V2ProjectSnapshot>();
  const projectSnapshot = vi
    .fn<
      Parameters<V2Api['projectSnapshot']>,
      ReturnType<V2Api['projectSnapshot']>
    >()
    .mockImplementationOnce(async () => {
      calls.push('snapshot');
      return snapshot(projectOne, 'Todo', 3, 5);
    })
    .mockImplementationOnce(() => {
      calls.push('resync');
      return replacement.promise;
    });
  const api: V2Api = {
    systemSnapshot: vi.fn(),
    projectSnapshot,
    command: vi.fn(),
  };
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const socketFactory = vi.fn((url: string) => {
    calls.push('socket');
    urls.push(url);
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });

  const view = render(
    <Harness api={api} projectId={projectOne} socketFactory={socketFactory} />,
  );
  expect(await screen.findByTestId('project-name')).toHaveTextContent('Todo');
  expect(calls.slice(0, 2)).toEqual(['snapshot', 'socket']);
  expect(urls).toEqual(['wss://mesh.test/api/v2/realtime']);

  act(() => {
    sockets[0]?.open();
    sockets[0]?.message({
      type: 'v2.subscribed',
      protocolVersion: V2_PROTOCOL_VERSION,
      projectId: projectOne,
      cursors: { domain: 3, runtime: 5 },
    });
  });
  expect(screen.getByTestId('connection')).toHaveTextContent('ready');

  act(() =>
    sockets[0]?.message({
      type: 'v2.runtime_event',
      protocolVersion: V2_PROTOCOL_VERSION,
      projectId: projectOne,
      event: {
        id: '55555555-5555-4555-8555-555555555555',
        projectId: projectOne,
        executionId,
        diagnosticId,
        sequence: 7,
        adapterCursor: 7,
        occurredAt: '2026-08-28T00:00:07.000Z',
        type: 'worker_execution.output',
        payload: { text: 'gap' },
      },
    }),
  );
  expect(screen.getByTestId('connection')).toHaveTextContent('stale');
  expect(screen.getByTestId('resyncing')).toHaveTextContent('true');
  expect(projectSnapshot).toHaveBeenCalledTimes(2);

  act(() =>
    sockets[0]?.message({
      type: 'v2.resync_required',
      protocolVersion: V2_PROTOCOL_VERSION,
      projectId: projectOne,
      reason: 'retained_gap',
    }),
  );
  expect(projectSnapshot).toHaveBeenCalledTimes(2);

  act(() => replacement.resolve(snapshot(projectOne, 'Todo refreshed', 8, 11)));
  await waitFor(() => expect(sockets).toHaveLength(2));
  expect(screen.getByTestId('project-name')).toHaveTextContent(
    'Todo refreshed',
  );
  expect(sockets[0]?.close).toHaveBeenCalledOnce();
  act(() => sockets[1]?.open());
  expect(JSON.parse(sockets[1]?.sent[0] ?? '{}')).toMatchObject({
    projectId: projectOne,
    cursors: { domain: 8, runtime: 11 },
  });

  view.unmount();
  expect(sockets[1]?.close).toHaveBeenCalledOnce();
});

it('cancels the old snapshot and connection when project ownership changes', async () => {
  const first = deferred<V2ProjectSnapshot>();
  const signals: AbortSignal[] = [];
  const api: V2Api = {
    systemSnapshot: vi.fn(),
    projectSnapshot: vi.fn((projectId, signal) => {
      if (signal) signals.push(signal);
      return projectId === projectOne
        ? first.promise
        : Promise.resolve(snapshot(projectTwo, 'Notes', 1, 2));
    }),
    command: vi.fn(),
  };
  const sockets: FakeSocket[] = [];
  const socketFactory = vi.fn(() => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  const view = render(
    <Harness api={api} projectId={projectOne} socketFactory={socketFactory} />,
  );

  view.rerender(
    <Harness api={api} projectId={projectTwo} socketFactory={socketFactory} />,
  );
  expect(signals[0]?.aborted).toBe(true);
  expect(await screen.findByTestId('project-name')).toHaveTextContent('Notes');
  expect(screen.getByTestId('project-id')).toHaveTextContent(projectTwo);
  expect(sockets).toHaveLength(1);

  act(() => first.resolve(snapshot(projectOne, 'Todo late', 9, 9)));
  await act(async () => Promise.resolve());
  expect(screen.getByTestId('project-name')).toHaveTextContent('Notes');
  expect(sockets).toHaveLength(1);
  view.unmount();
  expect(sockets[0]?.close).toHaveBeenCalledOnce();
});

it('surfaces snapshot failures without opening a socket', async () => {
  const api: V2Api = {
    systemSnapshot: vi.fn(),
    projectSnapshot: vi.fn(async () => {
      throw new Error('Project snapshot failed');
    }),
    command: vi.fn(),
  };
  const socketFactory = vi.fn();
  render(
    <Harness api={api} projectId={projectOne} socketFactory={socketFactory} />,
  );

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Project snapshot failed',
  );
  expect(socketFactory).not.toHaveBeenCalled();
});
