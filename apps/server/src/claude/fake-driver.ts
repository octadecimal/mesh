import type {
  DeveloperBlockerReport,
  DeveloperCompletionReport,
} from '@mesh-session-platform/contracts';

import type {
  ClaudeSessionDriver,
  DeveloperRuntimeConfiguration,
  DiscoverClaudeSessionsRequest,
  DiscoveredClaudeSession,
  DriverEvent,
  DriverSession,
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

  constructor(readonly claudeResumeId: string | undefined) {}

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

export class FakeClaudeSessionDriver implements ClaudeSessionDriver {
  readonly createdRequests: StartClaudeSessionRequest[] = [];
  readonly createdSessions: FakeDriverSession[] = [];
  readonly resumedRequests: ResumeClaudeSessionRequest[] = [];
  private readonly developerConfigurations: Array<
    DeveloperRuntimeConfiguration | undefined
  > = [];
  private createdCount = 0;

  constructor(
    private readonly options: {
      discovered?: DiscoveredClaudeSession[];
      subscriptionLimit?: number;
    } = {},
  ) {}

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
    this.createdRequests.push({ ...request });
    this.developerConfigurations.push(request.developer);
    const session = new FakeDriverSession(`fake-resume-${this.createdCount}`);
    if (request.developer) {
      await session.sendPrompt(request.developer.initialPrompt);
    }
    this.createdSessions.push(session);
    return session;
  }

  async resume(
    request: ResumeClaudeSessionRequest,
  ): Promise<FakeDriverSession> {
    this.resumedRequests.push({ ...request });
    this.developerConfigurations.push(request.developer);
    const session = new FakeDriverSession(request.claudeResumeId);
    if (request.developer) {
      await session.sendPrompt(request.developer.initialPrompt);
    }
    return session;
  }

  async submitForReview(
    index: number,
    report: DeveloperCompletionReport,
  ): Promise<void> {
    await this.developerConfiguration(index).controls.submitForReview(report);
  }

  async markBlocked(
    index: number,
    report: DeveloperBlockerReport,
  ): Promise<void> {
    await this.developerConfiguration(index).controls.markBlocked(report);
  }

  private developerConfiguration(index: number): DeveloperRuntimeConfiguration {
    const configuration = this.developerConfigurations[index];
    if (!configuration)
      throw new Error(`No Developer runtime configuration at index ${index}`);
    return configuration;
  }
}
