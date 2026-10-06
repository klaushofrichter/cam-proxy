import { createHash, randomBytes } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyOverrides, ConfigError, loadConfig } from '../src/config/load';
import { checkClientTokens } from '../src/fleet/token-store';
import { writePrivateJson } from '../src/fleet/private-file';
import { createProxy } from '../src/proxy';
import { ADMIN_TOKEN, auth, CLIENT_TOKEN } from './helpers/proxy';
import { startSim } from './helpers/sim';

// CAMPROXY_TOKENS optional once a managed client token is live (migration M §10.2).
const tok = () => randomBytes(32).toString('base64url');
const hashOf = (t: string) => `sha256:${createHash('sha256').update(t).digest('hex')}`;
const ID = `tok_${'1'.repeat(20)}`;
const workDir = (host = '127.0.0.1', tokens?: { retireAt?: number | null; blocked?: boolean; t?: string }) => {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-sec-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ camera: { host }, server: { logLevel: 'silent' }, stills: { enabled: false } }));
  if (tokens) writePrivateJson(join(dir, 'data', 'admin', 'tokens.json'), { v: 1, revision: 1, blocked: tokens.blocked ? [ID] : [], tokens: [{ id: ID, kind: 'client', hash: hashOf(tokens.t ?? tok()), label: 'cams', retireAt: tokens.retireAt ?? null }] });
  return dir;
};
const ENV = { CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: 'x' };
const startable = (dir: string, env: NodeJS.ProcessEnv = ENV): string | null => {
  try {
    checkClientTokens(loadConfig(env, { cwd: dir, tokensOptional: true }));
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
};

describe('CAMPROXY_TOKENS while managed tokens exist', () => {
  it('the strict default: required (the CLI keeps it)', () => {
    expect(() => loadConfig(ENV, { cwd: workDir() })).toThrow(/^CAMPROXY_TOKENS: required/);
  });
  it('no CAMPROXY_TOKENS and no store: required', () => {
    expect(startable(workDir())).toMatch(/^CAMPROXY_TOKENS: required/);
  });
  it('a live managed client token: fine; retired or blocked: required again', () => {
    expect(startable(workDir(undefined, {}))).toBeNull();
    expect(startable(workDir(undefined, { retireAt: 1 }))).toMatch(/^CAMPROXY_TOKENS: required/);
    expect(startable(workDir(undefined, { blocked: true }))).toMatch(/^CAMPROXY_TOKENS: required/);
  });
  it('CAMPROXY_ADMIN_TOKEN still required in every case', () => {
    expect(() => loadConfig({ CAMPROXY_CAMERA_PASSWORD: 'x' }, { cwd: workDir(undefined, {}), tokensOptional: true })).toThrow(/^CAMPROXY_ADMIN_TOKEN: required/);
  });
  it('a settings change keeps the optional tokens (the configuration is rebuilt)', () => {
    const l = loadConfig(ENV, { cwd: workDir(undefined, {}), tokensOptional: true });
    expect(applyOverrides(l, { sse: { pingS: 9 } }).secrets.tokens).toEqual([]);
  });
});

describe('a proxy without CAMPROXY_TOKENS', () => {
  let sim: Awaited<ReturnType<typeof startSim>>;
  let proxy: ReturnType<typeof createProxy>;
  let base: string;
  const T = tok();
  beforeAll(async () => {
    sim = await startSim();
    const dir = workDir(sim.camera.host, { t: T });
    const loaded = loadConfig({ ...ENV, CAMPROXY_CAMERA_PASSWORD: sim.password }, { cwd: dir, tokensOptional: true });
    checkClientTokens(loaded);
    proxy = createProxy(loaded);
    base = `http://127.0.0.1:${(await proxy.start({ port: 0, host: '127.0.0.1' })).port}`;
  });
  afterAll(async () => {
    await proxy?.stop();
    await sim?.close();
  });
  it('the managed token works; no token or the old one: 401', async () => {
    expect((await request(base).get('/api/cameras').set(auth(T))).status).toBe(200);
    expect((await request(base).get('/api/cameras')).status).toBe(401);
    expect((await request(base).get('/api/cameras').set(auth(CLIENT_TOKEN))).status).toBe(401);
  });
});
