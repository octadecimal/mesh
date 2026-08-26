import { randomBytes } from 'node:crypto';

import { QaCapabilityInvalidError } from '@mesh-session-platform/contracts';

export type QaCapabilityBinding = {
  sessionId: string;
  taskId: string;
  attemptId: string;
  cycleId: string;
};

export type QaCapabilityToken = string;

export class QaCapabilityRegistry {
  private readonly bindings = new Map<QaCapabilityToken, QaCapabilityBinding>();
  private readonly tokensBySession = new Map<string, Set<QaCapabilityToken>>();

  issue(binding: QaCapabilityBinding): QaCapabilityToken {
    let token: QaCapabilityToken;
    do {
      token = randomBytes(32).toString('base64url');
    } while (this.bindings.has(token));

    this.bindings.set(token, { ...binding });
    this.addToSession(binding.sessionId, token);
    return token;
  }

  resolve(token: QaCapabilityToken): QaCapabilityBinding {
    const binding = this.bindings.get(token);
    if (!binding) throw new QaCapabilityInvalidError();

    return { ...binding };
  }

  invalidate(token: QaCapabilityToken): void {
    const binding = this.bindings.get(token);
    if (!binding) return;

    this.bindings.delete(token);
    const sessionTokens = this.tokensBySession.get(binding.sessionId);
    if (!sessionTokens) return;

    sessionTokens.delete(token);
    if (sessionTokens.size === 0)
      this.tokensBySession.delete(binding.sessionId);
  }

  invalidateSession(sessionId: string): void {
    const tokens = this.tokensBySession.get(sessionId);
    if (!tokens) return;

    for (const token of [...tokens]) this.invalidate(token);
  }

  clear(): void {
    this.bindings.clear();
    this.tokensBySession.clear();
  }

  private addToSession(sessionId: string, token: QaCapabilityToken): void {
    let tokens = this.tokensBySession.get(sessionId);
    if (!tokens) {
      tokens = new Set();
      this.tokensBySession.set(sessionId, tokens);
    }
    tokens.add(token);
  }
}
