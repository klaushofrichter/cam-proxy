import { createHash, timingSafeEqual } from 'crypto';
import { join } from 'path';
import { ConfigError } from '../config/load-error';
import { PrivateFileInvalid, PrivateFileUnsafe, readPrivateJson, writePrivateJson } from './private-file';

// The managed token hashes (M §10.2): data/admin/tokens.json, mode 600,
// atomic. Written by tokens.apply and the local block list only; read
// whenever the file exists (R2-7). Never holds a token, never logs a hash.
export interface ManagedToken { id: string; kind: 'client' | 'admin'; hash: string; label: string; retireAt: number | null }
export interface TokensApplyArgs { v: 1; revision: number; tokens: ManagedToken[] }
export interface TokensApplyResult { revision: number; applied: boolean; stale: boolean; client: number; admin: number; blocked: string[] }
// The local block list holds each blocked token's id (for display and the
// heartbeat) and its hash: a blocked hash stays blocked under any id, and
// tokens.apply never prunes a block (security review of PR #186).
interface Block { id: string; hash: string | null }
interface FileShape { v: 1; revision: number; tokens: ManagedToken[]; blocked: Block[] }
export class ShadowsLocalToken extends Error {}
// tokens.json is unusable: no managed token matches, and nothing is applied
// or changed until someone fixes or removes it (its revision is unknown, so
// a replayed set must not count as fresh).
export class TokenStoreUnusable extends Error {}
// The block list is full: a block is never evicted, so a new one is refused.
export class TooManyBlocks extends Error {}

const EMPTY: FileShape = { v: 1, revision: 0, tokens: [], blocked: [] };
const MAX_BLOCKS = 64;
const HASH = /^sha256:[0-9a-f]{64}$/;

export class TokenStore {
  private state: FileShape = EMPTY;
  private digests: { t: ManagedToken; d: Buffer }[] = [];
  private err: string | null = null;
  private readonly now: () => number;

  constructor(private readonly d: { file: string; now?: () => number; localDigests: () => Buffer[] }) {
    this.now = d.now ?? Date.now;
    this.load();
  }

  private load(): void {
    try {
      const f = readPrivateJson(this.d.file) as { v?: unknown; revision?: unknown; tokens?: unknown; blocked?: unknown };
      if (f?.v !== 1 || !Number.isSafeInteger(f.revision) || !Array.isArray(f.tokens) || !Array.isArray(f.blocked)) throw new PrivateFileInvalid(`${this.d.file} is not version 1`);
      // A block is {id, hash}; a plain id (an older file) blocks by id only.
      const blocked = (f.blocked as unknown[]).map((b) => (typeof b === 'string' ? { id: b, hash: null } : (b as Block))).filter((b) => typeof b?.id === 'string' && (b.hash === null || (typeof b.hash === 'string' && HASH.test(b.hash))));
      this.set({ v: 1, revision: f.revision as number, tokens: f.tokens as ManagedToken[], blocked });
      this.err = null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return this.set(EMPTY);
      // Unusable: no managed token matches (fail closed); local tokens are unaffected.
      this.set(EMPTY);
      this.err = e instanceof PrivateFileUnsafe || e instanceof PrivateFileInvalid ? e.message : `${this.d.file}: unreadable`;
    }
  }

  private isBlocked(t: ManagedToken, blocked = this.state.blocked): boolean {
    return blocked.some((b) => b.id === t.id || b.hash === t.hash);
  }

  private set(f: FileShape): void {
    this.state = f;
    this.digests = f.tokens.filter((t) => !this.isBlocked(t, f.blocked)).map((t) => ({ t, d: Buffer.from(t.hash.slice(7), 'hex') }));
  }

  private usable(): void {
    if (this.err) throw new TokenStoreUnusable(this.err);
  }

  problem(): string | null { return this.err; }
  revision(): number { return this.state.revision; }

  private live(t: ManagedToken): boolean { return t.retireAt === null || this.now() < t.retireAt; }

  // Constant time over every entry: the loop never stops early.
  match(bearer: string): { id: string; kind: 'client' | 'admin'; label: string } | null {
    const g = createHash('sha256').update(bearer).digest();
    let hit: ManagedToken | null = null;
    for (const { t, d } of this.digests) if (timingSafeEqual(g, d) && this.live(t)) hit = t;
    return hit ? { id: hit.id, kind: hit.kind, label: hit.label } : null;
  }

  counts(): { revision: number; client: number; admin: number; blocked: string[] } {
    const live = this.digests.map((x) => x.t).filter((t) => this.live(t));
    return { revision: this.state.revision, client: live.filter((t) => t.kind === 'client').length, admin: live.filter((t) => t.kind === 'admin').length, blocked: this.state.blocked.map((b) => b.id) };
  }

  // Throws TokenStoreUnusable (store_error), ShadowsLocalToken, or the write error.
  apply(a: TokensApplyArgs): TokensApplyResult {
    this.usable();
    if (a.revision <= this.state.revision) return { revision: this.state.revision, applied: false, stale: true, ...this.countsOnly(), blocked: [] };
    const local = this.d.localDigests();
    for (const t of a.tokens) {
      const d = Buffer.from(t.hash.slice(7), 'hex');
      if (local.some((l) => timingSafeEqual(l, d))) throw new ShadowsLocalToken(`token ${t.id} has the hash of a local token`);
    }
    const dropped = a.tokens.filter((t) => this.isBlocked(t)).map((t) => t.id);
    // The blocks stay as they are: tokens.apply never removes one.
    const next: FileShape = { v: 1, revision: a.revision, tokens: a.tokens, blocked: this.state.blocked };
    writePrivateJson(this.d.file, next);
    this.set(next);
    return { revision: a.revision, applied: true, stale: false, ...this.countsOnly(), blocked: dropped };
  }

  private countsOnly(): { client: number; admin: number } {
    const c = this.counts();
    return { client: c.client, admin: c.admin };
  }

  block(id: string): void {
    this.usable();
    const hash = this.state.tokens.find((t) => t.id === id)?.hash ?? null;
    if (this.state.blocked.some((b) => b.id === id && b.hash === hash)) return;
    const rest = this.state.blocked.filter((b) => b.id !== id);
    if (rest.length >= MAX_BLOCKS) throw new TooManyBlocks(`at most ${MAX_BLOCKS} blocked tokens: unblock one first`);
    const next = { ...this.state, blocked: [...rest, { id, hash }] };
    writePrivateJson(this.d.file, next);
    this.set(next);
  }

  // Drops the block and the entry: cams-admin's next tokens.apply brings it back.
  unblock(id: string): void {
    this.usable();
    const hashes = new Set(this.state.blocked.filter((b) => b.id === id && b.hash).map((b) => b.hash));
    const next = { ...this.state, blocked: this.state.blocked.filter((b) => b.id !== id && !(b.hash && hashes.has(b.hash))), tokens: this.state.tokens.filter((t) => t.id !== id) };
    writePrivateJson(this.d.file, next);
    this.set(next);
  }

  list(): { id: string; kind: 'client' | 'admin'; label: string; retireAt: number | null; blocked: boolean; live: boolean; hashPrefix: string }[] {
    return this.state.tokens.map((t) => ({ id: t.id, kind: t.kind, label: t.label, retireAt: t.retireAt, blocked: this.isBlocked(t), live: this.live(t), hashPrefix: t.hash.slice(0, 15) }));
  }
}

// The start without CAMPROXY_TOKENS (migration P2, M §10.2): fine while
// <dataDir>/admin/tokens.json holds a live, unblocked managed client token;
// else the error as before. Reads the file only when CAMPROXY_TOKENS is unset.
export function checkClientTokens(l: { config: { server: { dataDir: string } }; secrets: { tokens: string[] } }): void {
  if (l.secrets.tokens.length) return;
  const store = new TokenStore({ file: join(l.config.server.dataDir, 'admin', 'tokens.json'), localDigests: () => [] });
  if (store.counts().client === 0) throw new ConfigError('CAMPROXY_TOKENS: required (no live cams-admin-managed client token either)');
}
