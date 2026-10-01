import { writable } from 'svelte/store';

export const PAGES = ['status', 'events', 'timeline', 'clips', 'audit', 'settings', 'maintenance'] as const;
export type Page = (typeof PAGES)[number];

const fromHash = (): Page => {
  const h = location.hash.replace(/^#\/?/, '');
  return (PAGES as readonly string[]).includes(h) ? (h as Page) : 'status';
};

export const page = writable<Page>(fromHash());
addEventListener('hashchange', () => page.set(fromHash()));

export function go(p: Page): void {
  location.hash = `/${p}`;
}
