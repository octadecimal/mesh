import type { ComponentProps } from 'react';

import { ProjectSelector } from './ProjectSelector';

type ProjectsPageProps = Omit<
  ComponentProps<typeof ProjectSelector>,
  'headingLevel'
>;

const countLabel = (count: number, singular: string) =>
  `${count} ${singular}${count === 1 ? '' : 's'}`;

export function ProjectsPage(props: ProjectsPageProps) {
  const snapshot =
    props.model.status === 'ready' || props.model.status === 'error'
      ? props.model.snapshot
      : undefined;

  return (
    <section className="v2-page" aria-labelledby="projects-heading">
      <header className="v2-page-heading">
        <div>
          <p className="v2-eyebrow">Repositories</p>
          <h1 id="projects-heading">Projects</h1>
        </div>
        {snapshot ? (
          <p>
            {countLabel(snapshot.projects.length, 'registered project')} ·{' '}
            {countLabel(
              snapshot.globalProfiles.length,
              'approved global profile',
            )}
          </p>
        ) : null}
      </header>
      <ProjectSelector {...props} headingLevel="h2" />
    </section>
  );
}
