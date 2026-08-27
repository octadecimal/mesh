import {
  idSchema,
  taskDependencySchema,
  type TaskDependency,
} from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';

type TaskDependencyRow = {
  project_id: string;
  task_id: string;
  prerequisite_task_id: string;
  created_by_json: string;
  created_at: string;
};

const toDependency = (row: TaskDependencyRow): TaskDependency =>
  taskDependencySchema.parse({
    projectId: row.project_id,
    taskId: row.task_id,
    prerequisiteTaskId: row.prerequisite_task_id,
    createdBy: JSON.parse(row.created_by_json),
    createdAt: row.created_at,
  });

export class TaskDependencyRepository {
  constructor(private readonly database: Database) {}

  create(dependency: TaskDependency): TaskDependency {
    const value = taskDependencySchema.parse(dependency);
    this.database.prepare(`
      INSERT INTO task_dependencies (
        project_id, task_id, prerequisite_task_id, created_by_json, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      value.projectId,
      value.taskId,
      value.prerequisiteTaskId,
      JSON.stringify(value.createdBy),
      value.createdAt,
    );
    return value;
  }

  remove(taskId: string, prerequisiteTaskId: string): boolean {
    const result = this.database.prepare(`
      DELETE FROM task_dependencies
      WHERE task_id = ? AND prerequisite_task_id = ?
    `).run(idSchema.parse(taskId), idSchema.parse(prerequisiteTaskId));
    return result.changes === 1;
  }

  listByProject(projectId: string): TaskDependency[] {
    return this.list(
      'WHERE project_id = ? ORDER BY task_id, prerequisite_task_id',
      idSchema.parse(projectId),
    );
  }

  listPrerequisites(taskId: string): TaskDependency[] {
    return this.list(
      'WHERE task_id = ? ORDER BY prerequisite_task_id, task_id',
      idSchema.parse(taskId),
    );
  }

  listDependents(prerequisiteTaskId: string): TaskDependency[] {
    return this.list(
      'WHERE prerequisite_task_id = ? ORDER BY task_id, prerequisite_task_id',
      idSchema.parse(prerequisiteTaskId),
    );
  }

  private list(where: string, value: string): TaskDependency[] {
    return (this.database.prepare(`
      SELECT * FROM task_dependencies ${where}
    `).all(value) as TaskDependencyRow[]).map(toDependency);
  }
}
