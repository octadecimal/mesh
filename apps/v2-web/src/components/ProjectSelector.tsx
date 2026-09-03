import { useState, type FormEvent } from 'react';

import type { SelectorViewModel } from './shell-state';

export function ProjectSelector({
  model,
  onAddAndSelectProject,
  onSelectProject,
  v1GuidanceHref,
  headingLevel: Heading = 'h1',
}: {
  model: SelectorViewModel;
  onAddAndSelectProject: (repositoryPath: string) => void;
  onSelectProject: (projectId: string) => void;
  v1GuidanceHref: string;
  headingLevel?: 'h1' | 'h2';
}) {
  const [repositoryPath, setRepositoryPath] = useState('');
  const [validationMessage, setValidationMessage] = useState<string>();
  const snapshot =
    model.status === 'ready' || model.status === 'error'
      ? model.snapshot
      : undefined;
  const auditBarrierReason =
    snapshot?.health.status === 'audit_barrier_tripped'
      ? snapshot.health.error.message
      : undefined;
  const disabledReason =
    model.status === 'loading'
      ? 'Projects are still loading.'
      : model.status === 'disconnected'
        ? 'Reconnect before adding a project.'
        : model.status === 'ready' && model.submitting
          ? 'Adding the project is in progress.'
          : auditBarrierReason
            ? auditBarrierReason
            : model.status === 'ready' || model.status === 'error'
              ? model.registration.enabled
                ? undefined
                : model.registration.disabledReason
              : undefined;
  const projects = snapshot?.projects ?? [];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = repositoryPath.trim();
    if (value.length === 0) {
      setValidationMessage('Enter a repository path.');
      return;
    }
    setValidationMessage(undefined);
    onAddAndSelectProject(value);
  }

  return (
    <section className="v2-selector" aria-labelledby="project-selector-heading">
      <header>
        <p className="v2-eyebrow">Mesh V2</p>
        <Heading id="project-selector-heading">Choose a project</Heading>
        <p>Add a repository to focus its foundation activity.</p>
      </header>
      {model.status === 'loading' ? (
        <p role="status">Loading projects…</p>
      ) : null}
      {model.status === 'disconnected' ? (
        <p role="status">{model.message}</p>
      ) : null}
      {model.status === 'error' ? <p role="alert">{model.message}</p> : null}
      {snapshot ? (
        <section aria-label="System health">
          <p role="status">
            {snapshot.health.status === 'ok'
              ? 'System health: operational'
              : snapshot.health.error.message}
          </p>
        </section>
      ) : null}
      <form aria-label="Add and select a project" onSubmit={submit}>
        <label htmlFor="repository-path">Repository path</label>
        <input
          id="repository-path"
          value={repositoryPath}
          onChange={(event) => setRepositoryPath(event.target.value)}
          aria-describedby={
            disabledReason ? 'repository-path-reason' : undefined
          }
          disabled={disabledReason !== undefined}
        />
        <button type="submit" disabled={disabledReason !== undefined}>
          Add and select project
        </button>
        {disabledReason ? (
          <p id="repository-path-reason">{disabledReason}</p>
        ) : null}
        {validationMessage ? <p role="alert">{validationMessage}</p> : null}
      </form>
      <section aria-labelledby="known-projects-heading">
        <h2 id="known-projects-heading">Known projects</h2>
        {projects.length === 0 ? (
          <p>No projects have been added yet.</p>
        ) : (
          <ul aria-label="Known projects">
            {projects.map((project) => (
              <li key={project.id}>
                <strong>{project.displayName}</strong>
                <span>{project.repositoryPath}</span>
                <button
                  type="button"
                  onClick={() => onSelectProject(project.id)}
                >
                  Select {project.displayName}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {snapshot ? (
        <section aria-labelledby="global-profiles-heading">
          <h2 id="global-profiles-heading">Approved global profiles</h2>
          {snapshot.globalProfiles.length === 0 ? (
            <p>No global profiles are approved.</p>
          ) : (
            <ul aria-label="Approved global profiles">
              {snapshot.globalProfiles.map((profile) => (
                <li key={profile.profileId}>
                  {profile.displayName} · revision {profile.approvedRevision}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      <a href={v1GuidanceHref}>V1 operating guidance</a>
    </section>
  );
}
