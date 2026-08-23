import type { AgentId, MeshEvent } from '../../../src/types.ts';

/** The message an agent is part-way through writing, per channel. */
export interface PartialText {
  text: string;
  thinking: string;
}

export type Partials = Record<AgentId, PartialText>;

const EMPTY: PartialText = { text: '', thinking: '' };

export function emptyPartials(): Partials {
  return {};
}

/**
 * Deltas are live-only, so a pending message is state the viewer keeps rather
 * than an event it can replay. The finished `text` or `thinking` event says the
 * same thing durably, which is what clears the buffer it was streamed into: the
 * pane then renders the completed line instead of the fragment.
 */
export function reducePartials(state: Partials, event: MeshEvent): Partials {
  const current = state[event.agent] ?? EMPTY;

  switch (event.kind) {
    case 'delta':
      return { ...state, [event.agent]: { ...current, [event.channel]: current[event.channel] + event.text } };
    case 'text':
      return current.text === '' ? state : { ...state, [event.agent]: { ...current, text: '' } };
    case 'thinking':
      return current.thinking === '' ? state : { ...state, [event.agent]: { ...current, thinking: '' } };
    case 'turn_end':
      // A turn can end without a finished message — an error, or a stop — so
      // anything still pending would otherwise stay on screen forever.
      return current === EMPTY || (current.text === '' && current.thinking === '') ? state : { ...state, [event.agent]: EMPTY };
    default:
      return state;
  }
}
