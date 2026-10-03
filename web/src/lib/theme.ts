import { writable } from 'svelte/store';

export type Theme = 'light' | 'dark';
const KEY = 'camproxy-theme';

// Order: explicit attribute (set by the head script or a toggle), then the
// system preference. The same tokens as cams (styles/theme.css).
export function currentTheme(): Theme {
  const attr = document.documentElement.dataset.theme;
  if (attr === 'light' || attr === 'dark') return attr;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

// The theme every toggle shows (the top bar's and the phone drawer's).
export const theme = writable<Theme>(typeof document === 'undefined' ? 'dark' : currentTheme());

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  theme.set(next);
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // storage blocked: the choice holds for this page only
  }
  return next;
}
