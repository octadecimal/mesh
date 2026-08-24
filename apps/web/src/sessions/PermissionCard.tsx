import { useState } from 'react';
import type { MutatingCommand, PermissionMode, PermissionRequest, PermissionResolution } from '@mesh-session-platform/contracts';

export type CommandSender = (command: MutatingCommand, idempotencyKey?: string) => Promise<unknown>;

const idempotencyKey = () => globalThis.crypto?.randomUUID?.() ?? `permission-${Date.now()}-${Math.random()}`;

export function PermissionCard({ request, resolution, occurredAt, permissionMode, send }: {
  request: PermissionRequest;
  resolution?: PermissionResolution;
  occurredAt: string;
  permissionMode: PermissionMode;
  send: CommandSender;
}) {
  const [submitting, setSubmitting] = useState(false);
  const status = resolution?.decision ?? 'pending';
  const decide = async (decision: 'approve' | 'deny') => {
    setSubmitting(true);
    try {
      await send({ type: 'permission.decide', payload: { permissionId: request.permissionId, decision } }, idempotencyKey());
    } catch {
      setSubmitting(false);
    }
  };
  return <article className="permission-card" aria-label={`Permission ${request.name}`}>
    <h3>{request.name}</h3>
    <p>Requested {new Date(occurredAt).toLocaleString()}</p>
    <p>Policy mode: {permissionMode}</p>
    <pre aria-label="Permission arguments">{JSON.stringify(request.input, null, 2)}</pre>
    <p aria-live="polite">Status: {status}</p>
    {status === 'pending' ? <div>
      <button disabled={submitting || !request.actions.includes('approve')} onClick={() => void decide('approve')}>Approve</button>
      <button disabled={submitting || !request.actions.includes('deny')} onClick={() => void decide('deny')}>Deny</button>
    </div> : <p>Decision recorded {resolution?.resolvedAt ? new Date(resolution.resolvedAt).toLocaleString() : ''}</p>}
  </article>;
}
