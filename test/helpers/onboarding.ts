import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash, randomBytes } from 'crypto';
import { logBuffer } from '../../src/log';
import { writePrivateJson } from '../../src/fleet/private-file';

// Helpers of the onboarding tests (spec 2026-10-30-camera-onboarding-design).

// Every audit record written under `dir` (a proxy's folder), as text.
export const auditText = (dir: string): string => {
  const d = join(dir, 'data', 'audit');
  return existsSync(d) ? readdirSync(d).map((f) => readFileSync(join(d, f), 'utf8')).join('') : '';
};
// The records of one action, oldest first.
export const audits = (dir: string, action: string): Record<string, any>[] =>
  auditText(dir).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>).filter((r) => r.event?.action === action);
export const lastAudit = (dir: string, action: string): Record<string, any> | undefined => audits(dir, action).at(-1);
// The process log buffer (info and up), as text.
export const logText = (): string => JSON.stringify(logBuffer.recent(1000));

// A cams-admin-managed admin token in a proxy folder (data/admin/tokens.json), before the proxy starts.
export function managedAdminToken(dir: string): string {
  const t = randomBytes(32).toString('base64url');
  writePrivateJson(join(dir, 'data', 'admin', 'tokens.json'), { v: 1, revision: 1, blocked: [], tokens: [{ id: `tok_${'1'.repeat(20)}`, kind: 'admin', hash: `sha256:${createHash('sha256').update(t).digest('hex')}`, label: 'cams', retireAt: null }] });
  return t;
}
