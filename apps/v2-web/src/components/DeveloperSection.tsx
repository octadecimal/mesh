import { useEffect, useId, useMemo, useRef, useState } from 'react';

import type {
  BoardTaskCard,
  DeveloperAttempt,
  DeveloperReportRecord,
  ProjectEventCursors,
  ResolvedWorkerProfileSnapshot,
  RuntimeEvent,
  WorkerExecution,
} from '@mesh/v2-contracts';

import { ExecutionActivity, type ChildActivity } from './ExecutionActivity';
import type { PlanningConnection } from './PlanningPane';

export type DeveloperActivityProjection = {
  childActivities?: readonly ChildActivity[];
  diagnosticId?: string;
  runtimeActivity?: readonly RuntimeEvent[];
};

const controllingLifecycles = new Set<DeveloperAttempt['lifecycle']>([
  'reserved',
  'provisioning',
  'active',
  'interrupted',
]);

const lifecycleLabel = (lifecycle: string) =>
  lifecycle
    .split('_')
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(' ');

const exactDeveloperProfile = (profile: ResolvedWorkerProfileSnapshot) =>
  profile.document.spec.assignmentKinds.length === 1 &&
  profile.document.spec.assignmentKinds[0] === 'developer_task' &&
  profile.document.spec.outputSchema === 'mesh.dev/developer-report/v1';

function commandDisabledReason(
  connection: PlanningConnection,
  submitting: boolean,
) {
  if (connection.status !== 'ready') {
    return connection.status === 'loading'
      ? 'Wait for the current project snapshot.'
      : connection.message;
  }
  if (submitting) return 'A Developer command is in progress.';
  return undefined;
}

function WorkspaceTruth({ attempt }: { attempt: DeveloperAttempt }) {
  const { workspace } = attempt;
  return (
    <section aria-label={`Workspace for attempt ${attempt.ordinal}`}>
      <h5>Workspace</h5>
      <p>
        {lifecycleLabel(workspace.lifecycle)} · head{' '}
        {workspace.observedHead?.slice(0, 7) ?? 'not observed'} · dirty:{' '}
        {workspace.observedDirty === null
          ? 'not observed'
          : workspace.observedDirty
            ? 'yes'
            : 'no'}
      </p>
      <p>{workspace.path}</p>
      {workspace.failure ? <p>{workspace.failure.message}</p> : null}
    </section>
  );
}

function ReportEvidence({ record }: { record: DeveloperReportRecord }) {
  const { report } = record;
  if (report.disposition === 'blocked') {
    return (
      <section aria-label="Developer blocker report">
        <h5>Blocker</h5>
        <p>{report.blocker}</p>
        {report.evidence.length > 0 ? (
          <ul>
            {report.evidence.map((item, index) => (
              <li key={`${item.summary}-${index}`}>{item.summary}</li>
            ))}
          </ul>
        ) : null}
        <p>Suggested next action: {report.suggestedNextAction}</p>
        <p>The workspace will be preserved for recovery and operator review.</p>
      </section>
    );
  }
  return (
    <section aria-label="Developer completion report">
      <h5>Completion evidence</h5>
      <h6>Acceptance criteria</h6>
      {report.criterionCoverage.length === 0 ? (
        <p>No criterion coverage reported.</p>
      ) : (
        <ul>
          {report.criterionCoverage.map((coverage) => (
            <li key={coverage.index}>
              {coverage.text}
              {coverage.evidence.map((item, index) => (
                <span key={`${item.summary}-${index}`}> · {item.summary}</span>
              ))}
            </li>
          ))}
        </ul>
      )}
      <h6>Requirement coverage</h6>
      {report.requirementCoverage.length === 0 ? (
        <p>No requirement coverage reported.</p>
      ) : (
        <ul>
          {report.requirementCoverage.map((coverage) => (
            <li key={`${coverage.recordId}-${coverage.recordRevision}`}>
              Requirement {coverage.recordId} · revision{' '}
              {coverage.recordRevision}
              {coverage.evidence.map((item, index) => (
                <span key={`${item.summary}-${index}`}> · {item.summary}</span>
              ))}
            </li>
          ))}
        </ul>
      )}
      <h6>Changed artifacts</h6>
      {report.changedArtifacts.length === 0 ? (
        <p>No changed artifacts reported.</p>
      ) : (
        <ul>
          {report.changedArtifacts.map((artifact) => (
            <li key={artifact.path}>
              {artifact.path} · {artifact.summary}
            </li>
          ))}
        </ul>
      )}
      <h6>Verification</h6>
      <ul>
        {report.verification.map((verification) => (
          <li key={verification.command}>
            {verification.command} — {verification.passed ? 'passed' : 'failed'}
            {verification.evidence.map((item, index) => (
              <span key={`${item.summary}-${index}`}> · {item.summary}</span>
            ))}
          </li>
        ))}
      </ul>
      {report.unresolvedConcerns.length > 0 ? (
        <>
          <h6>Unresolved concerns</h6>
          <ul>
            {report.unresolvedConcerns.map((concern) => (
              <li key={concern}>{concern}</li>
            ))}
          </ul>
        </>
      ) : null}
      <p>
        Reported workspace · head {report.workspace.headCommit.slice(0, 7)} ·
        dirty: {report.workspace.dirty ? 'yes' : 'no'}
      </p>
    </section>
  );
}

function AttemptHistory({
  attempt,
  reports,
  executions,
  activityByExecutionId,
  projectCursors,
  connection,
  submitting,
  onInterrupt,
  onReplace,
}: {
  attempt: DeveloperAttempt;
  reports: readonly DeveloperReportRecord[];
  executions: readonly WorkerExecution[];
  activityByExecutionId: Readonly<Record<string, DeveloperActivityProjection>>;
  projectCursors: ProjectEventCursors;
  connection: PlanningConnection;
  submitting: boolean;
  onInterrupt: (attempt: DeveloperAttempt) => void;
  onReplace: (attempt: DeveloperAttempt) => void;
}) {
  const sharedDisabled = commandDisabledReason(connection, submitting);
  const executionById = new Map(
    executions.map((execution) => [execution.id, execution]),
  );
  const controllingExecution = attempt.controllingExecutionId
    ? executionById.get(attempt.controllingExecutionId)
    : undefined;
  const interruptReason =
    sharedDisabled ??
    (controllingExecution?.lifecycle !== 'running'
      ? 'The controlling execution is not running.'
      : undefined);
  const replaceReason =
    sharedDisabled ??
    (controllingExecution?.lifecycle !== 'interrupted'
      ? 'The controlling execution is not interrupted.'
      : attempt.workspace.lifecycle !== 'ready' || attempt.workspace.failure
        ? 'The managed workspace is not ready for replacement.'
        : undefined);
  const reportById = new Map(reports.map((report) => [report.id, report]));

  return (
    <article
      className="v2-developer-attempt"
      aria-labelledby={`developer-attempt-${attempt.id}`}
    >
      <header>
        <h4 id={`developer-attempt-${attempt.id}`}>
          Attempt {attempt.ordinal}
        </h4>
        <p role="status" aria-label="Developer attempt state">
          {lifecycleLabel(attempt.lifecycle)}
        </p>
      </header>
      <p>Attempt revision {attempt.revision}</p>
      {attempt.attention ? (
        <p className="v2-developer-attention">
          Attention required: {attempt.attention.message}
        </p>
      ) : null}
      <WorkspaceTruth attempt={attempt} />
      {attempt.executionIds.length === 0 ? (
        <p>No Developer execution has been attached yet.</p>
      ) : (
        <ol
          className="v2-developer-executions"
          aria-label={`Executions for attempt ${attempt.ordinal}`}
        >
          {attempt.executionIds.map((id, index) => {
            const execution = executionById.get(id);
            if (!execution) {
              return (
                <li key={id}>
                  Execution {index + 1} is unavailable in current project truth.
                </li>
              );
            }
            const activity = activityByExecutionId[id];
            const replacedExecutionIndex = execution.replacementForExecutionId
              ? attempt.executionIds.indexOf(
                  execution.replacementForExecutionId,
                )
              : -1;
            return (
              <li key={id}>
                <h5>Execution {index + 1}</h5>
                {execution.replacementForExecutionId ? (
                  <p>
                    Replaces execution{' '}
                    {replacedExecutionIndex >= 0
                      ? replacedExecutionIndex + 1
                      : execution.replacementForExecutionId}
                  </p>
                ) : null}
                <ExecutionActivity
                  execution={execution}
                  childActivities={activity?.childActivities}
                  diagnosticId={activity?.diagnosticId}
                  runtimeActivity={activity?.runtimeActivity}
                  projectCursors={projectCursors}
                />
              </li>
            );
          })}
        </ol>
      )}
      {attempt.lifecycle === 'active' ? (
        <>
          <button
            type="button"
            disabled={interruptReason !== undefined}
            aria-describedby={
              interruptReason
                ? `interrupt-attempt-reason-${attempt.id}`
                : undefined
            }
            onClick={() => {
              if (!interruptReason) onInterrupt(attempt);
            }}
          >
            Interrupt attempt {attempt.ordinal}
          </button>
          {interruptReason ? (
            <p id={`interrupt-attempt-reason-${attempt.id}`}>
              {interruptReason}
            </p>
          ) : null}
        </>
      ) : null}
      {attempt.lifecycle === 'interrupted' ? (
        <>
          <button
            type="button"
            disabled={replaceReason !== undefined}
            aria-describedby={
              replaceReason ? `replace-attempt-reason-${attempt.id}` : undefined
            }
            onClick={() => {
              if (!replaceReason) onReplace(attempt);
            }}
          >
            Replace attempt {attempt.ordinal} execution
          </button>
          {replaceReason ? (
            <p id={`replace-attempt-reason-${attempt.id}`}>{replaceReason}</p>
          ) : null}
        </>
      ) : null}
      {attempt.reportIds.map((id) => {
        const report = reportById.get(id);
        return report ? (
          <ReportEvidence key={id} record={report} />
        ) : (
          <p key={id}>Report {id} is unavailable.</p>
        );
      })}
    </article>
  );
}

export function DeveloperSection({
  card,
  attempts,
  reports,
  executions,
  profiles,
  projectCursors,
  activityByExecutionId,
  connection,
  submitting,
  error,
  onStart,
  onInterrupt,
  onReplace,
}: {
  card: BoardTaskCard;
  attempts: readonly DeveloperAttempt[];
  reports: readonly DeveloperReportRecord[];
  executions: readonly WorkerExecution[];
  profiles: readonly ResolvedWorkerProfileSnapshot[];
  projectCursors: ProjectEventCursors;
  activityByExecutionId: Readonly<Record<string, DeveloperActivityProjection>>;
  connection: PlanningConnection;
  submitting: boolean;
  error?: string;
  onStart: (profile: ResolvedWorkerProfileSnapshot) => void;
  onInterrupt: (attempt: DeveloperAttempt) => void;
  onReplace: (attempt: DeveloperAttempt) => void;
}) {
  const compatibleProfiles = useMemo(
    () => profiles.filter(exactDeveloperProfile),
    [profiles],
  );
  const [profileKey, setProfileKey] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);
  const startReasonId = useId();
  const controllingAttempt = attempts.find((attempt) =>
    controllingLifecycles.has(attempt.lifecycle),
  );
  const selectedProfile =
    compatibleProfiles.find(
      (profile) =>
        `${profile.profileId}:${profile.profileRevision}` === profileKey,
    ) ?? compatibleProfiles[0];
  const startDisabledReason =
    commandDisabledReason(connection, submitting) ??
    (card.readiness.state !== 'actionable'
      ? 'Task is not actionable.'
      : controllingAttempt
        ? 'This task already has a controlling Developer attempt.'
        : !selectedProfile
          ? 'No compatible approved Developer profile is available.'
          : undefined);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  return (
    <section
      className="v2-developer-section"
      aria-label={`Developer for ${card.title}`}
    >
      <h4>Developer</h4>
      {error ? (
        <div ref={errorRef} tabIndex={-1} role="alert" aria-live="assertive">
          {error}
        </div>
      ) : null}
      <form
        className="v2-developer-start"
        onSubmit={(event) => {
          event.preventDefault();
          if (!startDisabledReason && selectedProfile) onStart(selectedProfile);
        }}
      >
        <label htmlFor={`developer-profile-${card.taskId}`}>
          Developer profile
        </label>
        <select
          id={`developer-profile-${card.taskId}`}
          value={
            selectedProfile
              ? `${selectedProfile.profileId}:${selectedProfile.profileRevision}`
              : ''
          }
          disabled={startDisabledReason !== undefined}
          onChange={(event) => setProfileKey(event.target.value)}
        >
          {compatibleProfiles.length === 0 ? (
            <option value="">No compatible profiles</option>
          ) : null}
          {compatibleProfiles.map((profile) => (
            <option
              key={`${profile.profileId}:${profile.profileRevision}`}
              value={`${profile.profileId}:${profile.profileRevision}`}
            >
              {profile.document.metadata.displayName} · revision{' '}
              {profile.profileRevision}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={startDisabledReason !== undefined}
          aria-describedby={startDisabledReason ? startReasonId : undefined}
        >
          Start Developer attempt
        </button>
        {startDisabledReason ? (
          <p id={startReasonId}>{startDisabledReason}</p>
        ) : null}
      </form>
      {attempts.length === 0 ? (
        <p>No Developer attempts yet.</p>
      ) : (
        <div className="v2-developer-attempts">
          {[...attempts]
            .sort((left, right) => left.ordinal - right.ordinal)
            .map((attempt) => (
              <AttemptHistory
                key={attempt.id}
                attempt={attempt}
                reports={reports}
                executions={executions}
                activityByExecutionId={activityByExecutionId}
                projectCursors={projectCursors}
                connection={connection}
                submitting={submitting}
                onInterrupt={onInterrupt}
                onReplace={onReplace}
              />
            ))}
        </div>
      )}
    </section>
  );
}
