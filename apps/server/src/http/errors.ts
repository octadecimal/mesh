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
  | 'project_plan_not_found'
  | 'project_plan_revision_conflict'
  | 'project_plan_lifecycle_invalid'
  | 'project_plan_stale'
  | 'project_plan_proposal_invalid'
  | 'project_plan_proposal_limit_exceeded'
  | 'project_plan_unauthorized'
  | 'project_plan_billing_conflict'
  | 'project_plan_repair_required'
  | 'project_run_not_found'
  | 'project_run_revision_conflict'
  | 'project_run_invalid'
  | 'project_run_transition_invalid'
  | 'project_run_conflict'
  | 'project_run_empty'
  | 'project_run_stale'
  | 'project_run_concurrency_exceeded'
  | 'project_run_not_controllable'
  | 'task_revision_conflict'
  | 'task_dependency_cycle'
  | 'task_dependency_conflict'
  | 'task_dependency_invalid'
  | 'task_not_found'
  | 'task_not_ready'
  | 'task_blocked'
  | 'task_transition_invalid'
  | 'task_transition_unauthorized'
  | 'developer_capability_invalid'
  | 'developer_cycle_invalid'
  | 'developer_report_invalid'
  | 'qa_capability_invalid'
  | 'qa_report_incomplete'
  | 'qa_already_active'
  | 'review_automation_paused'
  | 'qa_rejection_ceiling_reached'
  | 'qa_verification_executable_unavailable'
  | 'unsafe_qa_workspace'
  | 'developer_resume_unavailable'
  | 'session_already_linked'
  | 'session_repository_mismatch'
  | 'attempt_start_failed'
  | 'attempt_reconciliation_required'
  | 'command_reconciliation_required'
  | 'directory_picker_unavailable'
  | 'directory_picker_busy'
  | 'directory_picker_invalid_path'
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
  project_plan_not_found: 404,
  project_plan_revision_conflict: 409,
  project_plan_lifecycle_invalid: 409,
  project_plan_stale: 409,
  project_plan_proposal_invalid: 422,
  project_plan_proposal_limit_exceeded: 422,
  project_plan_unauthorized: 403,
  project_plan_billing_conflict: 409,
  project_plan_repair_required: 409,
  project_run_not_found: 404,
  project_run_revision_conflict: 409,
  project_run_invalid: 400,
  project_run_transition_invalid: 409,
  project_run_conflict: 409,
  project_run_empty: 422,
  project_run_stale: 409,
  project_run_concurrency_exceeded: 422,
  project_run_not_controllable: 409,
  task_revision_conflict: 409,
  task_dependency_cycle: 409,
  task_dependency_conflict: 409,
  task_dependency_invalid: 422,
  task_not_found: 404,
  session_already_linked: 409,
  session_repository_mismatch: 409,
  attempt_start_failed: 409,
  attempt_reconciliation_required: 409,
  task_not_ready: 422,
  task_blocked: 409,
  task_transition_invalid: 409,
  task_transition_unauthorized: 403,
  developer_capability_invalid: 403,
  developer_cycle_invalid: 409,
  developer_report_invalid: 422,
  qa_capability_invalid: 403,
  qa_report_incomplete: 422,
  qa_already_active: 409,
  review_automation_paused: 409,
  qa_rejection_ceiling_reached: 409,
  qa_verification_executable_unavailable: 503,
  unsafe_qa_workspace: 409,
  developer_resume_unavailable: 409,
  command_reconciliation_required: 409,
  directory_picker_unavailable: 503,
  directory_picker_busy: 409,
  directory_picker_invalid_path: 400,
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
      message =
        error instanceof Error
          ? error.message
          : 'message' in error && typeof error.message === 'string'
            ? error.message
            : candidate;
      if ('details' in error && error.details !== undefined)
        details = error.details;
      else if ('task' in error && error.task !== undefined)
        details = { task: error.task };
      else if ('project' in error && error.project !== undefined)
        details = { project: error.project };
      else if ('sessionId' in error && error.sessionId !== undefined)
        details = { sessionId: error.sessionId };
    }
  }

  return {
    statusCode: statusCodes[code],
    body: {
      error: { code, message, ...(details === undefined ? {} : { details }) },
    },
  };
};
