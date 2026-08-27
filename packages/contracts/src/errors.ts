import { z } from 'zod';

export const qaErrorCodeSchema = z.enum([
  'qa_capability_invalid',
  'qa_report_incomplete',
  'qa_already_active',
  'review_automation_paused',
  'qa_rejection_ceiling_reached',
  'unsafe_qa_workspace',
  'developer_resume_unavailable',
]);

export type QaErrorCode = z.infer<typeof qaErrorCodeSchema>;

export const stableTaskErrorCodeSchema = z.enum([
  'project_not_found',
  'project_archived',
  'repository_invalid',
  'repository_ambiguous',
  'repository_already_imported',
  'task_not_found',
  'task_revision_conflict',
  'task_not_ready',
  'task_blocked',
  'task_transition_invalid',
  'task_transition_unauthorized',
  'session_already_linked',
  'session_repository_mismatch',
  'attempt_start_failed',
  'attempt_reconciliation_required',
  'project_revision_conflict',
  'project_run_not_found',
  'project_run_revision_conflict',
  'project_run_invalid',
  'project_run_transition_invalid',
  'project_run_conflict',
  'project_run_empty',
  'project_run_stale',
  'project_run_concurrency_exceeded',
  'project_run_not_controllable',
  'project_plan_not_found',
  'project_plan_revision_conflict',
  'project_plan_lifecycle_invalid',
  'project_plan_stale',
  'project_plan_proposal_invalid',
  'project_plan_proposal_limit_exceeded',
  'project_plan_unauthorized',
  'project_plan_billing_conflict',
  'project_plan_repair_required',
  'task_dependency_cycle',
  'task_dependency_conflict',
  'task_dependency_invalid',
  'developer_capability_invalid',
  'developer_cycle_invalid',
  'developer_report_invalid',
  ...qaErrorCodeSchema.options,
]);

export type StableTaskErrorCode = z.infer<typeof stableTaskErrorCodeSchema>;

export class QaContractError extends Error {
  constructor(
    public readonly code: QaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class QaCapabilityInvalidError extends QaContractError {
  constructor(message = 'The QA capability is invalid.') {
    super('qa_capability_invalid', message);
  }
}
export class QaReportIncompleteError extends QaContractError {
  constructor(message = 'The QA report is incomplete.') {
    super('qa_report_incomplete', message);
  }
}
export class QaAlreadyActiveError extends QaContractError {
  constructor(message = 'QA is already active for this task.') {
    super('qa_already_active', message);
  }
}
export class ReviewAutomationPausedError extends QaContractError {
  constructor(message = 'Review automation is paused for this task.') {
    super('review_automation_paused', message);
  }
}
export class QaRejectionCeilingReachedError extends QaContractError {
  constructor(
    message = 'The autonomous QA rejection ceiling has been reached.',
  ) {
    super('qa_rejection_ceiling_reached', message);
  }
}
export class UnsafeQaWorkspaceError extends QaContractError {
  constructor(message = 'The QA workspace is unsafe.') {
    super('unsafe_qa_workspace', message);
  }
}
export class DeveloperResumeUnavailableError extends QaContractError {
  constructor(message = 'The Developer session cannot be resumed.') {
    super('developer_resume_unavailable', message);
  }
}
