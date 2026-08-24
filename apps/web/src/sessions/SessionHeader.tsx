import type { Session, Workspace } from '@mesh-session-platform/contracts';

export function SessionHeader({ session, workspace }: { session: Session; workspace?: Workspace }) {
  return <header className="session-header">
    <h2>{session.title}</h2>
    <dl>
      <div><dt>Repository</dt><dd>{workspace?.path ?? 'Unavailable'}</dd></div>
      <div><dt>Workspace</dt><dd>{workspace?.type ?? 'Unavailable'}</dd></div>
      <div><dt>Permission mode</dt><dd>{session.permissionMode}</dd></div>
      <div><dt>Status</dt><dd aria-live="polite">{session.lifecycleState}</dd></div>
    </dl>
  </header>;
}
