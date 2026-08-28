import { Buffer } from 'node:buffer';

import {
  harnessCapabilitiesSchema,
  harnessEventEnvelopeSchema,
  harnessResumeRequestSchema,
  harnessStartRequestSchema,
  type HarnessAdapter,
  type HarnessEventEnvelope,
  type HarnessOperationResult,
  type HarnessProbeResult,
  type HarnessResumeRequest,
  type HarnessSession,
  type HarnessStartRequest,
  type LogicalSkillRequest,
} from '@mesh/v2-contracts';

import { canonicalJson } from '../storage/canonical-json.js';
import { matchingSkill } from './harness-adapter.js';

const MAX_HANDLE_BYTES = 4096;
const SCENARIO = 'todo-foundation-v1' as const;

type FakeHandle = {
  executionId: string;
  scenario: typeof SCENARIO;
  checkpointCursor: number;
};

export type FakeHarnessOptions = {
  holdAfterAdapterCursor?: number;
  malformedAtAdapterCursor?: number;
  failAtAdapterCursor?: number;
  available?: boolean;
  interruptThrows?: boolean;
};

const encodeHandle = (value: FakeHandle): string => {
  const encoded = Buffer.from(canonicalJson(value), 'utf8').toString(
    'base64url',
  );
  if (encoded.length > MAX_HANDLE_BYTES)
    throw new Error('Fake handle is oversized');
  return `fake:v1:${encoded}`;
};

const decodeHandle = (
  nativeHandle: string,
):
  | { ok: true; value: FakeHandle }
  | { ok: false; status: 'missing' | 'unknown'; reason: string } => {
  if (nativeHandle.length > MAX_HANDLE_BYTES) {
    return { ok: false, status: 'missing', reason: 'Fake handle is oversized' };
  }
  const parts = nativeHandle.split(':');
  if (parts.length !== 3 || parts[0] !== 'fake') {
    return { ok: false, status: 'missing', reason: 'Fake handle is malformed' };
  }
  if (parts[1] !== 'v1') {
    return {
      ok: false,
      status: 'unknown',
      reason: 'Fake handle version is unknown',
    };
  }
  const encodedPayload = parts[2];
  if (encodedPayload === undefined || encodedPayload.length === 0) {
    return {
      ok: false,
      status: 'missing',
      reason: 'Fake handle payload is missing',
    };
  }
  try {
    const decoded = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    if (Buffer.byteLength(decoded, 'utf8') > MAX_HANDLE_BYTES) {
      return {
        ok: false,
        status: 'missing',
        reason: 'Fake handle payload is oversized',
      };
    }
    const value = JSON.parse(decoded) as Partial<FakeHandle>;
    if (
      typeof value.executionId !== 'string' ||
      value.executionId.length === 0 ||
      value.scenario !== SCENARIO ||
      !Number.isInteger(value.checkpointCursor) ||
      (value.checkpointCursor as number) < 0 ||
      (value.checkpointCursor as number) > 6 ||
      canonicalJson(value) !== decoded
    ) {
      return {
        ok: false,
        status: 'missing',
        reason: 'Fake handle payload is invalid',
      };
    }
    return { ok: true, value: value as FakeHandle };
  } catch {
    return {
      ok: false,
      status: 'missing',
      reason: 'Fake handle payload is malformed',
    };
  }
};

const scriptEnvelope = (
  request: HarnessStartRequest,
  adapterCursor: number,
): HarnessEventEnvelope => {
  const base = {
    projectId: request.project.id,
    executionId: request.executionId,
    adapterCursor,
    occurredAt: new Date(
      Date.UTC(2026, 7, 28, 0, 0, adapterCursor),
    ).toISOString(),
  };
  const normalized =
    adapterCursor === 1
      ? {
          ...base,
          type: 'worker_execution.output' as const,
          payload: { text: 'Inspecting Todo repository.' },
        }
      : adapterCursor === 2
        ? {
            ...base,
            type: 'worker_execution.child_started' as const,
            payload: { childId: 'todo-check', title: 'Todo check' },
          }
        : adapterCursor === 3
          ? {
              ...base,
              type: 'worker_execution.output' as const,
              payload: { text: 'Found deterministic Todo item.' },
            }
          : adapterCursor === 4
            ? {
                ...base,
                type: 'worker_execution.child_finished' as const,
                payload: {
                  childId: 'todo-check',
                  outcome: 'completed' as const,
                },
              }
            : adapterCursor === 5
              ? {
                  ...base,
                  type: 'worker_execution.output' as const,
                  payload: { text: 'Foundation check complete.' },
                }
              : {
                  ...base,
                  type: 'worker_execution.completed' as const,
                  payload: { outcome: 'completed' as const },
                };
  return harnessEventEnvelopeSchema.parse({
    adapterCursor,
    raw: { source: 'fake', scenario: SCENARIO, adapterCursor },
    normalized,
  });
};

class FakeHarnessSession implements HarnessSession {
  readonly consumedAdapterCursors: number[] = [];
  closeCount = 0;
  private closed = false;
  private checkpointCursor: number;

  constructor(
    private readonly request: HarnessStartRequest,
    checkpointCursor: number,
    private readonly options: FakeHarnessOptions,
  ) {
    this.checkpointCursor = checkpointCursor;
  }

  get nativeHandle(): string {
    return encodeHandle({
      executionId: this.request.executionId,
      scenario: SCENARIO,
      checkpointCursor: this.checkpointCursor,
    });
  }

  async *events(
    afterAdapterCursor: number,
  ): AsyncIterable<HarnessEventEnvelope> {
    if (afterAdapterCursor !== this.checkpointCursor) {
      throw new Error(
        'Fake session checkpoint does not match requested cursor',
      );
    }
    for (let cursor = afterAdapterCursor + 1; cursor <= 6; cursor += 1) {
      if (this.closed) return;
      this.consumedAdapterCursors.push(cursor);
      if (this.options.failAtAdapterCursor === cursor) {
        throw new Error(`fake adapter failure at cursor ${cursor}`);
      }
      const envelope = scriptEnvelope(this.request, cursor);
      this.checkpointCursor = cursor;
      if (this.options.malformedAtAdapterCursor === cursor) {
        yield {
          ...envelope,
          normalized: { ...envelope.normalized, adapterCursor: cursor + 1 },
        } as HarnessEventEnvelope;
        return;
      }
      yield envelope;
      if (this.options.holdAfterAdapterCursor === cursor) return;
    }
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.closed = true;
  }
}

export class FakeHarnessAdapter implements HarnessAdapter {
  readonly id = 'fake';
  readonly sessions: FakeHarnessSession[] = [];
  readonly interruptCalls: string[] = [];
  startCount = 0;
  resumeCount = 0;
  resolveSkillsCount = 0;
  capabilitiesCount = 0;
  capabilitiesValue = harnessCapabilitiesSchema.parse({
    adapterId: 'fake',
    capabilities: ['execution.stream', 'execution.interrupt'],
    skills: [
      {
        logicalId: 'mesh.foundation-check',
        nativeId: 'fake.foundation-check',
        version: '1.9.0',
        digest: 'f'.repeat(64),
      },
    ],
    exactResume: true,
  });
  private readonly interruptedExecutions = new Set<string>();
  private capabilitiesBlocked = false;
  private capabilitiesReleaseResolve: (() => void) | undefined;
  private capabilitiesRelease = Promise.resolve();
  private readonly capabilitiesWaiters: Array<{
    count: number;
    resolve: () => void;
  }> = [];
  private startBlocked = false;
  private startCalledResolve: (() => void) | undefined;
  private readonly startCalled = new Promise<void>((resolve) => {
    this.startCalledResolve = resolve;
  });
  private startReleaseResolve: (() => void) | undefined;
  private startRelease = Promise.resolve();
  private interruptBlocked = false;
  private interruptCalledResolve: (() => void) | undefined;
  private readonly interruptCalled = new Promise<void>((resolve) => {
    this.interruptCalledResolve = resolve;
  });
  private interruptReleaseResolve:
    | ((result: HarnessOperationResult) => void)
    | undefined;
  private interruptRelease: Promise<HarnessOperationResult> | undefined;

  constructor(private readonly options: FakeHarnessOptions = {}) {}

  get consumedAdapterCursors(): readonly number[] {
    return this.sessions.flatMap((session) => session.consumedAdapterCursors);
  }

  async capabilities() {
    this.capabilitiesCount += 1;
    for (const waiter of this.capabilitiesWaiters) {
      if (this.capabilitiesCount >= waiter.count) waiter.resolve();
    }
    if (this.capabilitiesBlocked) await this.capabilitiesRelease;
    if (this.options.available === false)
      throw new Error('Fake adapter unavailable');
    return this.capabilitiesValue;
  }

  async resolveSkills(requests: readonly LogicalSkillRequest[]) {
    this.resolveSkillsCount += 1;
    return requests.flatMap((request) => {
      const descriptor = matchingSkill(request, this.capabilitiesValue.skills);
      return descriptor ? [descriptor] : [];
    });
  }

  async start(input: HarnessStartRequest): Promise<FakeHarnessSession> {
    const request = harnessStartRequestSchema.parse(input);
    this.startCount += 1;
    this.startCalledResolve?.();
    if (this.startBlocked) await this.startRelease;
    const session = new FakeHarnessSession(request, 0, this.options);
    this.sessions.push(session);
    return session;
  }

  async probe(nativeHandle: string): Promise<HarnessProbeResult> {
    const parsed = decodeHandle(nativeHandle);
    if (!parsed.ok) return { status: parsed.status, reason: parsed.reason };
    if (this.interruptedExecutions.has(parsed.value.executionId)) {
      return { status: 'terminal', outcome: 'interrupted' };
    }
    if (parsed.value.checkpointCursor === 6) {
      return { status: 'terminal', outcome: 'completed' };
    }
    return {
      status: 'resumable',
      afterAdapterCursor: parsed.value.checkpointCursor,
    };
  }

  async resume(input: HarnessResumeRequest): Promise<FakeHarnessSession> {
    const request = harnessResumeRequestSchema.parse(input);
    const parsed = decodeHandle(request.nativeHandle);
    if (!parsed.ok) throw new Error(parsed.reason);
    if (parsed.value.executionId !== request.executionId) {
      throw new Error('Fake handle execution does not match resume request');
    }
    if (parsed.value.scenario !== request.assignment.fakeScenario) {
      throw new Error('Fake handle scenario does not match resume request');
    }
    if (parsed.value.checkpointCursor !== request.afterAdapterCursor) {
      throw new Error('Fake handle checkpoint does not match resume cursor');
    }
    this.resumeCount += 1;
    const session = new FakeHarnessSession(
      request,
      request.afterAdapterCursor,
      this.options,
    );
    this.sessions.push(session);
    return session;
  }

  async interrupt(nativeHandle: string): Promise<HarnessOperationResult> {
    this.interruptCalls.push(nativeHandle);
    this.interruptCalledResolve?.();
    if (this.interruptBlocked) {
      if (!this.interruptRelease)
        throw new Error('Fake interrupt gate is missing');
      return this.interruptRelease;
    }
    if (this.options.interruptThrows) throw new Error('fake interrupt failure');
    const parsed = decodeHandle(nativeHandle);
    if (!parsed.ok) return { status: 'unknown', reason: parsed.reason };
    if (this.interruptedExecutions.has(parsed.value.executionId)) {
      return { status: 'already_terminal' };
    }
    this.interruptedExecutions.add(parsed.value.executionId);
    return { status: 'succeeded' };
  }

  blockStart(): void {
    this.startBlocked = true;
    this.startRelease = new Promise<void>((resolve) => {
      this.startReleaseResolve = resolve;
    });
  }

  waitUntilStartCalled(): Promise<void> {
    return this.startCalled;
  }

  releaseStart(): void {
    this.startBlocked = false;
    this.startReleaseResolve?.();
  }

  blockInterrupt(): void {
    this.interruptBlocked = true;
    this.interruptRelease = new Promise<HarnessOperationResult>((resolve) => {
      this.interruptReleaseResolve = resolve;
    });
  }

  waitUntilInterruptCalled(): Promise<void> {
    return this.interruptCalled;
  }

  releaseInterrupt(result: HarnessOperationResult): void {
    this.interruptBlocked = false;
    this.interruptReleaseResolve?.(result);
  }

  blockCapabilities(): void {
    this.capabilitiesBlocked = true;
    this.capabilitiesRelease = new Promise<void>((resolve) => {
      this.capabilitiesReleaseResolve = resolve;
    });
  }

  waitUntilCapabilitiesCalled(count: number): Promise<void> {
    if (this.capabilitiesCount >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.capabilitiesWaiters.push({ count, resolve });
    });
  }

  releaseCapabilities(): void {
    this.capabilitiesBlocked = false;
    this.capabilitiesReleaseResolve?.();
  }
}
