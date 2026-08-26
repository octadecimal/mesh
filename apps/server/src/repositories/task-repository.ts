import {
  idSchema,
  taskSchema,
  type Task,
} from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';

type TaskRow = {
  id: string;
  project_id: string;
  title: string;
  description: string;
  acceptance_criteria_json: string;
  priority: string;
  rank: string;
  lifecycle_state: string;
  labels_json: string;
  notes: string;
  blocked_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

const toTask = (row: TaskRow): Task =>
  taskSchema.parse({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria_json),
    priority: row.priority,
    rank: row.rank,
    lifecycleState: row.lifecycle_state,
    labels: JSON.parse(row.labels_json),
    notes: row.notes,
    blocked: JSON.parse(row.blocked_json),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

export class TaskRepository {
  private readonly insert;
  private readonly selectById;
  private readonly selectByProject;
  private readonly updateByRevision;

  constructor(private readonly database: Database) {
    this.insert = database.prepare(`
      INSERT INTO tasks (
        id, project_id, title, description, acceptance_criteria_json, priority,
        rank, lifecycle_state, labels_json, notes, blocked_json, revision,
        created_at, updated_at
      ) VALUES (
        @id, @projectId, @title, @description, @acceptanceCriteriaJson, @priority,
        @rank, @lifecycleState, @labelsJson, @notes, @blockedJson, @revision,
        @createdAt, @updatedAt
      )
    `);
    this.selectById = database.prepare('SELECT * FROM tasks WHERE id = ?');
    this.selectByProject = database.prepare(
      'SELECT * FROM tasks WHERE project_id = ? ORDER BY lifecycle_state, rank, id',
    );
    this.updateByRevision = database.prepare(`
      UPDATE tasks SET
        project_id = @projectId,
        title = @title,
        description = @description,
        acceptance_criteria_json = @acceptanceCriteriaJson,
        priority = @priority,
        rank = @rank,
        lifecycle_state = @lifecycleState,
        labels_json = @labelsJson,
        notes = @notes,
        blocked_json = @blockedJson,
        revision = @revision,
        created_at = @createdAt,
        updated_at = @updatedAt
      WHERE id = @id AND revision = @expectedRevision
    `);
  }

  create(task: Task): Task {
    const value = taskSchema.parse(task);
    this.insert.run(this.toParameters(value));
    return value;
  }

  get(id: string): Task | undefined {
    const row = this.selectById.get(idSchema.parse(id)) as TaskRow | undefined;
    return row ? toTask(row) : undefined;
  }

  listByProject(projectId: string): Task[] {
    return (
      this.selectByProject.all(idSchema.parse(projectId)) as TaskRow[]
    ).map(toTask);
  }

  update(task: Task, expectedRevision: number): Task | undefined {
    const value = taskSchema.parse(task);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new TypeError('Expected task revision must be a positive integer');
    }
    const next = taskSchema.parse({ ...value, revision: expectedRevision + 1 });
    const result = this.updateByRevision.run({
      ...this.toParameters(next),
      expectedRevision,
    });
    return result.changes === 1 ? next : undefined;
  }

  private toParameters(task: Task) {
    return {
      ...task,
      acceptanceCriteriaJson: JSON.stringify(task.acceptanceCriteria),
      labelsJson: JSON.stringify(task.labels),
      blockedJson: JSON.stringify(task.blocked),
    };
  }
}
