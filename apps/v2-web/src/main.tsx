import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createV2Api } from './api/client';
import { App, type AppLocation } from './app/App';
import './styles.css';

const location: AppLocation = {
  get pathname() {
    return window.location.pathname;
  },
  get search() {
    return window.location.search;
  },
  get protocol() {
    return window.location.protocol;
  },
  get host() {
    return window.location.host;
  },
  addEventListener: (type, listener) => window.addEventListener(type, listener),
  removeEventListener: (type, listener) =>
    window.removeEventListener(type, listener),
};

const root = document.getElementById('root');
if (!root) throw new Error('V2 application root is missing.');

createRoot(root).render(
  <StrictMode>
    <App
      api={createV2Api()}
      socketFactory={(url) => new WebSocket(url)}
      location={location}
      history={window.history}
    />
  </StrictMode>,
);
