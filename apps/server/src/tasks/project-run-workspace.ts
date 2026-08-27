import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import type {
  Project,
  ProjectRun,
  ProjectRunItem,
} from '@mesh-session-platform/contracts';

import type { ProjectRunAttemptLaunchInput } from './attempt-service.js';

export type ProjectRunWorkspace = Extract<
  NonNullable<ProjectRunAttemptLaunchInput['workspace']>,
  { type: 'worktree' }
>;

export type ProjectRunWorkspacePlanner = (
  project: Project,
  run: ProjectRun,
  item: ProjectRunItem,
) => ProjectRunWorkspace;

export const projectRunWorkspaceRoot = (baseDirectory: string): string =>
  resolve(baseDirectory, '.mesh-project-runs');

export const createProjectRunWorkspacePlanner = (
  baseDirectory: string,
): ProjectRunWorkspacePlanner => {
  const root = projectRunWorkspaceRoot(baseDirectory);
  return (project, run, item) => {
    const identity = createHash('sha256')
      .update(`${project.id}\0${run.id}\0${item.id}`)
      .digest('hex')
      .slice(0, 24);
    return {
      type: 'worktree',
      repositoryPath: project.repositoryPath,
      path: join(root, identity),
      branch: `mesh/project-run-${identity}`,
      startPoint: 'HEAD',
    };
  };
};
