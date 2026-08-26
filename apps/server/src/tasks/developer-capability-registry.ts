import { randomBytes } from 'node:crypto';

import type { TaskActor } from '@mesh-session-platform/contracts';

export type DeveloperCapabilityBinding = {
  sessionId: string;
  attemptId: string;
  taskId: string;
  cycleId: string;
  agentActor: TaskActor;
};

export type DeveloperCapabilityToken = string;

export class DeveloperCapabilityInvalidError extends Error {
  readonly code = 'developer_capability_invalid';

  constructor() {
    super('Developer capability is invalid or expired.');
    this.name = 'DeveloperCapabilityInvalidError';
  }
}

export class DeveloperCapabilityRegistry {
  private readonly bindings = new Map<
    DeveloperCapabilityToken,
    DeveloperCapabilityBinding
  >();
  private readonly tokensByCycle = new Map<string, Set<DeveloperCapabilityToken>>();
  private readonly tokensBySession = new Map<
    string,
    Set<DeveloperCapabilityToken>
  >();

  issue(binding: DeveloperCapabilityBinding): DeveloperCapabilityToken {
    let token: DeveloperCapabilityToken;
    do {
      token = randomBytes(32).toString('base64url');
    } while (this.bindings.has(token));

    const storedBinding: DeveloperCapabilityBinding = {
      ...binding,
      agentActor: { ...binding.agentActor },
    };
    this.bindings.set(token, storedBinding);
    this.addIndex(this.tokensByCycle, binding.cycleId, token);
    this.addIndex(this.tokensBySession, binding.sessionId, token);
    return token;
  }

  resolve(token: DeveloperCapabilityToken): DeveloperCapabilityBinding {
    const binding = this.bindings.get(token);
    if (!binding) throw new DeveloperCapabilityInvalidError();

    return {
      ...binding,
      agentActor: { ...binding.agentActor },
    };
  }

  invalidateCycle(cycleId: string): void {
    this.invalidateIndexed(this.tokensByCycle, cycleId);
  }

  invalidateSession(sessionId: string): void {
    this.invalidateIndexed(this.tokensBySession, sessionId);
  }

  clear(): void {
    this.bindings.clear();
    this.tokensByCycle.clear();
    this.tokensBySession.clear();
  }

  private addIndex(
    index: Map<string, Set<DeveloperCapabilityToken>>,
    key: string,
    token: DeveloperCapabilityToken,
  ): void {
    let tokens = index.get(key);
    if (!tokens) {
      tokens = new Set();
      index.set(key, tokens);
    }
    tokens.add(token);
  }

  private invalidateIndexed(
    index: Map<string, Set<DeveloperCapabilityToken>>,
    key: string,
  ): void {
    const tokens = index.get(key);
    if (!tokens) return;

    for (const token of tokens) this.remove(token);
    index.delete(key);
  }

  private remove(token: DeveloperCapabilityToken): void {
    const binding = this.bindings.get(token);
    if (!binding) return;

    this.bindings.delete(token);
    this.removeFromIndex(this.tokensByCycle, binding.cycleId, token);
    this.removeFromIndex(this.tokensBySession, binding.sessionId, token);
  }

  private removeFromIndex(
    index: Map<string, Set<DeveloperCapabilityToken>>,
    key: string,
    token: DeveloperCapabilityToken,
  ): void {
    const tokens = index.get(key);
    if (!tokens) return;
    tokens.delete(token);
    if (tokens.size === 0) index.delete(key);
  }
}
