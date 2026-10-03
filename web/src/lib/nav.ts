import { writable, type Writable } from 'svelte/store';
import type { Page } from './pages';
import type { IconName } from './icons';

// Page navigation like cams: a sidebar with labels that collapses to icons on
// desktop (remembered per browser), and on phones a hamburger that opens the
// same menu as a drawer over the page.

export const NAV_ITEMS: ReadonlyArray<{ id: Page; label: string; icon: IconName }> = [
  { id: 'status', label: 'Status', icon: 'about' },
  { id: 'events', label: 'Events', icon: 'events' },
  { id: 'timeline', label: 'Timeline', icon: 'history' },
  { id: 'clips', label: 'Clips', icon: 'play' },
  { id: 'audit', label: 'Audit', icon: 'audit' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
  { id: 'maintenance', label: 'Maintenance', icon: 'bolt' },
];

// cams' breakpoint: at this width and below there is no sidebar, only the drawer.
export const PHONE_MAX_WIDTH = 767;
export const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;
export const SIDEBAR_WIDTH = { expanded: 220, collapsed: 64 } as const;
export const COLLAPSED_KEY = 'camproxy-sidebar-collapsed';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

function defaultStorage(): Storage | undefined {
  try {
    // Through `window`: Node (the unit tests) has a localStorage global that warns when read.
    return (globalThis as { window?: { localStorage?: Storage } }).window?.localStorage;
  } catch {
    return undefined; // access itself can throw when storage is blocked
  }
}

// A boolean kept in storage as '1' or '0'. When storage is blocked (private
// mode, blocked site data) the value lives in memory for this page only.
export function persistedBoolean(key: string, initial: boolean, storage: Storage | undefined = defaultStorage()): Writable<boolean> {
  let start = initial;
  try {
    const stored = storage?.getItem(key);
    if (stored === '1' || stored === '0') start = stored === '1';
  } catch {
    // keep initial
  }
  const store = writable(start);
  store.subscribe((value) => {
    try {
      storage?.setItem(key, value ? '1' : '0');
    } catch {
      // not persisted this time
    }
  });
  return store;
}

export const sidebarCollapsed = persistedBoolean(COLLAPSED_KEY, false);
export const drawerOpen = writable(false);
