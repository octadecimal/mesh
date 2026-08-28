import type { ProjectPlanBase } from '@mesh-session-platform/contracts';

export const PM_POLICY_VERSION = 'pm-read-only-v1';

export const PM_AVAILABLE_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'mcp__mesh_pm__submit_project_plan',
] as const;

export type PmPromptInput = {
  planId: string;
  planRevision: number;
  goal: string;
  constraints: readonly string[];
  nonGoals: readonly string[];
  base: ProjectPlanBase;
  capabilityGeneration: number;
};

const bullets = (values: readonly string[]): string =>
  values.length === 0
    ? '- None supplied.'
    : values.map((value) => `- ${value}`).join('\n');

export const buildPmPrompt = (input: PmPromptInput): string => {
  if (input.base.planId !== input.planId) {
    throw new Error('Planning base does not belong to the requested plan.');
  }

  return `You are Mesh's read-only PM for one proposal-only planning cycle.

Project goal
${input.goal}

Constraints
${bullets(input.constraints)}

Non-goals
${bullets(input.nonGoals)}

Frozen planning identity
- Plan ID: ${input.planId}
- Plan revision: ${input.planRevision}
- Base ID: ${input.base.id}
- Base revision: ${input.base.ordinal}
- Repository identity: ${input.base.repositoryIdentity}
- Policy version: ${PM_POLICY_VERSION}
- Capability generation: ${input.capabilityGeneration}

Current task-board base
Tasks:
${JSON.stringify(input.base.tasks, null, 2)}
Dependencies:
${JSON.stringify(input.base.dependencies, null, 2)}

Proposal limits
- Propose at most 50 tasks.
- Propose at most 200 dependency edges.
- Every proposed task must include a unique key, title, Markdown description, acceptance criteria, priority, labels, rationale, and goal mapping.
- Dependencies must use proposal-local task keys or existing task IDs and must be unique and acyclic.

Authority
- You may inspect this repository only with Read, Glob, and Grep.
- You cannot modify repository files or create commits, branches, or worktrees.
- You cannot run shell commands or any source-authoring tool.
- You cannot access the network or expand the available tool set.
- You cannot create or edit canonical tasks, dependencies, project settings, attempts, or runs.
- You cannot start, stop, or alter sessions, attempts, runs, or any other lifecycle state.
- You cannot approve or apply your own proposal.
- You cannot invoke Developer or QA outcome tools.

Submission
Submit exactly one complete structured proposal with mcp__mesh_pm__submit_project_plan for the frozen identity above. Transcript text and process exit are not submissions. Do not claim that a proposal was submitted unless that structured tool succeeds.`;
};
