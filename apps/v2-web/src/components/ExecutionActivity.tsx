import type {
  ProjectEventCursors,
  ResolvedSkillSnapshot,
  RuntimeEvent,
  WorkerExecution,
} from '@mesh/v2-contracts';

export type ChildActivity = {
  id: string;
  title: string;
  lifecycle: 'running' | 'completed' | 'failed' | 'interrupted';
};

function skillOutcome(skill: ResolvedSkillSnapshot) {
  if (skill.resolution.kind === 'mesh-native-fallback') {
    return 'Preferred skill fallback';
  }
  if (skill.resolution.kind === 'unavailable') {
    return 'Required skill unavailable';
  }
  return 'Skill resolved';
}

function runtimeActivityLabel(activity: RuntimeEvent) {
  switch (activity.type) {
    case 'worker_execution.output':
      return activity.payload.text;
    case 'worker_execution.child_started':
      return activity.payload.title;
    case 'worker_execution.child_finished':
      return `Child ${activity.payload.childId} ${activity.payload.outcome}`;
    case 'worker_execution.adapter_failed':
      return `Execution failed: ${activity.payload.message}`;
    case 'worker_execution.completed':
      return 'Execution completed';
  }
}

function ChildActivityTree({
  activities,
  label,
}: {
  activities: readonly ChildActivity[];
  label?: string;
}) {
  if (activities.length === 0) return <p>No child activity reported.</p>;
  return (
    <ul aria-label={label}>
      {activities.map((activity) => (
        <li key={activity.id}>
          <span>{activity.title}</span> <span>{activity.lifecycle}</span>
        </li>
      ))}
    </ul>
  );
}

export function ExecutionActivity({
  execution,
  childActivities = [],
  diagnosticId,
  runtimeActivity = [],
  projectCursors,
}: {
  execution: WorkerExecution;
  childActivities?: readonly ChildActivity[];
  diagnosticId?: string;
  runtimeActivity?: readonly RuntimeEvent[];
  projectCursors: ProjectEventCursors;
}) {
  const headingId = `execution-${execution.id}`;
  return (
    <article className="v2-execution" aria-labelledby={headingId}>
      <header>
        <h3 id={headingId}>{execution.assignment.title}</h3>
        <p role="status">{execution.lifecycle}</p>
      </header>
      <section aria-label="Skill outcomes">
        <h4>Skill outcomes</h4>
        <ul>
          {execution.resolvedSkills.map((skill) => (
            <li key={`${skill.mode}-${skill.requested.id}`}>
              <strong>{skill.requested.id}</strong>:{' '}
              <span>{skillOutcome(skill)}</span>
            </li>
          ))}
        </ul>
      </section>
      <section aria-label={`Child activity for ${execution.assignment.title}`}>
        <h4>Child activity</h4>
        <ChildActivityTree
          activities={childActivities}
          label={`Child activity for ${execution.assignment.title}`}
        />
      </section>
      <section
        aria-label={`Runtime activity for ${execution.assignment.title}`}
      >
        <h4>Runtime activity</h4>
        {runtimeActivity.length === 0 ? (
          <p>No runtime activity reported.</p>
        ) : (
          <ul aria-label={`Runtime activity for ${execution.assignment.title}`}>
            {runtimeActivity.map((activity) => (
              <li key={activity.id}>{runtimeActivityLabel(activity)}</li>
            ))}
          </ul>
        )}
      </section>
      <details>
        <summary>Diagnostics</summary>
        <dl>
          <div>
            <dt>Adapter ID</dt>
            <dd>{execution.adapterId}</dd>
          </div>
          <div>
            <dt>Opaque handle</dt>
            <dd>{execution.nativeHandle ?? 'None'}</dd>
          </div>
          <div>
            <dt>Raw diagnostic ID</dt>
            <dd>{diagnosticId ?? 'None'}</dd>
          </div>
          <div>
            <dt>Execution revision</dt>
            <dd>{execution.revision}</dd>
          </div>
          <div>
            <dt>Adapter cursor</dt>
            <dd>{execution.lastAdapterCursor}</dd>
          </div>
          <div>
            <dt>Domain cursor</dt>
            <dd>{projectCursors.domain}</dd>
          </div>
          <div>
            <dt>Runtime cursor</dt>
            <dd>{projectCursors.runtime}</dd>
          </div>
        </dl>
      </details>
    </article>
  );
}
