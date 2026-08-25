import type { ProjectEvent } from '@mesh-session-platform/contracts';

type ProjectEventHistory = {
  after(projectId: string, sequence: number): ProjectEvent[];
};

export type ProjectReplayResult = {
  events: ProjectEvent[];
  resyncProjectIds: string[];
};

export class ProjectReplayService {
  constructor(private readonly events: ProjectEventHistory) {}

  after(cursors: Record<string, number>): ProjectReplayResult {
    const events: ProjectEvent[] = [];
    const resyncProjectIds: string[] = [];

    for (const [projectId, cursor] of Object.entries(cursors)) {
      const retained = this.events
        .after(projectId, 0)
        .filter((event) => event.projectId === projectId);
      const firstSequence = retained[0]?.sequence;
      const highWater = retained.at(-1)?.sequence ?? 0;

      if (
        cursor > highWater ||
        (firstSequence !== undefined && cursor < firstSequence - 1)
      ) {
        resyncProjectIds.push(projectId);
        continue;
      }

      events.push(...retained.filter((event) => event.sequence > cursor));
    }

    return { events, resyncProjectIds };
  }
}
