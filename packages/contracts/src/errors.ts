import { z } from 'zod';

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
  'developer_capability_invalid',
  'developer_cycle_invalid',
  'developer_report_invalid',
]);

export type StableTaskErrorCode = z.infer<typeof stableTaskErrorCodeSchema>;
