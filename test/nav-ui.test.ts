import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { COLLAPSED_KEY, NAV_ITEMS, PHONE_QUERY, SIDEBAR_WIDTH, drawerOpen, persistedBoolean } from '../web/src/lib/nav';
import { PAGES } from '../web/src/lib/pages';

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

describe('admin UI navigation', () => {
  it('lists every page once, in the sidebar order', () => {
    expect(NAV_ITEMS.map((i) => i.id)).toEqual([...PAGES]);
    expect(NAV_ITEMS.every((i) => i.label && i.icon)).toBe(true);
  });

  it("uses cams' phone breakpoint and sidebar widths", () => {
    expect(PHONE_QUERY).toBe('(max-width: 767px)');
    expect(SIDEBAR_WIDTH).toEqual({ expanded: 220, collapsed: 64 });
    expect(COLLAPSED_KEY).toBe('camproxy-sidebar-collapsed');
  });

  it('the drawer starts closed', () => {
    expect(get(drawerOpen)).toBe(false);
  });
});

describe('persistedBoolean', () => {
  it('starts from the stored value and writes changes back', () => {
    const s = memoryStorage({ k: '1' });
    const store = persistedBoolean('k', false, s);
    expect(get(store)).toBe(true);
    store.set(false);
    expect(s.data.get('k')).toBe('0');
  });

  it('ignores a stored value that is not 1 or 0', () => {
    expect(get(persistedBoolean('k', true, memoryStorage({ k: 'yes' })))).toBe(true);
    expect(get(persistedBoolean('k', false, memoryStorage()))).toBe(false);
  });

  it('works in memory when storage throws or is missing', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const store = persistedBoolean('k', false, broken);
    expect(get(store)).toBe(false);
    store.set(true);
    expect(get(store)).toBe(true);
    const none = persistedBoolean('k', true, undefined);
    none.update((v) => !v);
    expect(get(none)).toBe(false);
  });
});

// #203: cams-admin and Certificates have their own pages, after Maintenance.
describe('the detail pages', () => {
  it('cams-admin and Certificates follow Maintenance in the navigation', () => {
    expect(PAGES.slice(-3)).toEqual(['maintenance', 'cams-admin', 'certificates']);
    expect(NAV_ITEMS.find((i) => i.id === 'cams-admin')?.label).toBe('Cams-Admin');
    expect(NAV_ITEMS.find((i) => i.id === 'certificates')?.label).toBe('Certificates');
  });
});
