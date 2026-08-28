import { projectPlanBaseSchema } from '@mesh-session-platform/contracts';
import { describe, expect, it } from 'vitest';

import {
  PM_AVAILABLE_TOOLS,
  PM_POLICY_VERSION,
  buildPmPrompt,
} from './planning-policy.js';

const base = projectPlanBaseSchema.parse({
  id: 'base-3',
  planId: 'plan-1',
  ordinal: 3,
  repositoryIdentity: 'repository-identity-1',
  tasks: [
    {
      id: 'task-existing',
      revision: 7,
      lifecycleState: 'backlog',
      blocked: null,
    },
  ],
  dependencies: [
    {
      projectId: 'project-1',
      taskId: 'task-existing',
      prerequisiteTaskId: 'task-prerequisite',
      createdAt: '2026-08-27T12:00:00.000Z',
      createdBy: { type: 'human', id: 'operator-1', displayName: 'Operator' },
    },
  ],
  projectArchivedAt: null,
  projectRevision: 11,
  policyRevision: 5,
  createdAt: '2026-08-27T12:00:00.000Z',
});

describe('PM planning policy', () => {
  it('exposes only repository reads and one structured proposal control', () => {
    expect(PM_AVAILABLE_TOOLS).toEqual([
      'Read',
      'Glob',
      'Grep',
      'mcp__mesh_pm__submit_project_plan',
    ]);
    expect(PM_AVAILABLE_TOOLS).not.toEqual(
      expect.arrayContaining([
        'Bash',
        'Write',
        'Edit',
        'NotebookEdit',
        'WebFetch',
        'WebSearch',
        'Task',
        'mcp__mesh_developer__submit_for_review',
        'mcp__mesh_developer__mark_blocked',
        'mcp__mesh_qa__submit_qa_verdict',
      ]),
    );
  });

  it('freezes the planning request, board base, limits, and read-only authority in the prompt', () => {
    const prompt = buildPmPrompt({
      planId: 'plan-1',
      planRevision: 4,
      goal: 'Ship a dependable planning workflow.',
      constraints: ['Preserve subscription-backed operation.'],
      nonGoals: ['Do not implement the proposal.'],
      base,
      capabilityGeneration: 6,
    });

    expect(PM_POLICY_VERSION).toBeTruthy();
    expect(prompt).toContain('Ship a dependable planning workflow.');
    expect(prompt).toContain('Preserve subscription-backed operation.');
    expect(prompt).toContain('Do not implement the proposal.');
    expect(prompt).toContain('Plan ID: plan-1');
    expect(prompt).toContain('Plan revision: 4');
    expect(prompt).toContain('Base ID: base-3');
    expect(prompt).toContain('Base revision: 3');
    expect(prompt).toContain('Capability generation: 6');
    expect(prompt).toContain('repository-identity-1');
    expect(prompt).toContain('task-existing');
    expect(prompt).toContain('task-prerequisite');
    expect(prompt).toContain('at most 50 tasks');
    expect(prompt).toContain('at most 200 dependency edges');
    expect(prompt).toContain('You cannot modify repository files');
    expect(prompt).toContain('You cannot run shell commands');
    expect(prompt).toContain('You cannot access the network');
    expect(prompt).toContain('You cannot create or edit canonical tasks');
    expect(prompt).toContain('You cannot start, stop, or alter sessions');
    expect(prompt).toContain('Developer or QA outcome tools');
    expect(prompt).toContain('mcp__mesh_pm__submit_project_plan');
    expect(prompt).toContain(
      'Transcript text and process exit are not submissions',
    );
  });

  it('rejects a base from another planning cycle before composing authority', () => {
    expect(() =>
      buildPmPrompt({
        planId: 'different-plan',
        planRevision: 4,
        goal: 'Plan the goal.',
        constraints: [],
        nonGoals: [],
        base,
        capabilityGeneration: 6,
      }),
    ).toThrow('Planning base does not belong to the requested plan');
  });
});
