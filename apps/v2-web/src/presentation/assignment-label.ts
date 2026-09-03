import type { WorkerExecution } from '@mesh/v2-contracts';

export function assignmentLabel(assignment: WorkerExecution['assignment']) {
  switch (assignment.kind) {
    case 'foundation-check':
      return assignment.title;
    case 'pm_discovery':
      return 'Project manager discovery';
    case 'pm_plan':
      return 'Project manager delivery planning';
    case 'developer_task':
      return assignment.title;
  }
}
