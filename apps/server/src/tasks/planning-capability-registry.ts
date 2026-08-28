import { randomBytes } from 'node:crypto';

import {
  projectPlanProposalInputSchema,
  type ProjectPlanProposalInput,
} from '@mesh-session-platform/contracts';

export type PlanningCapabilityBinding = {
  planId: string;
  planRevision: number;
  sessionId: string;
  baseId: string;
  policyVersion: string;
  generation: number;
  expiresAt: string;
};

export type PlanningCapabilityContext = Omit<
  PlanningCapabilityBinding,
  'expiresAt'
>;

export type PlanningCapabilityToken = string;

export type PlanningCapabilityErrorCode =
  | 'planning_capability_invalid'
  | 'planning_capability_mismatch'
  | 'planning_capability_expired'
  | 'planning_capability_in_use'
  | 'planning_proposal_invalid';

export type PlanningProposalProblem = {
  code: string;
  path: readonly PropertyKey[];
  message: string;
};

export class PlanningCapabilityError extends Error {
  constructor(
    readonly code: PlanningCapabilityErrorCode,
    message: string,
    readonly problems?: readonly PlanningProposalProblem[],
  ) {
    super(message);
    this.name = 'PlanningCapabilityError';
  }
}

type CapabilityEntry = {
  binding: PlanningCapabilityBinding;
  accepting: boolean;
};

export type PlanningCapabilitySubmission<T> = {
  token: PlanningCapabilityToken;
  context: PlanningCapabilityContext;
  proposal: unknown;
  accept(
    proposal: ProjectPlanProposalInput,
    binding: PlanningCapabilityBinding,
  ): Promise<T>;
};

export class PlanningCapabilityRegistry {
  private readonly entries = new Map<
    PlanningCapabilityToken,
    CapabilityEntry
  >();
  private readonly tokensByPlan = new Map<
    string,
    Set<PlanningCapabilityToken>
  >();
  private readonly tokensBySession = new Map<
    string,
    Set<PlanningCapabilityToken>
  >();
  private readonly issuedGenerationTombstones = new Set<string>();
  private readonly now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  issue(binding: PlanningCapabilityBinding): PlanningCapabilityToken {
    const expiresAt = Date.parse(binding.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      throw new Error('Planning capability expiry must be an ISO timestamp.');
    }
    if (expiresAt <= this.now().getTime()) {
      throw new PlanningCapabilityError(
        'planning_capability_expired',
        'Planning capability expiry must be in the future.',
      );
    }

    this.cleanupExpired();

    const generationKey = this.generationKey(binding);
    if (this.issuedGenerationTombstones.has(generationKey)) {
      throw new PlanningCapabilityError(
        'planning_capability_in_use',
        'Planning capability generation has already been issued.',
      );
    }

    let token: PlanningCapabilityToken;
    do {
      token = randomBytes(32).toString('base64url');
    } while (this.entries.has(token));

    this.entries.set(token, { binding: { ...binding }, accepting: false });
    this.addIndex(this.tokensByPlan, binding.planId, token);
    this.addIndex(this.tokensBySession, binding.sessionId, token);
    this.issuedGenerationTombstones.add(generationKey);
    return token;
  }

  async submit<T>(submission: PlanningCapabilitySubmission<T>): Promise<T> {
    const entry = this.entries.get(submission.token);
    if (!entry) {
      throw new PlanningCapabilityError(
        'planning_capability_invalid',
        'Planning capability is invalid.',
      );
    }
    if (entry.accepting) {
      throw new PlanningCapabilityError(
        'planning_capability_in_use',
        'Planning capability already has a submission in progress.',
      );
    }

    this.assertContext(entry.binding, submission.context);
    if (Date.parse(entry.binding.expiresAt) <= this.now().getTime()) {
      this.remove(submission.token);
      throw new PlanningCapabilityError(
        'planning_capability_expired',
        'Planning capability has expired.',
      );
    }

    const parsed = projectPlanProposalInputSchema.safeParse(
      submission.proposal,
    );
    if (!parsed.success) {
      throw new PlanningCapabilityError(
        'planning_proposal_invalid',
        'Planning proposal is invalid.',
        parsed.error.issues.map((issue) => ({
          code: issue.code,
          path: [...issue.path],
          message: issue.message,
        })),
      );
    }

    entry.accepting = true;
    try {
      const result = await submission.accept(parsed.data, {
        ...entry.binding,
      });
      this.remove(submission.token);
      return result;
    } catch (error) {
      const current = this.entries.get(submission.token);
      if (current === entry) current.accepting = false;
      throw error;
    }
  }

  invalidate(token: PlanningCapabilityToken): void {
    this.remove(token);
  }

  invalidatePlan(planId: string): void {
    this.invalidateIndexed(this.tokensByPlan, planId);
  }

  invalidateSession(sessionId: string): void {
    this.invalidateIndexed(this.tokensBySession, sessionId);
  }

  clear(): void {
    this.entries.clear();
    this.tokensByPlan.clear();
    this.tokensBySession.clear();
    this.issuedGenerationTombstones.clear();
  }

  private assertContext(
    binding: PlanningCapabilityBinding,
    context: PlanningCapabilityContext,
  ): void {
    if (
      binding.planId !== context.planId ||
      binding.planRevision !== context.planRevision ||
      binding.sessionId !== context.sessionId ||
      binding.baseId !== context.baseId ||
      binding.policyVersion !== context.policyVersion ||
      binding.generation !== context.generation
    ) {
      throw new PlanningCapabilityError(
        'planning_capability_mismatch',
        'Planning capability does not match the active planning context.',
      );
    }
  }

  private generationKey(binding: PlanningCapabilityContext): string {
    return JSON.stringify([binding.planId, binding.generation]);
  }

  private cleanupExpired(): void {
    const now = this.now().getTime();
    for (const [token, entry] of this.entries) {
      if (Date.parse(entry.binding.expiresAt) <= now) this.remove(token);
    }
  }

  private addIndex(
    index: Map<string, Set<PlanningCapabilityToken>>,
    key: string,
    token: PlanningCapabilityToken,
  ): void {
    let tokens = index.get(key);
    if (!tokens) {
      tokens = new Set();
      index.set(key, tokens);
    }
    tokens.add(token);
  }

  private invalidateIndexed(
    index: Map<string, Set<PlanningCapabilityToken>>,
    key: string,
  ): void {
    const tokens = index.get(key);
    if (!tokens) return;
    for (const token of [...tokens]) this.remove(token);
  }

  private remove(token: PlanningCapabilityToken): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    this.entries.delete(token);
    this.removeFromIndex(this.tokensByPlan, entry.binding.planId, token);
    this.removeFromIndex(this.tokensBySession, entry.binding.sessionId, token);
  }

  private removeFromIndex(
    index: Map<string, Set<PlanningCapabilityToken>>,
    key: string,
    token: PlanningCapabilityToken,
  ): void {
    const tokens = index.get(key);
    if (!tokens) return;
    tokens.delete(token);
    if (tokens.size === 0) index.delete(key);
  }
}
