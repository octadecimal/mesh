import type { V2ProjectSnapshot, V2SystemSnapshot } from '@mesh/v2-contracts';

export type MutationAvailability =
  | { enabled: true }
  | { enabled: false; disabledReason: string };

export type SelectorViewModel =
  | { status: 'loading' }
  | { status: 'disconnected'; message: string }
  | {
      status: 'ready';
      snapshot: V2SystemSnapshot;
      submitting: boolean;
      registration: MutationAvailability;
    }
  | { status: 'error'; snapshot?: V2SystemSnapshot; message: string };

export type ProjectShellViewModel =
  | { status: 'loading'; projectId: string }
  | { status: 'stale'; snapshot: V2ProjectSnapshot; message: string }
  | { status: 'disconnected'; snapshot?: V2ProjectSnapshot; message: string }
  | {
      status: 'ready';
      snapshot: V2ProjectSnapshot;
      interrupt: MutationAvailability;
    };
