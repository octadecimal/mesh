import type { LifecycleState } from '@mesh-session-platform/contracts';

export type LifecycleTrigger =
  | { type: 'start' }
  | { type: 'resume' }
  | { type: 'driver_started' }
  | { type: 'permission_requested' }
  | { type: 'permission_resolved' }
  | { type: 'interrupt' }
  | { type: 'driver_stopped' }
  | { type: 'driver_completed' }
  | { type: 'driver_failed' }
  | { type: 'driver_crashed' }
  | { type: 'subscription_limited' }
  | { type: 'recover' }
  | { type: 'archive' };

export class InvalidSessionStateError extends Error {
  readonly code = 'invalid_session_state';

  constructor(
    readonly from: LifecycleState,
    readonly trigger: LifecycleTrigger['type'],
  ) {
    super(`Cannot apply ${trigger} while session is ${from}`);
  }
}

const invalid = (from: LifecycleState, trigger: LifecycleTrigger): never => {
  throw new InvalidSessionStateError(from, trigger.type);
};

export const transition = (
  current: LifecycleState,
  input: LifecycleTrigger | LifecycleTrigger['type'],
): LifecycleState => {
  const trigger: LifecycleTrigger =
    typeof input === 'string' ? { type: input } : input;
  switch (trigger.type) {
    case 'start':
      return current === 'idle' ? 'starting' : invalid(current, trigger);
    case 'resume':
      return current === 'interrupted' ||
        current === 'failed' ||
        current === 'completed'
        ? 'starting'
        : invalid(current, trigger);
    case 'driver_started':
      return current === 'starting' ? 'running' : invalid(current, trigger);
    case 'permission_requested':
      return current === 'running'
        ? 'waiting_for_approval'
        : invalid(current, trigger);
    case 'permission_resolved':
      return current === 'waiting_for_approval'
        ? 'running'
        : invalid(current, trigger);
    case 'interrupt':
      return current === 'starting' ||
        current === 'running' ||
        current === 'waiting_for_approval'
        ? 'interrupting'
        : invalid(current, trigger);
    case 'driver_stopped':
      return current === 'interrupting'
        ? 'interrupted'
        : invalid(current, trigger);
    case 'driver_completed':
      return current === 'running' || current === 'waiting_for_approval'
        ? 'completed'
        : invalid(current, trigger);
    case 'driver_failed':
      return current === 'starting' ||
        current === 'running' ||
        current === 'waiting_for_approval'
        ? 'failed'
        : invalid(current, trigger);
    case 'driver_crashed':
    case 'recover':
      return current === 'starting' ||
        current === 'running' ||
        current === 'waiting_for_approval' ||
        current === 'interrupting'
        ? 'interrupted'
        : invalid(current, trigger);
    case 'subscription_limited':
      return current === 'starting' ||
        current === 'running' ||
        current === 'waiting_for_approval'
        ? 'failed'
        : invalid(current, trigger);
    case 'archive':
      return current === 'completed' ||
        current === 'failed' ||
        current === 'interrupted'
        ? 'archived'
        : invalid(current, trigger);
    default: {
      const exhaustive: never = trigger;
      return exhaustive;
    }
  }
};
