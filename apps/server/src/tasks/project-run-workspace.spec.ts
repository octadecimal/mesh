import { dirname, isAbsolute } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createProjectRunWorkspacePlanner } from './project-run-workspace.js';

describe('project run workspace planning', () => {
  it('assigns deterministic isolated Mesh worktrees to distinct items', () => {
    const plan = createProjectRunWorkspacePlanner('C:\\mesh-data');
    const project = {
      id: 'project-1',
      repositoryPath: 'C:\\repos\\project-1',
    } as never;
    const run = { id: 'run-1' } as never;
    const first = plan(project, run, { id: 'item-1' } as never);
    const second = plan(project, run, { id: 'item-2' } as never);

    expect(first.type).toBe('worktree');
    expect(second.type).toBe('worktree');
    expect(first.path).not.toBe(second.path);
    expect(first.branch).not.toBe(second.branch);
    expect(plan(project, run, { id: 'item-1' } as never)).toEqual(first);
    expect(isAbsolute(first.path)).toBe(true);
    expect(dirname(first.path)).toBe(dirname(second.path));
  });
});
