import type { DockviewApi } from 'dockview-react';
import type { SavedLayout } from '@mesh-session-platform/contracts';
import { vi } from 'vitest';

import {
  installTwoGroupPolicy,
  openSessionPanel,
  restoreSavedLayout,
} from './layout-controller';

describe('Dockview layout controller', () => {
  it('restores the saved Dockview JSON, prunes deleted sessions, caps groups, and opens the selected session', () => {
    const dockview = fakeDockview([
      ['s1'],
      ['deleted'],
      ['s2'],
    ]);
    const saved = {
      id: 'layout-1',
      dockview: { saved: 'dockview-json' },
      visiblePanels: ['s1', 'deleted', 's2'],
      updatedAt: '2026-08-24T00:00:00.000Z',
    } as SavedLayout;

    restoreSavedLayout(
      dockview.api,
      saved,
      sessions,
      's3',
    );

    expect(dockview.fromJSON).toHaveBeenCalledWith(saved.dockview);
    expect(dockview.api.groups).toHaveLength(2);
    expect(dockview.api.panels.map(({ id }) => id)).toEqual(['s1', 's2', 's3']);
    expect(dockview.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 's3',
        component: 'session',
        params: { sessionId: 's3' },
      }),
    );
    expect(Object.keys(dockview.addPanel.mock.calls[0][0].params)).toEqual(['sessionId']);
  });

  it('turns a programmatic third-group request into a tab in an existing group', () => {
    const dockview = fakeDockview([['s1'], ['s2']]);

    openSessionPanel(dockview.api, sessions[2], { split: true });

    expect(dockview.api.groups).toHaveLength(2);
    expect(dockview.api.groups[1].panels.map(({ id }) => id)).toContain('s3');
  });

  it('turns drag and split attempts beyond two groups into tabs', () => {
    const dockview = fakeDockview([['s1'], ['s2']]);
    const policy = installTwoGroupPolicy(dockview.api);
    const preventDefault = vi.fn();

    dockview.fireWillDrop({
      position: 'right',
      panel: dockview.api.getPanel('s1'),
      group: dockview.api.groups[1],
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(dockview.api.groups.length).toBeLessThanOrEqual(2);
    expect(dockview.api.groups.flatMap(({ panels }) => panels.map(({ id }) => id))).toContain('s1');
    policy.dispose();
  });
});

const sessions = [
  { id: 's1', title: 'Session A' },
  { id: 's2', title: 'Session B' },
  { id: 's3', title: 'Session C' },
];

function fakeDockview(initialGroups: string[][]) {
  const willDropListeners: Array<(event: any) => void> = [];
  const addGroupListeners: Array<() => void> = [];
  const api: any = {
    groups: [],
    panels: [],
    activeGroup: undefined,
    fromJSON: vi.fn(),
    toJSON: vi.fn(() => ({ grid: { root: {}, height: 1, width: 1, orientation: 'HORIZONTAL' }, panels: {} })),
    getPanel(id: string) {
      return api.panels.find((panel: any) => panel.id === id);
    },
    removePanel(panel: any) {
      api.panels = api.panels.filter((candidate: any) => candidate !== panel);
      for (const group of api.groups) group.panels = group.panels.filter((candidate: any) => candidate !== panel);
      api.groups = api.groups.filter((group: any) => group.panels.length > 0);
    },
    removeGroup(group: any) {
      api.groups = api.groups.filter((candidate: any) => candidate !== group);
    },
    addPanel: vi.fn((options: any) => {
      const panel = makePanel(options.id, options.params);
      api.panels.push(panel);
      const reference = options.position?.referenceGroup;
      let target = reference ?? api.activeGroup ?? api.groups.at(-1);
      if (!target || options.position?.direction === 'right') {
        target = { id: `g${api.groups.length + 1}`, panels: [] };
        api.groups.push(target);
      }
      target.panels.push(panel);
      api.activeGroup = target;
      return panel;
    }),
    onWillDrop(listener: (event: any) => void) {
      willDropListeners.push(listener);
      return { dispose: () => willDropListeners.splice(willDropListeners.indexOf(listener), 1) };
    },
    onDidAddGroup(listener: () => void) {
      addGroupListeners.push(listener);
      return { dispose: () => addGroupListeners.splice(addGroupListeners.indexOf(listener), 1) };
    },
  };

  const makePanel = (id: string, params = { sessionId: id }) => {
    const panel: any = {
      id,
      params,
      api: {
        component: 'session',
        getParameters: () => params,
        setActive: vi.fn(),
        moveTo: ({ group }: any) => {
          for (const candidate of api.groups) {
            candidate.panels = candidate.panels.filter((item: any) => item !== panel);
          }
          group.panels.push(panel);
          api.groups = api.groups.filter((candidate: any) => candidate.panels.length > 0);
          api.activeGroup = group;
        },
      },
    };
    return panel;
  };

  for (const [index, ids] of initialGroups.entries()) {
    const group: any = { id: `g${index + 1}`, panels: [] };
    for (const id of ids) {
      const panel = makePanel(id);
      group.panels.push(panel);
      api.panels.push(panel);
    }
    api.groups.push(group);
  }
  api.activeGroup = api.groups.at(-1);

  return {
    api: api as DockviewApi,
    addPanel: api.addPanel as ReturnType<typeof vi.fn>,
    fromJSON: api.fromJSON as ReturnType<typeof vi.fn>,
    fireWillDrop: (event: any) => willDropListeners.forEach((listener) => listener(event)),
    fireAddGroup: () => addGroupListeners.forEach((listener) => listener()),
  };
}
