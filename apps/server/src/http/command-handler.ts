import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { z } from 'zod';
import {
  commandSchema,
  projectSchema,
  sessionDiagnosticsSchema,
  sessionHistorySchema,
  sessionSchema,
  workspaceSchema,
  type Command,
  type Session,
} from '@mesh-session-platform/contracts';

import type { ClaudeSessionDriver } from '../claude/driver.js';
import type { GitAdapter } from '../platform/git.js';
import {
  resolveWorkspacePath,
  type AbsolutePath,
  type ResolveWorkspacePathOptions,
} from '../platform/paths.js';
import type { CommandRepository } from '../repositories/command-repository.js';
import type { DiagnosticRepository } from '../repositories/diagnostic-repository.js';
import type { EventRepository } from '../repositories/event-repository.js';
import type { LayoutRepository } from '../repositories/layout-repository.js';
import type { ProjectRepository } from '../repositories/project-repository.js';
import type { SessionRepository } from '../repositories/session-repository.js';
import type { TaskAttemptRepository } from '../repositories/task-attempt-repository.js';
import type { WorkspaceRepository } from '../repositories/workspace-repository.js';
import type { SessionRegistry } from '../runtime/session-registry.js';
import type { TaskMutationResult, TaskService } from '../tasks/task-service.js';
import {
  RepositoryIdentityError,
  resolveRepositoryIdentity,
} from '../projects/repository-identity.js';
import { CommandError } from './errors.js';

const commandResponseSchema = z.object({
  protocolVersion: z.literal(1),
  commandType: z.string(),
  result: z.unknown(),
  warnings: z
    .array(z.object({ code: z.string(), message: z.string() }))
    .default([]),
});

export type CommandResponse = z.infer<typeof commandResponseSchema>;

export interface CommandDependencies {
  projects: ProjectRepository;
  attempts: Pick<TaskAttemptRepository, 'getCurrentBySession'>;
  workspaces: WorkspaceRepository;
  sessions: SessionRepository;
  events: EventRepository;
  diagnostics: DiagnosticRepository;
  layouts: LayoutRepository;
  commands: CommandRepository;
  taskService: TaskService;
  registry: SessionRegistry;
  driver: ClaudeSessionDriver;
  git?: Pick<GitAdapter, 'createWorktree' | 'removeOwnedWorktree'>;
  pathOptions?: ResolveWorkspacePathOptions;
  billingConflicts?: readonly { variable: string }[];
  now?: () => string;
  createId?: () => string;
}

const response = (
  commandType: string,
  result: unknown,
  warnings: Array<{ code: string; message: string }> = [],
): CommandResponse =>
  commandResponseSchema.parse({
    protocolVersion: 1,
    commandType,
    result: JSON.parse(JSON.stringify(result)),
    warnings,
  });

const taskResponse = (
  result: TaskMutationResult,
  dependencies: CommandDependencies,
) => {
  dependencies.registry.publisher.publishProject(result.event);
  return {
    ...result,
    projectEventCursor: result.event.sequence,
  };
};

const requireTaskCommandId = (commandId: string | undefined): string => {
  if (!commandId) {
    throw new CommandError(
      'invalid_command',
      'Task commands require an idempotency key',
    );
  }
  return commandId;
};

const requireProject = (dependencies: CommandDependencies, id: string) => {
  const project = dependencies.projects.get(id);
  if (!project)
    throw new CommandError(
      'project_not_found',
      `Project '${id}' was not found`,
    );
  return project;
};

const requireWorkspace = (dependencies: CommandDependencies, id: string) => {
  const workspace = dependencies.workspaces.get(id);
  if (!workspace)
    throw new CommandError(
      'workspace_not_found',
      `Workspace '${id}' was not found`,
    );
  return workspace;
};

const requireSession = (dependencies: CommandDependencies, id: string) => {
  const session = dependencies.sessions.get(id);
  if (!session)
    throw new CommandError(
      'session_not_found',
      `Session '${id}' was not found`,
    );
  return session;
};

const assertBillingSafe = (dependencies: CommandDependencies) => {
  if ((dependencies.billingConflicts?.length ?? 0) > 0) {
    throw new CommandError(
      'billing_configuration_conflict',
      'API billing environment variables must be removed before starting Claude',
      dependencies.billingConflicts,
    );
  }
};

const isLive = (session: Session) =>
  ['starting', 'running', 'waiting_for_approval', 'interrupting'].includes(
    session.lifecycleState,
  );

const discoverSessions = async (
  dependencies: CommandDependencies,
  projectId?: string,
) => {
  const projects = projectId
    ? [requireProject(dependencies, projectId)]
    : dependencies.projects.list();
  const discovered: Session[] = [];
  for (const project of projects) {
    const known = dependencies.sessions.listByProject(project.id, {
      includeArchived: true,
    });
    for (const workspace of dependencies.workspaces.listByProject(project.id)) {
      const driverSessions = await dependencies.driver.discover({
        workspacePath: workspace.path,
      });
      for (const candidate of driverSessions) {
        const existing = known.find(
          (session) => session.claudeResumeId === candidate.claudeResumeId,
        );
        if (existing) {
          discovered.push(existing);
          continue;
        }
        const now = (dependencies.now ?? (() => new Date().toISOString()))();
        const session = sessionSchema.parse({
          id: (dependencies.createId ?? randomUUID)(),
          claudeResumeId: candidate.claudeResumeId,
          projectId: project.id,
          workspaceId: workspace.id,
          title: candidate.title ?? 'Discovered Claude session',
          permissionMode: 'inherit',
          lifecycleState: 'interrupted',
          createdAt: now,
          updatedAt: now,
        });
        dependencies.sessions.create(session);
        known.push(session);
        discovered.push(session);
      }
    }
  }
  return discovered;
};

const discoverProjects = async (dependencies: CommandDependencies) => {
  const known = dependencies.projects.list();
  if (!dependencies.pathOptions) return { projects: known, suggestions: [] };

  const baseDirectory = await resolveWorkspacePath(
    dependencies.pathOptions.baseDirectory,
    dependencies.pathOptions,
  );
  const entries = await readdir(baseDirectory, { withFileTypes: true });
  const candidates = [
    baseDirectory,
    ...entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(baseDirectory, entry.name)),
  ];
  const suggestions: Array<{ displayName: string; repositoryPath: string }> =
    [];
  for (const candidate of candidates) {
    try {
      const marker = await stat(join(candidate, '.git'));
      if (marker.isDirectory() || marker.isFile()) {
        const repositoryPath = await resolveWorkspacePath(
          candidate,
          dependencies.pathOptions,
        );
        suggestions.push({
          displayName: basename(repositoryPath) || 'Mesh workspace',
          repositoryPath,
        });
      }
    } catch {
      // Not a Git repository candidate.
    }
  }
  return { projects: known, suggestions };
};

const requireActiveProject = (
  dependencies: CommandDependencies,
  id: string,
) => {
  const project = requireProject(dependencies, id);
  if (project.archivedAt) {
    throw new CommandError('project_archived', `Project '${id}' is archived`, {
      project,
    });
  }
  return project;
};

const updateProject = (
  dependencies: CommandDependencies,
  project: ReturnType<typeof requireProject>,
  expectedRevision: number,
  patch: Partial<
    Pick<ReturnType<typeof requireProject>, 'displayName' | 'archivedAt'>
  >,
) => {
  const now = (dependencies.now ?? (() => new Date().toISOString()))();
  const updated = dependencies.projects.update(
    { ...project, ...patch, updatedAt: now },
    expectedRevision,
  );
  if (updated) return updated;
  throw new CommandError(
    'task_revision_conflict',
    `Project '${project.id}' has changed`,
    { project: dependencies.projects.get(project.id) },
  );
};

const hasRunningTaskAttempt = (
  dependencies: CommandDependencies,
  projectId: string,
) =>
  dependencies.sessions
    .listByProject(projectId, { includeArchived: true })
    .some(
      (session) =>
        isLive(session) &&
        dependencies.attempts.getCurrentBySession(session.id),
    );

const reconcileLegacyProjectIdentities = async (
  dependencies: CommandDependencies,
) => {
  const pathOptions = dependencies.pathOptions;
  if (!pathOptions) return;
  const now = (dependencies.now ?? (() => new Date().toISOString()))();
  for (const project of dependencies.projects.list()) {
    if (project.repositoryIdentity !== project.repositoryPath) continue;
    let identity;
    try {
      identity = await resolveRepositoryIdentity(
        project.repositoryPath,
        pathOptions,
      );
    } catch (error) {
      if (
        error instanceof RepositoryIdentityError &&
        error.code === 'repository_invalid'
      ) {
        continue;
      }
      throw error;
    }
    const reconciled = dependencies.projects.update(
      {
        ...project,
        repositoryPath: identity.canonicalPath,
        repositoryIdentity: identity.repositoryIdentity,
        updatedAt: now,
      },
      project.revision,
    );
    if (!reconciled) {
      throw new CommandError(
        'task_revision_conflict',
        `Project '${project.id}' changed while reconciling its repository identity`,
        { project: dependencies.projects.get(project.id) },
      );
    }
  }
};

const executeMutation = async (
  command: Extract<Command, { idempotencyKey: string }>['command'],
  dependencies: CommandDependencies,
  commandId?: string,
): Promise<CommandResponse> => {
  switch (command.type) {
    case 'task.create':
      return response(
        command.type,
        taskResponse(
          await dependencies.taskService.create({
            ...command.payload,
            commandId: requireTaskCommandId(commandId),
          }),
          dependencies,
        ),
      );
    case 'task.edit':
      return response(
        command.type,
        taskResponse(
          await dependencies.taskService.edit({
            ...command.payload,
            commandId: requireTaskCommandId(commandId),
          }),
          dependencies,
        ),
      );
    case 'task.reorder':
      return response(
        command.type,
        taskResponse(
          await dependencies.taskService.reorder({
            ...command.payload,
            commandId: requireTaskCommandId(commandId),
          }),
          dependencies,
        ),
      );
    case 'task.block':
      return response(
        command.type,
        taskResponse(
          await dependencies.taskService.block({
            ...command.payload,
            commandId: requireTaskCommandId(commandId),
          }),
          dependencies,
        ),
      );
    case 'task.unblock':
      return response(
        command.type,
        taskResponse(
          await dependencies.taskService.unblock({
            ...command.payload,
            commandId: requireTaskCommandId(commandId),
          }),
          dependencies,
        ),
      );
    case 'task.transition':
      return response(
        command.type,
        taskResponse(
          await dependencies.taskService.transition({
            ...command.payload,
            commandId: requireTaskCommandId(commandId),
          }),
          dependencies,
        ),
      );
    case 'project.import': {
      if (!dependencies.pathOptions) {
        throw new CommandError(
          'repository_invalid',
          'Workspace path configuration is unavailable',
        );
      }
      const identity = await resolveRepositoryIdentity(
        command.payload.repositoryPath,
        dependencies.pathOptions,
      );
      await reconcileLegacyProjectIdentities(dependencies);
      const existing = dependencies.projects.getByRepositoryIdentity(
        identity.repositoryIdentity,
      );
      if (existing) {
        throw new CommandError(
          'repository_already_imported',
          'This Git repository is already imported',
          { project: existing },
        );
      }
      const now = (dependencies.now ?? (() => new Date().toISOString()))();
      return response(
        command.type,
        dependencies.projects.create(
          projectSchema.parse({
            id: (dependencies.createId ?? randomUUID)(),
            displayName:
              command.payload.displayName ??
              basename(identity.canonicalPath) ??
              'Git repository',
            repositoryPath: identity.canonicalPath,
            repositoryIdentity: identity.repositoryIdentity,
            discoveredAt: now,
            discoveryMetadata: { source: 'explicit_import' },
            createdAt: now,
            updatedAt: now,
          }),
        ),
      );
    }
    case 'project.rename': {
      const project = requireActiveProject(
        dependencies,
        command.payload.projectId,
      );
      return response(
        command.type,
        updateProject(dependencies, project, command.payload.expectedRevision, {
          displayName: command.payload.displayName,
        }),
      );
    }
    case 'project.archive': {
      const project = requireActiveProject(
        dependencies,
        command.payload.projectId,
      );
      if (hasRunningTaskAttempt(dependencies, project.id)) {
        throw new CommandError(
          'project_has_running_attempt',
          'A project with a running task attempt cannot be archived',
          { project },
        );
      }
      const now = (dependencies.now ?? (() => new Date().toISOString()))();
      return response(
        command.type,
        updateProject(dependencies, project, command.payload.expectedRevision, {
          archivedAt: now,
        }),
      );
    }
    case 'project.restore': {
      const project = requireProject(dependencies, command.payload.projectId);
      return response(
        command.type,
        updateProject(dependencies, project, command.payload.expectedRevision, {
          archivedAt: null,
        }),
      );
    }
    case 'session.create': {
      assertBillingSafe(dependencies);
      const project = requireProject(dependencies, command.payload.projectId);
      let workspace;
      if ('workspaceId' in command.payload) {
        workspace = requireWorkspace(dependencies, command.payload.workspaceId);
      } else {
        const pathOptions = dependencies.pathOptions;
        if (!pathOptions) {
          throw new CommandError(
            'invalid_command',
            'Workspace path configuration is unavailable',
          );
        }
        const workspaceId = (dependencies.createId ?? randomUUID)();
        try {
          if (command.payload.workspace.type === 'shared') {
            const path = await resolveWorkspacePath(
              command.payload.workspace.path,
              pathOptions,
            );
            workspace = dependencies.workspaces.create(
              workspaceSchema.parse({
                id: workspaceId,
                projectId: project.id,
                type: 'shared',
                path,
                cleanupState: 'active',
              }),
            );
          } else {
            if (!dependencies.git) {
              throw new CommandError(
                'invalid_command',
                'Git worktree support is unavailable',
              );
            }
            const [repositoryPath, projectPath, worktreePath] =
              await Promise.all([
                resolveWorkspacePath(
                  command.payload.workspace.repositoryPath,
                  pathOptions,
                ),
                resolveWorkspacePath(project.repositoryPath, pathOptions),
                resolveWorkspacePath(command.payload.workspace.path, {
                  ...pathOptions,
                  allowMissingLeaf: true,
                }),
              ]);
            if (repositoryPath !== projectPath) {
              throw new CommandError(
                'invalid_command',
                'Worktree repository does not match the selected project',
              );
            }
            try {
              await dependencies.git.createWorktree({
                repositoryPath,
                worktreePath,
                branch: command.payload.workspace.branch,
                startPoint: command.payload.workspace.startPoint,
              });
            } catch (error) {
              throw new CommandError(
                'workspace_preserved',
                'Git worktree creation did not complete; filesystem state was preserved',
                error instanceof Error ? { message: error.message } : undefined,
              );
            }
            workspace = dependencies.workspaces.create(
              workspaceSchema.parse({
                id: workspaceId,
                projectId: project.id,
                type: 'worktree',
                path: worktreePath,
                gitBranch: command.payload.workspace.branch,
                gitWorktreePath: worktreePath,
                owner: 'mesh',
                cleanupState: 'active',
              }),
            );
          }
        } catch (error) {
          if (error instanceof CommandError) throw error;
          throw new CommandError(
            'invalid_command',
            'Workspace paths could not be resolved',
            error instanceof Error ? { message: error.message } : undefined,
          );
        }
      }
      if (workspace.projectId !== command.payload.projectId) {
        throw new CommandError(
          'invalid_command',
          'Workspace does not belong to the selected project',
        );
      }
      const now = (dependencies.now ?? (() => new Date().toISOString()))();
      const session = dependencies.sessions.create(
        sessionSchema.parse({
          id: (dependencies.createId ?? randomUUID)(),
          projectId: command.payload.projectId,
          workspaceId: workspace.id,
          title: command.payload.title,
          permissionMode: command.payload.permissionMode,
          lifecycleState: 'idle',
          createdAt: now,
          updatedAt: now,
        }),
      );
      const collision = dependencies.sessions
        .listByProject(session.projectId)
        .some(
          (candidate) =>
            candidate.id !== session.id &&
            workspace.type === 'shared' &&
            isLive(candidate) &&
            dependencies.workspaces.get(candidate.workspaceId)?.path ===
              workspace.path,
        );
      await dependencies.registry.create(session.id);
      return response(
        command.type,
        dependencies.sessions.get(session.id),
        collision
          ? [
              {
                code: 'shared_workspace_collision',
                message: 'Another live session uses this shared path',
              },
            ]
          : [],
      );
    }
    case 'session.resume': {
      assertBillingSafe(dependencies);
      const session = requireSession(dependencies, command.payload.sessionId);
      const workspace = requireWorkspace(
        dependencies,
        command.payload.workspaceId,
      );
      if (workspace.projectId !== session.projectId) {
        throw new CommandError(
          'invalid_command',
          'Workspace does not belong to the selected project',
        );
      }
      if (!session.claudeResumeId) {
        throw new CommandError(
          'invalid_session_state',
          'Session has no Claude resume ID',
        );
      }
      await dependencies.registry.resume(session.id, {
        workspaceId: workspace.id,
        permissionMode: command.payload.permissionMode,
      });
      return response(command.type, dependencies.sessions.get(session.id));
    }
    case 'session.prompt':
      await dependencies.registry.sendPrompt(
        command.payload.sessionId,
        command.payload.prompt,
      );
      return response(command.type, {
        accepted: true,
        sessionId: command.payload.sessionId,
      });
    case 'session.interrupt':
      await dependencies.registry.interrupt(command.payload.sessionId);
      return response(command.type, {
        accepted: true,
        sessionId: command.payload.sessionId,
      });
    case 'permission.decide': {
      const projects = dependencies.projects.list();
      const sessions = projects.flatMap((project) =>
        dependencies.sessions.listByProject(project.id),
      );
      const pendingById = new Map<
        string,
        ReturnType<EventRepository['after']>[number]
      >();
      for (const event of sessions.flatMap((session) =>
        dependencies.events.after(session.id, 0),
      )) {
        if (event.type === 'permission.requested')
          pendingById.set(event.payload.permissionId, event);
        if (event.type === 'permission.resolved')
          pendingById.delete(event.payload.permissionId);
      }
      const pending = pendingById.get(command.payload.permissionId);
      if (!pending)
        throw new CommandError(
          'invalid_session_state',
          'Permission request is not pending',
        );
      await dependencies.registry.resolvePermission(
        pending.sessionId,
        command.payload.permissionId,
        command.payload.decision,
      );
      return response(command.type, {
        accepted: true,
        permissionId: command.payload.permissionId,
      });
    }
    case 'session.archive': {
      const session = requireSession(dependencies, command.payload.sessionId);
      if (isLive(session)) {
        throw new CommandError(
          'invalid_session_state',
          'A live session cannot be archived',
        );
      }
      return response(
        command.type,
        dependencies.sessions.archive(command.payload.sessionId),
        [
          {
            code: 'workspace_preserved',
            message: 'Archiving preserves the workspace',
          },
        ],
      );
    }
    case 'session.delete': {
      const session = requireSession(dependencies, command.payload.sessionId);
      if (isLive(session)) {
        throw new CommandError(
          'invalid_session_state',
          'A live session cannot be deleted',
        );
      }
      const workspace = requireWorkspace(dependencies, session.workspaceId);
      const warnings: Array<{ code: string; message: string }> = [];
      if (workspace.type === 'worktree') {
        const project = requireProject(dependencies, session.projectId);
        if (!dependencies.git || !dependencies.pathOptions) {
          throw new CommandError(
            'workspace_preserved',
            'Worktree cleanup support is unavailable; the session was preserved',
          );
        }
        let repositoryPath: AbsolutePath;
        try {
          repositoryPath = await resolveWorkspacePath(
            project.repositoryPath,
            dependencies.pathOptions,
          );
        } catch (error) {
          throw new CommandError(
            'workspace_preserved',
            'The project repository path could not be verified; the session was preserved',
            error instanceof Error ? { message: error.message } : undefined,
          );
        }
        const removal = await dependencies.git.removeOwnedWorktree({
          confirmed: true,
          repositoryPath,
          workspace,
          sessions: dependencies.sessions.listByProject(session.projectId, {
            includeArchived: true,
          }),
        });
        if (removal.removed === false) {
          throw new CommandError(
            'workspace_preserved',
            `Worktree was preserved: ${removal.reason}`,
            { reason: removal.reason },
          );
        }
        dependencies.workspaces.markCleaned(workspace.id);
      } else {
        warnings.push({
          code: 'workspace_preserved',
          message: 'The shared workspace was preserved',
        });
      }
      dependencies.sessions.remove(session.id);
      return response(
        command.type,
        { deleted: true, sessionId: session.id },
        warnings,
      );
    }
    case 'layout.save':
      return response(command.type, dependencies.layouts.save(command.payload));
  }
};

export const executeCommand = async (
  input: unknown,
  dependencies: CommandDependencies,
): Promise<CommandResponse> => {
  const command = commandSchema.parse(input);
  if ('idempotencyKey' in command) {
    if (
      [
        'task.create',
        'task.edit',
        'task.reorder',
        'task.block',
        'task.unblock',
        'task.transition',
      ].includes(command.command.type)
    ) {
      return executeMutation(
        command.command,
        dependencies,
        command.idempotencyKey,
      );
    }
    return dependencies.commands.executeOnce(command.idempotencyKey, () =>
      executeMutation(command.command, dependencies),
    );
  }

  switch (command.type) {
    case 'projects.discover':
      return response(command.type, await discoverProjects(dependencies));
    case 'sessions.discover':
      return response(command.type, {
        sessions: await discoverSessions(
          dependencies,
          command.payload.projectId,
        ),
      });
    case 'session.history':
      return response(
        command.type,
        sessionHistorySchema.parse({
          protocolVersion: 1,
          sessionId: command.payload.sessionId,
          events: dependencies.events.after(
            command.payload.sessionId,
            command.payload.afterSequence ?? 0,
          ),
        }),
      );
    case 'session.diagnostics':
      return response(
        command.type,
        sessionDiagnosticsSchema.parse({
          protocolVersion: 1,
          sessionId: command.payload.sessionId,
          diagnostics: dependencies.diagnostics.list(command.payload.sessionId),
        }),
      );
  }
};
