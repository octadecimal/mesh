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
      if (message.type === 'connection.health') {
        store.setConnectionHealth(message.payload.status);
      }
    },
    onDiagnostic: store.notifyInvalidPayload,
    onReconnect: () => store.setConnectionHealth('disconnected'),
    resync: coordinator.refresh,
  });
  const connectedApi = {
    diagnostics: api.diagnostics.bind(api),
    command: async (...args: Parameters<MeshApi['command']>) => {
      const response = await api.command(...args);
      await coordinator.refresh();
      if (args[0].type === 'session.create') socket.resubscribe();
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
