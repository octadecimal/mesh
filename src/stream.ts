import { PM } from './types.ts';
import type { AgentId, MeshEvent, RawEvent, TaskUsage } from './types.ts';

/**
 * Stateful line splitter. Child stdout arrives in arbitrary chunks, so the
 * tail of an incomplete line is held until the rest arrives.
 */
export function createLineSplitter(): (chunk: string) => string[] {
  let remainder = '';
  return (chunk: string): string[] => {
    const combined = remainder + chunk;
    const parts = combined.split('\n');
    remainder = parts.pop() ?? '';
    return parts.filter((line) => line.trim().length > 0);
  };
}

/** Parse one NDJSON line. Returns null for anything unusable. */
export function parseLine(line: string): RawEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.type !== 'string') return null;
  return candidate as RawEvent;
}

/** Subagent events carry parent_tool_use_id; the PM's carry null or nothing. */
export function agentOf(raw: RawEvent): AgentId {
  const parent = raw.parent_tool_use_id;
  return typeof parent === 'string' && parent.length > 0 ? parent : PM;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

function blocksOf(raw: RawEvent): ContentBlock[] {
  const message = raw.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (Array.isArray(content)) return content as ContentBlock[];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function usageOf(value: unknown): TaskUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const u = value as Record<string, unknown>;
  return {
    total_tokens: typeof u.total_tokens === 'number' ? u.total_tokens : 0,
    tool_uses: typeof u.tool_uses === 'number' ? u.tool_uses : 0,
    duration_ms: typeof u.duration_ms === 'number' ? u.duration_ms : 0,
  };
}

function classifySystem(raw: RawEvent, agent: AgentId): MeshEvent[] {
  switch (raw.subtype) {
    case 'init':
      return [
        {
          kind: 'init',
          agent,
          sessionId: typeof raw.session_id === 'string' ? raw.session_id : '',
          model: typeof raw.model === 'string' ? raw.model : '',
          tools: Array.isArray(raw.tools) ? (raw.tools as string[]) : [],
        },
      ];

    case 'task_started':
      return [
        {
          kind: 'task',
          agent,
          taskId: String(raw.task_id ?? ''),
          status: 'started',
          subagentType: typeof raw.subagent_type === 'string' ? raw.subagent_type : undefined,
          description: typeof raw.description === 'string' ? raw.description : undefined,
        },
      ];

    case 'task_updated': {
      const patch = raw.patch as { status?: string } | undefined;
      return [
        {
          kind: 'task',
          agent,
          taskId: String(raw.task_id ?? ''),
          status: patch?.status === 'failed' ? 'failed' : 'updated',
        },
      ];
    }

    case 'task_notification':
      return [
        {
          kind: 'task',
          agent,
          taskId: String(raw.task_id ?? ''),
          status: raw.status === 'completed' ? 'completed' : 'failed',
          summary: typeof raw.summary === 'string' ? raw.summary : undefined,
          usage: usageOf(raw.usage),
        },
      ];

    case 'background_tasks_changed': {
      const tasks = Array.isArray(raw.tasks) ? (raw.tasks as { task_id?: unknown }[]) : [];
      return [{ kind: 'roster', agent, taskIds: tasks.map((t) => String(t.task_id ?? '')) }];
    }

    default:
      // hook_started, hook_response, thinking_tokens, task_progress: not shown.
      return [];
  }
}

/**
 * `--include-partial-messages` wraps the Anthropic streaming events in a
 * `stream_event` envelope. Only the two deltas the viewer renders are taken;
 * block starts and stops carry no text, and the completed message that
 * follows is what gets recorded.
 */
function classifyDelta(raw: RawEvent, agent: AgentId): MeshEvent[] {
  const event = raw.event as { type?: unknown; delta?: unknown } | undefined;
  if (event?.type !== 'content_block_delta') return [];

  const delta = event.delta as { type?: unknown; text?: unknown; thinking?: unknown } | undefined;
  if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
    return [{ kind: 'delta', agent, channel: 'text', text: delta.text }];
  }
  if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
    return [{ kind: 'delta', agent, channel: 'thinking', text: delta.thinking }];
  }
  return [];
}

export function classify(raw: RawEvent): MeshEvent[] {
  const agent = agentOf(raw);

  if (raw.type === 'system') return classifySystem(raw, agent);

  if (raw.type === 'stream_event') return classifyDelta(raw, agent);

  if (raw.type === 'rate_limit_event') {
    const info = raw.rate_limit_info as Record<string, unknown> | undefined;
    return [
      {
        kind: 'quota',
        agent,
        status: String(info?.status ?? 'unknown'),
        rateLimitType: String(info?.rateLimitType ?? 'unknown'),
        resetsAt: typeof info?.resetsAt === 'number' ? info.resetsAt : 0,
      },
    ];
  }

  if (raw.type === 'result') {
    return [
      {
        kind: 'turn_end',
        agent,
        isError: raw.is_error === true,
        numTurns: typeof raw.num_turns === 'number' ? raw.num_turns : 0,
        resultText: typeof raw.result === 'string' ? raw.result : '',
      },
    ];
  }

  if (raw.type === 'assistant' || raw.type === 'user') {
    const role: 'assistant' | 'user' = raw.type === 'assistant' ? 'assistant' : 'user';
    return blocksOf(raw).flatMap((block): MeshEvent[] => {
      if (block.type === 'text' && block.text) {
        return [{ kind: 'text', agent, role, text: block.text }];
      }
      if (block.type === 'thinking' && block.thinking) {
        return [{ kind: 'thinking', agent, text: block.thinking }];
      }
      if (block.type === 'tool_use') {
        return [
          {
            kind: 'tool_use',
            agent,
            name: block.name ?? 'unknown',
            toolUseId: block.id ?? '',
            input: block.input,
          },
        ];
      }
      if (block.type === 'tool_result') {
        return [
          {
            kind: 'tool_result',
            agent,
            toolUseId: block.tool_use_id ?? '',
            isError: block.is_error === true,
          },
        ];
      }
      return [];
    });
  }

  return [];
}
