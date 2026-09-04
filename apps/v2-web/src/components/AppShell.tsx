import type { V2Health } from '@mesh/v2-contracts';
import type { ReactNode } from 'react';

import { appHref, type AppRoute } from '../app/routes';
import { ThemeSelect } from './ThemeSelect';

const destinations = [
  { label: 'Inbox', route: { page: 'inbox' } },
  { label: 'Runs', route: { page: 'runs' } },
  { label: 'Projects', route: { page: 'projects' } },
] as const;

const currentDestination = (route: AppRoute, destination: AppRoute['page']) =>
  route.page === destination ||
  (destination === 'projects' && route.page === 'project');

export function AppShell({
  route,
  health,
  onNavigate,
  project,
  children,
}: {
  route: AppRoute;
  health: V2Health;
  onNavigate: (href: string) => void;
  project?: { displayName: string };
  children: ReactNode;
}) {
  const healthText =
    health.status === 'ok'
      ? 'System health: operational'
      : health.error.message;

  return (
    <div className="v2-app-shell">
      <nav className="v2-global-nav" aria-label="Global navigation">
        <a
          href={appHref({ page: 'inbox' })}
          onClick={(event) => {
            event.preventDefault();
            onNavigate('/');
          }}
        >
          Mesh
        </a>
        {destinations.map(({ label, route: destination }) => {
          const href = appHref(destination);
          return (
            <a
              key={label}
              href={href}
              aria-current={
                currentDestination(route, destination.page) ? 'page' : undefined
              }
              onClick={(event) => {
                event.preventDefault();
                onNavigate(href);
              }}
            >
              {label}
            </a>
          );
        })}
      </nav>
      <div className="v2-app-content">
        <header className="v2-app-header">
          <div>
            <p className="v2-eyebrow">Mesh V2</p>
            {project ? <p>{project.displayName}</p> : null}
          </div>
          <p role="status">{healthText}</p>
          <ThemeSelect />
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}
