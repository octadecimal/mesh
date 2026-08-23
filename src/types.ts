/** An agent's identity within one Claude Code process. */
export type AgentId = string;

/** The project manager is the top-level process, with no parent tool use. */
export const PM: AgentId = 'pm';

/** A raw stream-json line, before classification. */
export interface RawEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
  parent_tool_use_id?: string | null;
  [key: string]: unknown;
}

export interface TaskUsage {
  total_tokens: number;
  tool_uses: number;
  duration_ms: number;
}

export type MeshEvent =
  | { kind: 'init'; agent: AgentId; sessionId: string; model: string; tools: string[] }
  | { kind: 'text'; agent: AgentId; role: 'assistant' | 'user'; text: string }
  | { kind: 'thinking'; agent: AgentId; text: string }
  /**
   * A fragment of a message still being generated. Deltas are live-only: they
   * never enter the bus history, because the completed `text` or `thinking`
   * event that follows says the same thing durably.
   */
  | { kind: 'delta'; agent: AgentId; channel: 'text' | 'thinking'; text: string }
  | { kind: 'tool_use'; agent: AgentId; name: string; toolUseId: string; input: unknown }
  | { kind: 'tool_result'; agent: AgentId; toolUseId: string; isError: boolean }
  | {
      kind: 'task';
      agent: AgentId;
      taskId: string;
      status: 'started' | 'updated' | 'completed' | 'failed';
      subagentType?: string;
      description?: string;
      summary?: string;
      usage?: TaskUsage;
    }
  | { kind: 'roster'; agent: AgentId; taskIds: string[] }
  | { kind: 'quota'; agent: AgentId; status: string; rateLimitType: string; resetsAt: number }
  | { kind: 'turn_end'; agent: AgentId; isError: boolean; numTurns: number; resultText: string };

/** A Mesh event once the bus has ordered and timed it. */
export type StampedEvent = MeshEvent & { seq: number; ts: number };

export interface MeshConfig {
  /** Absolute path to the repository the agents work in. */
  targetRepo: string;
  /** Port the Mesh server listens on. */
  port: number;
  pm: {
    model: string;
    /** Set after the first run so restarts can --resume. */
    sessionId: string | null;
  };
}
