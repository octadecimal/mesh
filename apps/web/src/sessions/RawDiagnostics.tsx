import * as Collapsible from '@radix-ui/react-collapsible';
import { useState } from 'react';
import type {
  RawDiagnostic,
  SessionDiagnostics,
} from '@mesh-session-platform/contracts';
import type { DiagnosticsOptions } from '../api/client';

const PAGE_SIZE = 10;

export function RawDiagnostics({
  sessionId,
  load,
}: {
  sessionId: string;
  load: (
    sessionId: string,
    options: DiagnosticsOptions,
  ) => Promise<SessionDiagnostics>;
}) {
  const [diagnostics, setDiagnostics] = useState<RawDiagnostic[]>([]);
  const [nextAfter, setNextAfter] = useState<SessionDiagnostics['nextAfter']>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const fetchPage = async (options: DiagnosticsOptions, append: boolean) => {
    setLoading(true);
    try {
      const page = await load(sessionId, options);
      setDiagnostics((current) =>
        append ? [...current, ...page.diagnostics] : page.diagnostics,
      );
      setNextAfter(page.nextAfter);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to load diagnostics',
      );
    } finally {
      setLoading(false);
    }
  };
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && diagnostics.length === 0 && !error)
      void fetchPage({ limit: PAGE_SIZE }, false);
  };
  return (
    <Collapsible.Root
      className="raw-diagnostics"
      open={open}
      onOpenChange={onOpenChange}
    >
      <Collapsible.Trigger asChild>
        <button className="button button-ghost" aria-expanded={open}>
          Raw diagnostics
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content aria-label="Raw diagnostics content">
        {error ? <p role="alert">{error}</p> : null}
        {diagnostics.map((diagnostic) => (
          <pre key={diagnostic.id} aria-label={`Diagnostic ${diagnostic.id}`}>
            {JSON.stringify(diagnostic.payload, null, 2)}
          </pre>
        ))}
        {nextAfter ? (
          <button
            disabled={loading}
            onClick={() =>
              void fetchPage({ after: nextAfter, limit: PAGE_SIZE }, true)
            }
          >
            Load more diagnostics
          </button>
        ) : null}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
