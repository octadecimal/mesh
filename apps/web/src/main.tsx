import { StrictMode } from 'react';
import * as ReactDOM from 'react-dom/client';
import App from './app/app';
import { MeshApi } from './api/client';
import { createMeshStore } from './state/store';
import 'dockview-react/dist/styles/dockview.css';
import './styles.css';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement,
);
const api = new MeshApi();

root.render(
  <main aria-busy="true">Loading Mesh…</main>,
);

void api.snapshot().then(
  (snapshot) => {
    root.render(
      <StrictMode>
        <App api={api} store={createMeshStore(snapshot)} />
      </StrictMode>,
    );
  },
  () => {
    root.render(<main role="alert">Mesh could not load the session snapshot.</main>);
  },
);
