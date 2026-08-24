import type { SessionEvent } from '@mesh-session-platform/contracts';

type EventHistory = {
  after(sessionId: string, sequence: number): SessionEvent[];
};

export type ReplayBatch = {
  sessionId: string;
  events: SessionEvent[];
};

export type ReplayResult = {
  batches: ReplayBatch[];
  highWaterBySession: Record<string, number>;
  resyncSessionIds: string[];
};

export class ReplayService {
  constructor(private readonly events: EventHistory) {}

  after(cursors: Record<string, number>): ReplayResult {
    const batches: ReplayBatch[] = [];
    const highWaterBySession: Record<string, number> = {};
    const resyncSessionIds: string[] = [];

    for (const [sessionId, cursor] of Object.entries(cursors)) {
      const retained = this.events.after(sessionId, -1);
      const firstSequence = retained[0]?.sequence;
      const highWater = retained.at(-1)?.sequence ?? 0;
      highWaterBySession[sessionId] = highWater;

      if (firstSequence !== undefined && cursor < firstSequence - 1) {
        resyncSessionIds.push(sessionId);
        continue;
      }

      const replay = retained.filter(
        (event) => event.sequence > cursor && event.sequence <= highWater,
      );
      if (replay.length > 0) batches.push({ sessionId, events: replay });
    }

    return { batches, highWaterBySession, resyncSessionIds };
  }
}
