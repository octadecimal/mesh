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
