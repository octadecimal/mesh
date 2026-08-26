import { StrictMode } from 'react';
import * as ReactDOM from 'react-dom/client';
import App from './app/app';
import { MeshApi } from './api/client';
import { MeshSocket } from './api/socket';
import { createResyncCoordinator } from './state/resync';
import { createMeshStore } from './state/store';
import 'dockview-react/dist/styles/dockview.css';
import './styles.css';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement,
);
const api = new MeshApi();

root.render(<main aria-busy="true">Loading Mesh…</main>);

const start = async () => {
  const initial = await api.snapshot();
  if (initial.projects.length === 0) {
    await api.discover({
      protocolVersion: 1,
      type: 'projects.discover',
      payload: {},
    });
  }
  await api.discover({
    protocolVersion: 1,
    type: 'sessions.discover',
    payload: {},
  });
  const snapshot = await api.snapshot();
  const store = createMeshStore(snapshot);
  const coordinator = createResyncCoordinator(api, store);
  let eventQueue = Promise.resolve();
  const socketUrl = new URL('/api/socket', window.location.href);
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new MeshSocket({
    url: socketUrl.toString(),
    cursors: () =>
      store.state.lastSequenceBySession.get({ noproxy: true }) as Record<
        string,
        number
      >,
    projectCursors: () =>
      store.state.projectCursors.get({ noproxy: true }) as Record<
        string,
        number
      >,
    onMessage: (message) => {
      if (message.type === 'snapshot') store.replaceSnapshot(message.payload);
      if (message.type === 'assistant.delta') {
        store.appendAssistantDelta(
          message.payload.sessionId,
          message.payload.text,
        );
      }
      if (message.type === 'events') {
        eventQueue = eventQueue
          .then(async () => {
            for (const event of message.payload.events) {
              await coordinator.applyEvent(event);
            }
          })
          .catch(() =>
            store.notifyInvalidPayload(
              'Mesh socket could not apply a session event.',
            ),
          );
      }
      if (message.type === 'project.event') {
        eventQueue = eventQueue
          .then(async () => {
            await coordinator.applyProjectEvent(message.payload.event);
          })
          .catch(() =>
            store.notifyInvalidPayload(
              'Mesh socket could not apply a project event.',
            ),
          );
      }
      if (message.type === 'connection.health') {
        store.setConnectionHealth(message.payload.status);
      }
    },
    onDiagnostic: store.notifyInvalidPayload,
    onReconnect: () => store.setConnectionHealth('disconnected'),
    resync: coordinator.refresh,
    projectResync: coordinator.refreshProject,
  });
  const connectedApi = {
    diagnostics: api.diagnostics.bind(api),
    discover: api.discover.bind(api),
    projectSnapshot: api.projectSnapshot.bind(api),
    command: async (...args: Parameters<MeshApi['command']>) => {
      let response: Awaited<ReturnType<MeshApi['command']>>;
      try {
        response = await api.command(...args);
      } catch (error) {
        await coordinator
          .refresh()
          .catch(() =>
            store.notifyInvalidPayload(
              'Mesh could not refresh state after the command failed.',
            ),
          );
        throw error;
      }
      await coordinator.refresh();
      if (args[0].type === 'project.import') {
        const project = response.result as { id: string };
        await coordinator.refreshProject(project.id);
        socket.resubscribe();
      }
      if (
        args[0].type === 'session.create' ||
        args[0].type === 'task.attempt.launch'
      )
        socket.resubscribe();
      return response;
    },
  };
  socket.connect();
  root.render(
    <StrictMode>
      <App api={connectedApi} store={store} />
    </StrictMode>,
  );
};

void start().catch(() => {
  root.render(
    <main role="alert">Mesh could not load the session snapshot.</main>,
  );
});
