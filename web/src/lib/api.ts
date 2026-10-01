import { writable } from 'svelte/store';

// null while checking, then whether the session cookie is valid.
export const loggedIn = writable<boolean | null>(null);

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(typeof body === 'object' && body && 'detail' in body ? String((body as { detail: unknown }).detail) : `HTTP ${status}`);
  }
}

// Every call rides on the HttpOnly session cookie; writes add the header a
// cross-site form can't send. A 401 means the session ended: back to login.
// `path` is absolute (/control/… or /api/…).
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['X-CamProxy-UI'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) {
    loggedIn.set(false);
    throw new ApiError(401, null);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

// NDJSON answers (the audit log): one record per line, the paging cursor and
// "more" flag in headers. Same 401 handling and ApiError as api().
export async function apiLines<T>(path: string): Promise<{ records: T[]; next: string | null; hasMore: boolean }> {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (res.status === 401) {
    loggedIn.set(false);
    throw new ApiError(401, null);
  }
  const text = await res.text();
  if (!res.ok) {
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    throw new ApiError(res.status, body);
  }
  return {
    records: text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as T),
    next: res.headers.get('X-Next-Cursor'),
    hasMore: res.headers.get('X-Has-More') === 'true',
  };
}

export async function checkSession(): Promise<void> {
  const r = await fetch('/control/session', { credentials: 'same-origin' }).then((x) => x.json()).catch(() => ({ loggedIn: false }));
  loggedIn.set(!!r.loggedIn);
}

export async function login(token: string): Promise<boolean> {
  const res = await fetch('/control/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ token }) });
  loggedIn.set(res.status === 204);
  return res.status === 204;
}

export async function logout(): Promise<void> {
  await fetch('/control/logout', { method: 'POST', headers: { 'X-CamProxy-UI': '1' }, credentials: 'same-origin' });
  loggedIn.set(false);
}
