import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMeshEvents } from './useMeshEvents.ts';
import { groupIntoPanes, latestQuota } from './lib/panes.ts';
import { isAtBottom } from './lib/scroll.ts';
import type { Pane } from './lib/panes.ts';
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

/**
 * One agent's scrolling transcript. A transcript parked at its bottom edge
 * follows whatever arrives next; one the reader has scrolled up holds its
 * position and offers a button back to the end instead, so an agent writing
 * cannot yank the passage being read out from under them.
 */
function Transcript({ pane, pending }: { pane: Pane; pending: PartialText }) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [hasNew, setHasNew] = useState(false);

  // Growth is what should move the transcript, so the effect below is keyed on
  // what has arrived rather than firing on every render. Streamed partials
  // count: an agent mid-sentence is new content like any other.
  const arrived = `${pane.events.at(-1)?.seq ?? 0}:${pending.text.length}:${pending.thinking.length}`;

  // Layout, not effect: the scroll has to land in the same frame as the new
  // line, or the transcript visibly lurches.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (pinned.current) el.scrollTop = el.scrollHeight;
    else setHasNew(true);
  }, [arrived]);

  // Whether the reader is parked at the bottom is only ever read inside the
  // handlers, so it lives in a ref: re-rendering the pane on every scroll tick
  // would buy nothing.
  function trackPosition() {
    const el = box.current;
    if (!el) return;
    pinned.current = isAtBottom(el);
    if (pinned.current) setHasNew(false);
  }

  function jumpToEnd() {
    const el = box.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinned.current = true;
    setHasNew(false);
  }

  return (
    <>
      <div className="transcript" ref={box} onScroll={trackPosition}>
        {pane.events.map((event) => (
          <EventLine key={event.seq} event={event} />
        ))}
        <PendingLines pending={pending} />
      </div>
      {hasNew ? (
        <button type="button" className="jump-to-end" onClick={jumpToEnd}>
          ↓ New messages
        </button>
      ) : null}
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
            <Transcript pane={pane} pending={partials[pane.agent] ?? { text: '', thinking: '' }} />
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
