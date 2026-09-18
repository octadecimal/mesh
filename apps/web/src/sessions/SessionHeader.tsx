import type { ReactNode } from 'react';
import type { Session } from '@mesh-session-platform/contracts';

export function SessionHeader({
  session,
  detailsOpen,
  detailsId,
  onDetailsOpenChange,
  actions,
}: {
  session: Session;
  detailsOpen: boolean;
  detailsId: string;
  onDetailsOpenChange: (open: boolean) => void;
  actions: ReactNode;
}) {
  return (
    <header className="session-header">
      <div className="session-header-summary">
        <div>
          <h2>{session.title}</h2>
          <p>Permission mode: {session.permissionMode}</p>
        </div>
        <span className="session-status" aria-live="polite">
          {session.lifecycleState}
        </span>
      </div>
      <div className="session-header-controls">
        <button
          className="button button-ghost"
          type="button"
          aria-controls={detailsId}
          aria-expanded={detailsOpen}
          onClick={() => onDetailsOpenChange(!detailsOpen)}
        >
          Details
        </button>
        {actions}
      </div>
    </header>
  );
}
