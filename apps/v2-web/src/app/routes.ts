export type ProjectArtifact =
  | 'overview'
  | 'requirements'
  | 'plans'
  | 'board'
  | 'runs';

export type AppRoute =
  | { page: 'inbox' }
  | { page: 'runs' }
  | { page: 'projects' }
  | {
      page: 'project';
      projectId: string;
      artifact: ProjectArtifact;
      selectedId?: string;
    }
  | { page: 'not_found'; pathname: string };

const artifactPaths = new Set<ProjectArtifact>([
  'requirements',
  'plans',
  'board',
  'runs',
]);

export function parseAppRoute(pathname: string, search = ''): AppRoute {
  if (pathname === '/') return { page: 'inbox' };
  if (pathname === '/runs') return { page: 'runs' };
  if (pathname === '/projects') return { page: 'projects' };
  const match = /^\/projects\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
  if (!match) return { page: 'not_found', pathname };
  try {
    const projectId = decodeURIComponent(match[1]);
    const artifact = (match[2] ?? 'overview') as ProjectArtifact;
    if (!projectId || (artifact !== 'overview' && !artifactPaths.has(artifact))) {
      return { page: 'not_found', pathname };
    }
    const params = new URLSearchParams(search);
    const selectedId =
      artifact === 'board'
        ? params.get('task') ?? undefined
        : artifact === 'runs'
          ? params.get('run') ?? undefined
          : undefined;
    return selectedId
      ? { page: 'project', projectId, artifact, selectedId }
      : { page: 'project', projectId, artifact };
  } catch {
    return { page: 'not_found', pathname };
  }
}

export function appHref(route: Exclude<AppRoute, { page: 'not_found' }>) {
  if (route.page === 'inbox') return '/';
  if (route.page === 'runs') return '/runs';
  if (route.page === 'projects') return '/projects';
  const base = `/projects/${encodeURIComponent(route.projectId)}`;
  const path = route.artifact === 'overview' ? base : `${base}/${route.artifact}`;
  if (!route.selectedId) return path;
  const key = route.artifact === 'board' ? 'task' : route.artifact === 'runs' ? 'run' : null;
  return key ? `${path}?${key}=${encodeURIComponent(route.selectedId)}` : path;
}
