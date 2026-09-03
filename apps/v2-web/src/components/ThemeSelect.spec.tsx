import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ThemeSelect } from './ThemeSelect';

const media = (matches = true) => {
  let listener: ((event: MediaQueryListEvent) => void) | undefined;
  return {
    get matches() {
      return matches;
    },
    addEventListener: vi.fn(
      (_: 'change', next: (event: MediaQueryListEvent) => void) => {
        listener = next;
      },
    ),
    removeEventListener: vi.fn(),
    change(next: boolean) {
      matches = next;
      listener?.({ matches: next } as MediaQueryListEvent);
    },
  };
};

const storage = (value: string | null = null) => ({
  getItem: vi.fn(() => value),
  setItem: vi.fn(),
});

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe('ThemeSelect', () => {
  it('defaults to System and follows a dark system preference', () => {
    const preference = storage();
    const system = media(true);

    render(<ThemeSelect storage={preference} media={system} />);

    expect(screen.getByLabelText('Theme')).toHaveValue('system');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(system.addEventListener).toHaveBeenCalledTimes(1);
  });

  it('uses a valid stored preference and ignores system media changes', () => {
    const preference = storage('light');
    const system = media(true);

    render(<ThemeSelect storage={preference} media={system} />);
    system.change(false);

    expect(screen.getByLabelText('Theme')).toHaveValue('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(system.addEventListener).not.toHaveBeenCalled();
  });

  it('treats an invalid stored preference as System', () => {
    render(<ThemeSelect storage={storage('sepia')} media={media(false)} />);

    expect(screen.getByLabelText('Theme')).toHaveValue('system');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('persists a selected preference and updates the document theme', async () => {
    const user = userEvent.setup();
    const preference = storage();

    render(<ThemeSelect storage={preference} media={media()} />);
    await user.selectOptions(screen.getByLabelText('Theme'), 'light');

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(preference.setItem).toHaveBeenCalledWith('mesh.v2.theme', 'light');
  });

  it('updates System when the media preference changes and removes its listener', () => {
    const system = media(false);
    const { unmount } = render(
      <ThemeSelect storage={storage()} media={system} />,
    );

    system.change(true);
    unmount();

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(system.removeEventListener).toHaveBeenCalledTimes(1);
  });
});
