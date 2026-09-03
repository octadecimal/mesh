import { describe, expect, it } from 'vitest';

import { appHref, parseAppRoute } from './routes';

describe('V2 application routes', () => {
  it.each([
    ['/', { page: 'inbox' }],
    ['/runs', { page: 'runs' }],
    ['/projects', { page: 'projects' }],
    [
      '/projects/project%2Fone',
      {
        page: 'project',
        projectId: 'project/one',
        artifact: 'overview',
      },
    ],
    [
      '/projects/project%2Fone/requirements',
      {
        page: 'project',
        projectId: 'project/one',
        artifact: 'requirements',
      },
    ],
    [
      '/projects/project%2Fone/plans',
      {
        page: 'project',
        projectId: 'project/one',
        artifact: 'plans',
      },
    ],
    [
      '/projects/project%2Fone/board',
      {
        page: 'project',
        projectId: 'project/one',
        artifact: 'board',
      },
    ],
    [
      '/projects/project%2Fone/runs',
      {
        page: 'project',
        projectId: 'project/one',
        artifact: 'runs',
      },
    ],
  ] as const)('parses %s', (pathname, route) => {
    expect(parseAppRoute(pathname)).toEqual(route);
    expect(appHref(route)).toBe(pathname);
  });

  it.each([
    [
      '/projects/p/board',
      '?task=T-21',
      {
        page: 'project',
        projectId: 'p',
        artifact: 'board',
        selectedId: 'T-21',
      },
    ],
    [
      '/projects/p/runs',
      '?run=run%2F21',
      {
        page: 'project',
        projectId: 'p',
        artifact: 'runs',
        selectedId: 'run/21',
      },
    ],
  ] as const)(
    'preserves a selected detail for %s%s',
    (pathname, search, route) => {
      expect(parseAppRoute(pathname, search)).toEqual(route);
      expect(appHref(route)).toBe(`${pathname}${search}`);
    },
  );

  it.each(['/unknown', '/projects/', '/projects/%E0%A4%A', '/projects/p/x'])(
    'rejects %s',
    (pathname) =>
      expect(parseAppRoute(pathname)).toEqual({ page: 'not_found', pathname }),
  );
});
