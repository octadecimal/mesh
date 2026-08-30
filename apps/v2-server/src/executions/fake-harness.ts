import { Buffer } from 'node:buffer';

import {
  harnessCapabilitiesSchema,
  harnessEventEnvelopeSchema,
  harnessResumeRequestSchema,
  harnessStartRequestSchema,
  PM_DISCOVERY_REPORT_SCHEMA,
  planningTurnIdSchema,
  workerExecutionIdSchema,
  type HarnessAdapter,
  type HarnessEventEnvelope,
  type HarnessOperationResult,
  type HarnessProbeResult,
  type HarnessResumeRequest,
  type HarnessSession,
  type HarnessStartRequest,
  type LogicalSkillRequest,
  type PmDiscoveryAssignment,
  type PmDiscoveryReport,
  type PlanningTurnId,
} from '@mesh/v2-contracts';

import { canonicalJson } from '../storage/canonical-json.js';
import { matchingSkill } from './harness-adapter.js';

const MAX_HANDLE_BYTES = 4096;
const FOUNDATION_SCENARIO = 'todo-foundation-v1' as const;
const PM_SCENARIO = 'pm-discovery-v1' as const;

export type FakePmScenario =
  | 'todo'
  | 'malformed'
  | 'duplicate'
  | 'missing_output';

type FakeHandle = {
  executionId: string;
  scenario: typeof FOUNDATION_SCENARIO | typeof PM_SCENARIO;
  pmScenario?: FakePmScenario;
  checkpointCursor: number;
};

const terminalCursor = (handle: FakeHandle): number =>
  handle.scenario === FOUNDATION_SCENARIO
    ? 6
    : handle.pmScenario === 'duplicate'
      ? 3
      : handle.pmScenario === 'todo' || handle.pmScenario === 'malformed'
        ? 2
        : 1;

export type FakeHarnessOptions = {
  holdAfterAdapterCursor?: number;
  malformedAtAdapterCursor?: number;
  failAtAdapterCursor?: number;
  available?: boolean;
  interruptThrows?: boolean;
  pmScenario?: FakePmScenario;
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
  if (
    encodedPayload === undefined ||
    encodedPayload.length === 0 ||
    !/^[A-Za-z0-9_-]+$/.test(encodedPayload)
  ) {
    return {
      ok: false,
      status: 'missing',
      reason: 'Fake handle payload is missing',
    };
  }
  try {
    const decodedBytes = Buffer.from(encodedPayload, 'base64url');
    if (decodedBytes.toString('base64url') !== encodedPayload) {
      return {
        ok: false,
        status: 'missing',
        reason: 'Fake handle encoding is noncanonical',
      };
    }
    const decoded = decodedBytes.toString('utf8');
    if (Buffer.byteLength(decoded, 'utf8') > MAX_HANDLE_BYTES) {
      return {
        ok: false,
        status: 'missing',
        reason: 'Fake handle payload is oversized',
      };
    }
    const value = JSON.parse(decoded) as unknown;
    const keys =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.keys(value).sort().join(',')
        : '';
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      (keys !== 'checkpointCursor,executionId,scenario' &&
        keys !== 'checkpointCursor,executionId,pmScenario,scenario')
    ) {
      return {
        ok: false,
        status: 'missing',
        reason: 'Fake handle payload has an invalid shape',
      };
    }
    const candidate = value as Partial<FakeHandle>;
    if (
      !workerExecutionIdSchema.safeParse(candidate.executionId).success ||
      (candidate.scenario !== FOUNDATION_SCENARIO &&
        candidate.scenario !== PM_SCENARIO) ||
      (candidate.scenario === PM_SCENARIO &&
        !['todo', 'malformed', 'duplicate', 'missing_output'].includes(
          String(candidate.pmScenario),
        )) ||
      (candidate.scenario === FOUNDATION_SCENARIO &&
        candidate.pmScenario !== undefined) ||
      !Number.isInteger(candidate.checkpointCursor) ||
      (candidate.checkpointCursor as number) < 0 ||
      (candidate.checkpointCursor as number) >
        terminalCursor(candidate as FakeHandle) ||
      canonicalJson(value) !== decoded
    ) {
      return {
        ok: false,
        status: 'missing',
        reason: 'Fake handle payload is invalid',
      };
    }
    return { ok: true, value: candidate as FakeHandle };
  } catch {
    return {
      ok: false,
      status: 'missing',
      reason: 'Fake handle payload is malformed',
    };
  }
};

const foundationEnvelope = (
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
    raw: {
      source: 'fake',
      scenario: FOUNDATION_SCENARIO,
      adapterCursor,
    },
    normalized,
  });
};

const humanTurnIds = (
  assignment: PmDiscoveryAssignment,
): readonly PlanningTurnId[] =>
  assignment.input.conversation
    .filter(({ actor }) => actor === 'human')
    .map(({ turnId }) => planningTurnIdSchema.parse(turnId));

const provenance = (assignment: PmDiscoveryAssignment) =>
  humanTurnIds(assignment).map((turnId) => ({
    kind: 'conversation_turn' as const,
    turnId,
    rationale: 'The operator supplied the Todo discovery input.',
  }));

const todoReport = (assignment: PmDiscoveryAssignment): PmDiscoveryReport => {
  const binding = {
    schema: PM_DISCOVERY_REPORT_SCHEMA,
    planningCycleId: assignment.planningCycleId,
    humanTurnId: assignment.humanTurnId,
    expectedCycleRevision: assignment.expectedCycleRevision,
    expectedProposalRevision: assignment.expectedProposalRevision,
  };
  if (humanTurnIds(assignment).length === 1) {
    return {
      ...binding,
      assistantMessage: 'I need two details before proposing Todo intent.',
      result: {
        kind: 'questions',
        questions: [
          {
            key: 'todo.persistence',
            prompt: 'How should Todo items persist?',
            rationale: 'Persistence changes the product contract.',
            choices: ['Local browser storage', 'No persistence'],
          },
          {
            key: 'todo.keyboard',
            prompt: 'Should all Todo controls be keyboard operable?',
            rationale: 'Keyboard behavior is a material UX requirement.',
            choices: ['Yes', 'No'],
          },
        ],
      },
    };
  }
  const sources = provenance(assignment);
  return {
    ...binding,
    assistantMessage:
      'The complete Todo intent and ledger are ready to review.',
    result: {
      kind: 'proposal',
      summary: 'Define a small persistent, keyboard-operable Todo product.',
      projectIntent: {
        goal: 'Let people add and complete Todo items reliably.',
        targetUsers: ['People tracking a short personal task list.'],
        desiredCapabilities: [
          'Add Todo items.',
          'Complete Todo items.',
          'Restore Todo items after reload.',
        ],
        constraints: ['All controls are keyboard operable.'],
        nonGoals: ['Team collaboration is excluded.'],
        successConditions: [
          'A saved Todo item remains after reload.',
          'A keyboard user can add and complete an item.',
        ],
        rationale: 'The operator requested a focused persistent Todo product.',
        provenance: sources,
      },
      records: [
        {
          operation: 'create',
          key: 'requirement.todo-items',
          content: {
            type: 'requirement',
            statement: 'Users can add and complete Todo items.',
            rationale: 'Creating and completing items is the core workflow.',
            kind: 'functional',
            status: 'proposed',
            priority: 'must',
          },
          provenance: sources,
        },
        {
          operation: 'create',
          key: 'requirement.keyboard',
          content: {
            type: 'requirement',
            statement: 'Every Todo control is keyboard operable.',
            rationale: 'The product must support keyboard interaction.',
            kind: 'ux',
            status: 'proposed',
            priority: 'must',
          },
          provenance: sources,
        },
        {
          operation: 'create',
          key: 'requirement.persistence',
          content: {
            type: 'requirement',
            statement: 'Todo items persist across application reloads.',
            rationale: 'Reloading must not discard the task list.',
            kind: 'operational',
            status: 'proposed',
            priority: 'must',
          },
          provenance: sources,
        },
        {
          operation: 'create',
          key: 'assumption.single-user',
          content: {
            type: 'assumption',
            statement: 'One person uses the Todo list on one device.',
            rationale: 'Collaboration is outside this product slice.',
            status: 'active',
            confidence: 'high',
          },
          provenance: sources,
        },
        {
          operation: 'create',
          key: 'decision.local-storage',
          content: {
            type: 'decision',
            statement: 'Store Todo items locally in the application.',
            rationale: 'Local persistence satisfies the requested scope.',
            status: 'active',
          },
          provenance: sources,
        },
        {
          operation: 'create',
          key: 'question.retention',
          content: {
            type: 'question',
            statement: 'How long should completed Todo items remain visible?',
            rationale:
              'Retention can be decided after the first product slice.',
            status: 'open',
          },
          provenance: sources,
        },
        {
          operation: 'create',
          key: 'risk.storage-loss',
          content: {
            type: 'risk',
            statement: 'Local browser data can be cleared by the user.',
            rationale: 'Local persistence is not a backup service.',
            status: 'open',
            severity: 'medium',
            mitigation: 'Explain that clearing site data removes Todo items.',
          },
          provenance: sources,
        },
      ],
      relationships: [
        {
          kind: 'depends_on',
          from: { proposalKey: 'requirement.todo-items' },
          to: { proposalKey: 'requirement.persistence' },
        },
        {
          kind: 'constrains',
          from: { proposalKey: 'decision.local-storage' },
          to: { proposalKey: 'requirement.persistence' },
        },
      ],
    },
  };
};

const pmEnvelope = (
  request: HarnessStartRequest & { assignment: PmDiscoveryAssignment },
  adapterCursor: number,
  scenario: FakePmScenario | undefined,
): HarnessEventEnvelope => {
  const base = {
    projectId: request.project.id,
    executionId: request.executionId,
    adapterCursor,
    occurredAt: new Date(
      Date.UTC(2026, 7, 29, 0, 0, adapterCursor),
    ).toISOString(),
  };
  const outputCount =
    scenario === 'duplicate'
      ? 2
      : scenario === 'todo' || scenario === 'malformed'
        ? 1
        : 0;
  const normalized =
    adapterCursor <= outputCount
      ? {
          ...base,
          type: 'worker_execution.structured_output' as const,
          payload: {
            schema: PM_DISCOVERY_REPORT_SCHEMA,
            value:
              scenario === 'malformed'
                ? { schema: PM_DISCOVERY_REPORT_SCHEMA, malformed: true }
                : todoReport(request.assignment),
          },
        }
      : {
          ...base,
          type: 'worker_execution.completed' as const,
          payload: { outcome: 'completed' as const },
        };
  return harnessEventEnvelopeSchema.parse({
    adapterCursor,
    raw: {
      source: 'fake',
      scenario: scenario ?? 'missing_output',
      adapterCursor,
    },
    normalized,
  });
};

const scriptEnvelope = (
  request: HarnessStartRequest,
  adapterCursor: number,
  options: FakeHarnessOptions,
): HarnessEventEnvelope =>
  request.assignment.kind === 'pm_discovery'
    ? pmEnvelope(
        request as HarnessStartRequest & { assignment: PmDiscoveryAssignment },
        adapterCursor,
        options.pmScenario,
      )
    : foundationEnvelope(request, adapterCursor);

const scriptLength = (
  assignment: HarnessStartRequest['assignment'],
  scenario: FakePmScenario | undefined,
): number =>
  assignment.kind === 'foundation-check'
    ? 6
    : scenario === 'duplicate'
      ? 3
      : scenario === 'todo' || scenario === 'malformed'
        ? 2
        : 1;

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
      scenario:
        this.request.assignment.kind === 'pm_discovery'
          ? PM_SCENARIO
          : FOUNDATION_SCENARIO,
      ...(this.request.assignment.kind === 'pm_discovery'
        ? { pmScenario: this.options.pmScenario ?? 'missing_output' }
        : {}),
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
    const length = scriptLength(
      this.request.assignment,
      this.options.pmScenario,
    );
    for (let cursor = afterAdapterCursor + 1; cursor <= length; cursor += 1) {
      if (this.closed) return;
      this.consumedAdapterCursors.push(cursor);
      if (this.options.failAtAdapterCursor === cursor) {
        throw new Error(`fake adapter failure at cursor ${cursor}`);
      }
      const envelope = scriptEnvelope(this.request, cursor, this.options);
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
    if (parsed.value.checkpointCursor === terminalCursor(parsed.value)) {
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
    const requestScenario =
      request.assignment.kind === 'pm_discovery'
        ? PM_SCENARIO
        : request.assignment.fakeScenario;
    if (parsed.value.scenario !== requestScenario) {
      throw new Error('Fake handle scenario does not match resume request');
    }
    if (
      requestScenario === PM_SCENARIO &&
      parsed.value.pmScenario !== (this.options.pmScenario ?? 'missing_output')
    ) {
      throw new Error('Fake handle PM scenario does not match adapter fixture');
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
