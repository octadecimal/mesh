import { useMemo, useState } from 'react';
import { useMeshEvents } from './useMeshEvents.ts';
import { groupIntoPanes, latestQuota } from './lib/panes.ts';
import type { PartialText } from './lib/partials.ts';
import type { StampedEvent } from '../../src/types.ts';

function EventLine({ event }: { event: StampedEvent }) {
  switch (event.kind) {
    case 'text':
      return <p className={`line text ${event.role}`}>{event.text}</p>;
    case 'thinking':
      return <p className="line thinking">{event.text}</p>;
    case 'tool_use':
      return <p className="line tool">{event.name}</p>;
    case 'tool_result':
      return <p className="line tool">{event.isError ? 'tool failed' : 'tool ok'}</p>;
    case 'task':
      return (
        <p className="line task">
          {event.subagentType ?? 'task'} {event.status}
          {event.summary ? `: ${event.summary}` : ''}
        </p>
      );
    case 'turn_end':
      return <hr className="turn" />;
    default:
      return null;
  }
}

/** The message an agent is still writing, rendered under its finished lines. */
function PendingLines({ pending }: { pending: PartialText }) {
  return (
    <>
      {pending.thinking ? <p className="line thinking partial">{pending.thinking}</p> : null}
      {pending.text ? <p className="line text assistant partial">{pending.text}</p> : null}
    </>
  );
}

export function App() {
  const { events, partials, connection } = useMeshEvents();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const panes = useMemo(() => groupIntoPanes(events), [events]);
  const quota = useMemo(() => latestQuota(events), [events]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await fetch('/api/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      setDraft('');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="app">
      <header>
        <strong>Mesh</strong>
        <span className={`status ${connection}`}>{connection}</span>
        {quota ? (
          <span className={`quota ${quota.status}`}>
            {quota.rateLimitType}: {quota.status}
            {quota.resetsAt ? ` · resets ${new Date(quota.resetsAt * 1000).toLocaleTimeString()}` : ''}
          </span>
        ) : null}
      </header>

      <main>
        {panes.map((pane) => (
          <section key={pane.agent} className="pane">
            <h2>{pane.title}</h2>
            <div className="transcript">
              {pane.events.map((event) => (
                <EventLine key={event.seq} event={event} />
              ))}
              <PendingLines pending={partials[pane.agent] ?? { text: '', thinking: '' }} />
            </div>
          </section>
        ))}
      </main>

      <footer>
        <textarea
          value={draft}
          placeholder="Message the project manager"
          onChange={(change) => setDraft(change.target.value)}
          onKeyDown={(key) => {
            if (key.key === 'Enter' && !key.shiftKey) {
              key.preventDefault();
              void send();
            }
          }}
        />
        <button type="button" onClick={() => void send()} disabled={sending}>
          Send
        </button>
      </footer>
    </div>
  );
}
