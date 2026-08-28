import type { ResolvedSkillSnapshot, WorkerExecution } from '@mesh/v2-contracts';

export type ChildActivity = {
  id: string;
  title: string;
  lifecycle: 'running' | 'completed' | 'failed' | 'interrupted';
  children?: readonly ChildActivity[];
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
          {activity.children ? <ChildActivityTree activities={activity.children} /> : null}
        </li>
      ))}
    </ul>
  );
}

export function ExecutionActivity({
  execution,
  childActivities = [],
  diagnosticId,
}: {
  execution: WorkerExecution;
  childActivities?: readonly ChildActivity[];
  diagnosticId?: string;
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
              <strong>{skill.requested.id}</strong>: <span>{skillOutcome(skill)}</span>
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
      <details>
        <summary>Diagnostics</summary>
        <dl>
          <div><dt>Adapter ID</dt><dd>{execution.adapterId}</dd></div>
          <div><dt>Opaque handle</dt><dd>{execution.nativeHandle ?? 'None'}</dd></div>
          <div><dt>Raw diagnostic ID</dt><dd>{diagnosticId ?? 'None'}</dd></div>
          <div><dt>Domain cursor</dt><dd>{execution.revision}</dd></div>
          <div><dt>Runtime cursor</dt><dd>{execution.lastRuntimeSequence}</dd></div>
        </dl>
      </details>
    </article>
  );
}
