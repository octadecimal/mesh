import type { PermissionMode } from '@mesh-session-platform/contracts';

export interface PermissionDecisionRequest {
  toolName: string;
  input: unknown;
}

export type PermissionDecision = { action: 'approve' | 'prompt' | 'delegate' };

export interface PermissionPolicy {
  decide(request: PermissionDecisionRequest): PermissionDecision;
}

const hasString = (input: unknown, key: string): boolean => {
  const value =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)[key]
      : undefined;
  return typeof value === 'string' && value.trim().length > 0;
};

const isSafeReadOnlyRequest = ({
  toolName,
  input,
}: PermissionDecisionRequest): boolean =>
  (toolName === 'Read' && hasString(input, 'path')) ||
  (toolName === 'Glob' && hasString(input, 'pattern')) ||
  (toolName === 'Grep' && hasString(input, 'pattern'));

export const permissionPolicy = (mode: PermissionMode): PermissionPolicy => ({
  decide: (request) => {
    if (mode === 'interactive') return { action: 'prompt' };
    if (mode === 'inherit') return { action: 'delegate' };
    return isSafeReadOnlyRequest(request)
      ? { action: 'approve' }
      : { action: 'prompt' };
  },
});
