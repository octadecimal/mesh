import type {
  DeveloperBlockerReportInput,
  DeveloperCompletionReportInput,
  ProjectPlanProposalInput,
  QaReportInput,
} from '@mesh-session-platform/contracts';

import type {
  ClaudeSessionDriver,
  DeveloperRuntimeConfiguration,
  DiscoverClaudeSessionsRequest,
  DiscoveredClaudeSession,
  DriverEvent,
  DriverSession,
  PmRuntimeConfiguration,
  RoleRuntimeConfiguration,
  ResumeClaudeSessionRequest,
  StartClaudeSessionRequest,
} from './driver.js';

export class FakeSubscriptionLimitError extends Error {
  readonly code = 'subscription_limit_reached';

  constructor() {
    super('Fake Claude subscription limit reached');
  }
}

export class FakeDriverSession implements DriverSession {
  readonly prompts: string[] = [];
  readonly permissionDecisions: Array<{
    requestId: string;
    decision: 'approve' | 'deny';
  }> = [];
  interrupted = false;
  private readonly queuedEvents: DriverEvent[] = [];
  private paused = false;
  private closed = false;
  private streamError: Error | undefined;
  private wake: (() => void) | undefined;

  private started = false;

  constructor(
    readonly claudeResumeId: string | undefined,
    private readonly onStart?: () => Promise<void>,
  ) {}

  enqueue(event: DriverEvent): void {
    this.queuedEvents.push(event);
    this.signal();
  }

  pause(): void {
    this.paused = true;
  }

  resumeEmission(): void {
    this.paused = false;
    this.signal();
  }

  crash(error: Error): void {
    this.streamError = error;
    this.signal();
  }

  async *events(): AsyncIterable<DriverEvent> {
    if (!this.started) {
      this.started = true;
      await this.onStart?.();
    }
    while (!this.closed) {
      if (this.streamError) throw this.streamError;
      if (!this.paused && this.queuedEvents.length > 0) {
        const event = this.queuedEvents.shift();
        if (event) yield event;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  async sendPrompt(prompt: string): Promise<void> {
    this.prompts.push(prompt);
  }

  async resolvePermission(
    requestId: string,
    decision: 'approve' | 'deny',
  ): Promise<void> {
    this.permissionDecisions.push({ requestId, decision });
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.signal();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.signal();
  }

  private signal(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}

export type FakeQaStep =
  | { type: 'qa.verified'; report: QaReportInput }
  | { type: 'qa.rejected'; report: QaReportInput }
  | { type: 'qa.wait' }
  | { type: 'qa.startup_failure'; message: string };

export type FakePmStep =
  | { type: 'pm.proposal'; proposal: ProjectPlanProposalInput }
  | { type: 'pm.wait' }
  | { type: 'pm.startup_failure'; message: string };

export class FakeClaudeSessionDriver implements ClaudeSessionDriver {
  readonly createdRequests: StartClaudeSessionRequest[] = [];
  readonly createdSessions: FakeDriverSession[] = [];
  readonly resumedRequests: ResumeClaudeSessionRequest[] = [];
  private readonly developerConfigurations: Array<
    DeveloperRuntimeConfiguration | undefined
  > = [];
  private readonly qaSteps: FakeQaStep[];
  private readonly qaActions: Promise<void>[] = [];
  private readonly pmSteps: FakePmStep[];
  private readonly pmActions: Promise<void>[] = [];
  private createdCount = 0;

  constructor(
    private readonly options: {
      discovered?: DiscoveredClaudeSession[];
      subscriptionLimit?: number;
      qaSteps?: readonly FakeQaStep[];
      pmSteps?: readonly FakePmStep[];
    } = {},
  ) {
    this.qaSteps = [...(options.qaSteps ?? [])];
    this.pmSteps = [...(options.pmSteps ?? [])];
  }

  async discover(
    _request: DiscoverClaudeSessionsRequest,
  ): Promise<DiscoveredClaudeSession[]> {
    return this.options.discovered?.map((session) => ({ ...session })) ?? [];
  }

  async create(request: StartClaudeSessionRequest): Promise<FakeDriverSession> {
    if (
      this.options.subscriptionLimit !== undefined &&
      this.createdCount >= this.options.subscriptionLimit
    ) {
      throw new FakeSubscriptionLimitError();
    }
    this.createdCount += 1;
    const roleStart =
      request.role?.role === 'qa'
        ? this.prepareQaStart(request.role)
        : this.preparePmStart(request.role);
    this.createdRequests.push({ ...request });
    this.developerConfigurations.push(request.developer);
    const session = new FakeDriverSession(
      `fake-resume-${this.createdCount}`,
      roleStart,
    );
    if (request.developer) {
      await session.sendPrompt(request.developer.initialPrompt);
    } else if (request.role) {
      await session.sendPrompt(request.role.initialPrompt);
    }
    this.createdSessions.push(session);
    return session;
  }

  async resume(
    request: ResumeClaudeSessionRequest,
  ): Promise<FakeDriverSession> {
    this.resumedRequests.push({ ...request });
    this.developerConfigurations.push(request.developer);
    const session = new FakeDriverSession(
      request.claudeResumeId,
      request.role?.role === 'qa'
        ? this.prepareQaStart(request.role)
        : this.preparePmStart(request.role),
    );
    if (request.developer) {
      await session.sendPrompt(request.developer.initialPrompt);
    } else if (request.role) {
      await session.sendPrompt(request.role.initialPrompt);
    }
    return session;
  }

  async submitForReview(
    index: number,
    report: DeveloperCompletionReportInput,
  ): Promise<void> {
    await this.developerConfiguration(index).controls.submitForReview(report);
  }

  async markBlocked(
    index: number,
    report: DeveloperBlockerReportInput,
  ): Promise<void> {
    await this.developerConfiguration(index).controls.markBlocked(report);
  }

  async drainQaSteps(): Promise<void> {
    await Promise.all(this.qaActions);
  }

  async drainPmSteps(): Promise<void> {
    await Promise.all(this.pmActions);
  }

  private developerConfiguration(index: number): DeveloperRuntimeConfiguration {
    const configuration = this.developerConfigurations[index];
    if (!configuration)
      throw new Error(`No Developer runtime configuration at index ${index}`);
    return configuration;
  }

  private prepareQaStart(
    configuration: RoleRuntimeConfiguration | undefined,
  ): (() => Promise<void>) | undefined {
    if (!configuration || configuration.role !== 'qa') return undefined;
    const step = this.qaSteps.shift();
    if (!step) return undefined;
    if (step.type === 'qa.startup_failure') {
      throw new Error(step.message);
    }
    if (step.type === 'qa.wait') {
      this.qaActions.push(Promise.resolve());
      return undefined;
    }
    const controls = configuration.controlServer.tools.filter(
      ({ name }) => name === 'submit_qa_verdict',
    );
    if (controls.length !== 1) {
      throw new Error('QA runtime must expose exactly one verdict control');
    }
    const control = controls[0];
    if (!control) throw new Error('QA verdict control is unavailable');
    let resolveAction!: () => void;
    let rejectAction!: (error: unknown) => void;
    const action = new Promise<void>((resolve, reject) => {
      resolveAction = resolve;
      rejectAction = reject;
    });
    this.qaActions.push(action);
    return async () => {
      try {
        const result = await control.execute(step.report);
        if (result.isError) {
          throw new Error('Scripted QA verdict control failed');
        }
        resolveAction();
      } catch (error) {
        rejectAction(error);
        throw error;
      }
    };
  }

  private preparePmStart(
    configuration: PmRuntimeConfiguration | undefined,
  ): (() => Promise<void>) | undefined {
    if (!configuration) return undefined;
    const step = this.pmSteps.shift();
    if (!step) return undefined;
    if (step.type === 'pm.startup_failure') {
      throw new Error(step.message);
    }
    if (step.type === 'pm.wait') {
      this.pmActions.push(Promise.resolve());
      return undefined;
    }

    let resolveAction!: () => void;
    let rejectAction!: (error: unknown) => void;
    const action = new Promise<void>((resolve, reject) => {
      resolveAction = resolve;
      rejectAction = reject;
    });
    this.pmActions.push(action);
    return async () => {
      try {
        await configuration.submitProposal(step.proposal);
        resolveAction();
      } catch (error) {
        rejectAction(error);
        throw error;
      }
    };
  }
}
