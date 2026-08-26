import { ZodError } from 'zod';

export type StableErrorCode =
  | 'invalid_command'
  | 'invalid_session_state'
  | 'billing_configuration_conflict'
  | 'unsupported_claude_capability'
  | 'audit_unavailable'
  | 'workspace_preserved'
  | 'session_not_found'
  | 'workspace_not_found'
  | 'project_not_found'
  | 'project_archived'
  | 'project_has_running_attempt'
  | 'repository_invalid'
  | 'repository_ambiguous'
  | 'repository_already_imported'
  | 'project_revision_conflict'
  | 'task_revision_conflict'
  | 'task_not_found'
  | 'task_not_ready'
  | 'task_blocked'
  | 'task_transition_invalid'
  | 'task_transition_unauthorized'
  | 'session_already_linked'
  | 'session_repository_mismatch'
  | 'attempt_start_failed'
  | 'attempt_reconciliation_required'
  | 'command_reconciliation_required'
  | 'internal_error';

export class CommandError extends Error {
  constructor(
    readonly code: StableErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

export interface HttpError {
  statusCode: number;
  body: {
    error: {
      code: StableErrorCode;
      message: string;
      details?: unknown;
    };
  };
}

const statusCodes: Record<StableErrorCode, number> = {
  invalid_command: 400,
  invalid_session_state: 409,
  billing_configuration_conflict: 409,
  unsupported_claude_capability: 422,
  audit_unavailable: 503,
  workspace_preserved: 409,
  session_not_found: 404,
  workspace_not_found: 404,
  project_not_found: 404,
  project_archived: 409,
  project_has_running_attempt: 409,
  repository_invalid: 400,
  repository_ambiguous: 400,
  repository_already_imported: 409,
  project_revision_conflict: 409,
  task_revision_conflict: 409,
  task_not_found: 404,
  session_already_linked: 409,
  session_repository_mismatch: 409,
  attempt_start_failed: 409,
  attempt_reconciliation_required: 409,
  task_not_ready: 422,
  task_blocked: 409,
  task_transition_invalid: 409,
  task_transition_unauthorized: 403,
  command_reconciliation_required: 409,
  internal_error: 500,
};

const stableCodes = new Set<StableErrorCode>(
  Object.keys(statusCodes) as StableErrorCode[],
);

export const toHttpError = (error: unknown): HttpError => {
  let code: StableErrorCode = 'internal_error';
  let message = 'Internal server error';
  let details: unknown;

  if (error instanceof ZodError) {
    code = 'invalid_command';
    message = 'Command or query did not match the v1 contract';
    details = error.issues;
  } else if (error instanceof CommandError) {
    ({ code, message, details } = error);
  } else if (error && typeof error === 'object' && 'code' in error) {
    const candidate = String(error.code) as StableErrorCode;
    if (stableCodes.has(candidate)) {
      code = candidate;
      message = error instanceof Error ? error.message : candidate;
      details = error;
    }
  }

  return {
    statusCode: statusCodes[code],
    body: {
      error: { code, message, ...(details === undefined ? {} : { details }) },
    },
  };
};
