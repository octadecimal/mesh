import {
  idSchema,
  taskTransitionSchema,
  type TaskTransition,
} from '@mesh-session-platform/contracts';

import type { Database } from '../db/database.js';

type TaskTransitionRow = {
  id: string;
  task_id: string;
  command_id: string;
  previous_state: string;
  next_state: string;
  actor_json: string;
  reason: string | null;
  occurred_at: string;
};

const toTaskTransition = (row: TaskTransitionRow): TaskTransition =>
  taskTransitionSchema.parse({
    id: row.id,
    taskId: row.task_id,
    commandId: row.command_id,
    previousState: row.previous_state,
    nextState: row.next_state,
    actor: JSON.parse(row.actor_json),
    reason: row.reason,
    occurredAt: row.occurred_at,
  });

export class TaskTransitionRepository {
  private readonly insert;
  private readonly selectByTask;

  constructor(private readonly database: Database) {
    this.insert = database.prepare(`
      INSERT INTO task_transitions (
        id, task_id, command_id, previous_state, next_state, actor_json, reason,
        occurred_at
      ) VALUES (
        @id, @taskId, @commandId, @previousState, @nextState, @actorJson, @reason,
        @occurredAt
      )
    `);
    this.selectByTask = database.prepare(
      'SELECT * FROM task_transitions WHERE task_id = ? ORDER BY occurred_at, id',
    );
  }

  append(transition: TaskTransition): TaskTransition {
    const value = taskTransitionSchema.parse(transition);
    this.insert.run({ ...value, actorJson: JSON.stringify(value.actor) });
    return value;
  }

  listByTask(taskId: string): TaskTransition[] {
    return (
      this.selectByTask.all(idSchema.parse(taskId)) as TaskTransitionRow[]
    ).map(toTaskTransition);
  }
}
