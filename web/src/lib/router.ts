import { writable } from 'svelte/store';

import { PAGES, type Page } from './pages';

export { PAGES, type Page };

const fromHash = (): Page => {
  const h = location.hash.replace(/^#\/?/, '');
  return (PAGES as readonly string[]).includes(h) ? (h as Page) : 'status';
};

export const page = writable<Page>(fromHash());
addEventListener('hashchange', () => page.set(fromHash()));

export function go(p: Page): void {
  location.hash = `/${p}`;
}
