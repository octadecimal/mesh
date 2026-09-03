import { useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'mesh.v2.theme';

export const resolvedTheme = (
  preference: ThemePreference,
  prefersDark: boolean,
) => (preference === 'system' ? (prefersDark ? 'dark' : 'light') : preference);

type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>;
type ThemeMedia = Pick<
  MediaQueryList,
  'matches' | 'addEventListener' | 'removeEventListener'
>;

const preferenceFrom = (storage: ThemeStorage): ThemePreference => {
  const value = storage.getItem(THEME_STORAGE_KEY);
  return value === 'light' || value === 'dark' || value === 'system'
    ? value
    : 'system';
};

const unavailableMedia: ThemeMedia = {
  matches: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

export function ThemeSelect({
  storage = window.localStorage,
  media = window.matchMedia?.('(prefers-color-scheme: dark)') ??
    unavailableMedia,
}: {
  storage?: ThemeStorage;
  media?: ThemeMedia;
}) {
  const [preference, setPreference] = useState(() => preferenceFrom(storage));

  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolvedTheme(
        preference,
        media.matches,
      );
    };
    apply();
    if (preference !== 'system') return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [media, preference]);

  return (
    <label>
      Theme
      <select
        value={preference}
        onChange={(event) => {
          const next = event.target.value as ThemePreference;
          setPreference(next);
          storage.setItem(THEME_STORAGE_KEY, next);
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
