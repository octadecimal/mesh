import type {
  LifecycleState,
  PermissionMode,
} from '@mesh-session-platform/contracts';

export interface DiscoverClaudeSessionsRequest {
  workspacePath?: string;
}

export interface DiscoveredClaudeSession {
  claudeResumeId: string;
  title?: string;
}

export interface StartClaudeSessionRequest {
  title: string;
  workspacePath?: string;
  permissionMode?: PermissionMode;
}

export interface ResumeClaudeSessionRequest {
  claudeResumeId: string;
  workspacePath?: string;
  permissionMode?: PermissionMode;
}

export type DriverEvent =
  | { kind: 'text_delta'; text: string }
  | { kind: 'text_completed'; text: string }
  | { kind: 'tool_requested'; toolCallId: string; name: string; input: unknown }
  | {
      kind: 'tool_completed';
      toolCallId: string;
      output: unknown;
      isError: boolean;
    }
  | {
      kind: 'permission_requested';
      permissionId: string;
      toolCallId?: string;
      name: string;
      input: unknown;
    }
  | {
      kind: 'status';
      from: LifecycleState;
      to: LifecycleState;
      reason?: string;
    }
  | { kind: 'limit'; capability: string; message: string }
  | { kind: 'malformed'; raw: unknown }
  | {
      kind: 'terminal_error';
      code: string;
      message: string;
      details?: unknown;
    };

export interface ClaudeSessionDriver {
  discover(
    request: DiscoverClaudeSessionsRequest,
  ): Promise<DiscoveredClaudeSession[]>;
  create(request: StartClaudeSessionRequest): Promise<DriverSession>;
  resume(request: ResumeClaudeSessionRequest): Promise<DriverSession>;
}

export interface DriverSession {
  readonly claudeResumeId: string | undefined;
  events(): AsyncIterable<DriverEvent>;
  sendPrompt(prompt: string): Promise<void>;
  resolvePermission(
    requestId: string,
    decision: 'approve' | 'deny',
  ): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}
