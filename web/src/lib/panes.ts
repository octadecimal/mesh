import { PM } from '../../../src/types.ts';
import type { AgentId, StampedEvent } from '../../../src/types.ts';

export interface Pane {
  agent: AgentId;
  title: string;
  events: StampedEvent[];
}

export interface QuotaState {
  status: string;
  rateLimitType: string;
  resetsAt: number;
}

/**
 * Subagent panes are keyed by parent_tool_use_id, but the human-readable name
 * only arrives on the PM's task_started event, which carries a different id.
 * Titles are therefore assigned in arrival order: the nth task started names
 * the nth distinct subagent pane.
 */
export function groupIntoPanes(events: StampedEvent[]): Pane[] {
  const byAgent = new Map<AgentId, StampedEvent[]>([[PM, []]]);
  const titles: string[] = [];

  for (const event of events) {
    if (event.kind === 'task' && event.status === 'started') {
      const label = event.subagentType ?? 'agent';
      titles.push(event.description ? `${label} · ${event.description}` : label);
    }
    const bucket = byAgent.get(event.agent);
    if (bucket) bucket.push(event);
    else byAgent.set(event.agent, [event]);
  }

  let subagentIndex = 0;
  return [...byAgent.entries()].map(([agent, agentEvents]) => {
    if (agent === PM) return { agent, title: 'Project manager', events: agentEvents };
    const title = titles[subagentIndex] ?? agent;
    subagentIndex += 1;
    return { agent, title, events: agentEvents };
  });
}

export function latestQuota(events: StampedEvent[]): QuotaState | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.kind === 'quota') {
      return { status: event.status, rateLimitType: event.rateLimitType, resetsAt: event.resetsAt };
    }
  }
  return null;
}
