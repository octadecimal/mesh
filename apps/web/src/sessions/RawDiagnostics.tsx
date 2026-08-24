import * as Collapsible from '@radix-ui/react-collapsible';
import { useState } from 'react';
import type { SessionDiagnostics } from '@mesh-session-platform/contracts';

export function RawDiagnostics({ sessionId, load }: { sessionId: string; load: (sessionId: string) => Promise<SessionDiagnostics> }) {
  const [diagnostics, setDiagnostics] = useState<SessionDiagnostics>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(10);
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && !diagnostics && !error) void load(sessionId).then(setDiagnostics).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Unable to load diagnostics'));
  };
  return <Collapsible.Root open={open} onOpenChange={onOpenChange}>
    <Collapsible.Trigger asChild><button aria-expanded={open}>Raw diagnostics</button></Collapsible.Trigger>
    <Collapsible.Content aria-label="Raw diagnostics content">
      {error ? <p role="alert">{error}</p> : null}
      {diagnostics?.diagnostics.slice(0, visible).map((diagnostic) => <pre key={diagnostic.id} aria-label={`Diagnostic ${diagnostic.id}`}>{JSON.stringify(diagnostic.payload, null, 2)}</pre>)}
      {(diagnostics?.diagnostics.length ?? 0) > visible ? <button onClick={() => setVisible((value) => value + 10)}>Load more diagnostics</button> : null}
    </Collapsible.Content>
  </Collapsible.Root>;
}
