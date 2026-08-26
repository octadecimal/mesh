import type { ProjectEvent } from '@mesh-session-platform/contracts';
import type { RetainedProjectEventWindow } from '../repositories/project-event-repository.js';

type ProjectEventHistory = {
  retainedAfter(
    projectId: string,
    sequence: number,
  ): RetainedProjectEventWindow;
};

export type ProjectReplayResult = {
  events: ProjectEvent[];
  highWaterByProject: Record<string, number>;
  resyncProjectIds: string[];
};

export class ProjectReplayService {
  constructor(private readonly events: ProjectEventHistory) {}

  after(cursors: Record<string, number>): ProjectReplayResult {
    const events: ProjectEvent[] = [];
    const highWaterByProject: Record<string, number> = {};
    const resyncProjectIds: string[] = [];

    for (const [projectId, cursor] of Object.entries(cursors)) {
      const retained = this.events.retainedAfter(projectId, cursor);
      highWaterByProject[projectId] = retained.highWater;
      let expectedSequence = cursor + 1;
      const invalidMetadata =
        retained.lowWater < 1 ||
        retained.highWater < 0 ||
        retained.lowWater > retained.highWater + 1;
      const unavailablePrefix = cursor < retained.lowWater - 1;
      const aheadCursor = cursor > retained.highWater;
      const discontinuity = retained.events.some((event) => {
        if (
          event.projectId !== projectId ||
          event.sequence !== expectedSequence
        ) {
          return true;
        }
        expectedSequence += 1;
        return false;
      });
      const unavailableTail = expectedSequence - 1 !== retained.highWater;

      if (
        invalidMetadata ||
        unavailablePrefix ||
        aheadCursor ||
        discontinuity ||
        unavailableTail
      ) {
        resyncProjectIds.push(projectId);
        continue;
      }

      events.push(...retained.events);
    }

    return { events, highWaterByProject, resyncProjectIds };
  }
}
