import { useState, type FormEvent } from 'react';

import type { SelectorViewModel } from './shell-state';

export function ProjectSelector({
  model,
  onAddAndSelectProject,
  onSelectProject,
  v1GuidanceHref = '/docs/development/session-platform.md',
}: {
  model: SelectorViewModel;
  onAddAndSelectProject: (repositoryPath: string) => void;
  onSelectProject: (projectId: string) => void;
  v1GuidanceHref?: string;
}) {
  const [repositoryPath, setRepositoryPath] = useState('');
  const [validationMessage, setValidationMessage] = useState<string>();
  const isReady = model.status === 'ready';
  const auditBarrierReason =
    model.status === 'ready' && model.snapshot.health.status === 'audit_barrier_tripped'
      ? model.snapshot.health.error.message
      : undefined;
  const disabledReason = !isReady
    ? model.status === 'loading'
      ? 'Projects are still loading.'
      : model.status === 'disconnected'
        ? 'Reconnect before adding a project.'
        : 'Resolve the current problem before adding a project.'
    : model.submitting
      ? 'Adding the project is in progress.'
      : auditBarrierReason
        ? auditBarrierReason
        : !model.registration.enabled
          ? model.registration.disabledReason
      : undefined;
  const projects =
    model.status === 'ready'
      ? model.snapshot.projects
      : model.status === 'error'
        ? model.snapshot?.projects ?? []
        : [];

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
        <h1 id="project-selector-heading">Choose a project</h1>
        <p>Add a repository to focus its foundation activity.</p>
      </header>
      {model.status === 'loading' ? <p role="status">Loading projects…</p> : null}
      {model.status === 'disconnected' ? <p role="status">{model.message}</p> : null}
      {model.status === 'error' ? <p role="alert">{model.message}</p> : null}
      {model.status === 'ready' ? (
        <section aria-label="System health">
          <p role="status">
            {model.snapshot.health.status === 'ok'
              ? 'System health: operational'
              : model.snapshot.health.error.message}
          </p>
        </section>
      ) : null}
      <form aria-label="Add and select a project" onSubmit={submit}>
        <label htmlFor="repository-path">Repository path</label>
        <input
          id="repository-path"
          value={repositoryPath}
          onChange={(event) => setRepositoryPath(event.target.value)}
          aria-describedby={disabledReason ? 'repository-path-reason' : undefined}
          disabled={disabledReason !== undefined}
        />
        <button type="submit" disabled={disabledReason !== undefined}>
          Add and select project
        </button>
        {disabledReason ? <p id="repository-path-reason">{disabledReason}</p> : null}
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
                <button type="button" onClick={() => onSelectProject(project.id)}>
                  Select {project.displayName}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {model.status === 'ready' ? (
        <section aria-labelledby="global-profiles-heading">
          <h2 id="global-profiles-heading">Approved global profiles</h2>
          {model.snapshot.globalProfiles.length === 0 ? (
            <p>No global profiles are approved.</p>
          ) : (
            <ul aria-label="Approved global profiles">
              {model.snapshot.globalProfiles.map((profile) => (
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
