// The admin UI's pages, apart from the router so non-DOM code (nav.ts, the
// unit tests) can name them.
export const PAGES = ['status', 'events', 'timeline', 'clips', 'audit', 'settings', 'maintenance', 'cams-admin', 'certificates'] as const;
export type Page = (typeof PAGES)[number];
