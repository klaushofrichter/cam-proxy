import { createHash, timingSafeEqual } from 'crypto';
import { PrivateFileInvalid, PrivateFileUnsafe, readPrivateJson, writePrivateJson } from './private-file';

// The managed token hashes (M §10.2): data/admin/tokens.json, mode 600,
// atomic. Written by tokens.apply and the local block list only; read
// whenever the file exists (R2-7). Never holds a token, never logs a hash.
export interface ManagedToken { id: string; kind: 'client' | 'admin'; hash: string; label: string; retireAt: number | null }
export interface TokensApplyArgs { v: 1; revision: number; tokens: ManagedToken[] }
export interface TokensApplyResult { revision: number; applied: boolean; stale: boolean; client: number; admin: number; blocked: string[] }
interface FileShape { v: 1; revision: number; tokens: ManagedToken[]; blocked: string[] }
export class ShadowsLocalToken extends Error {}

const EMPTY: FileShape = { v: 1, revision: 0, tokens: [], blocked: [] };

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
      const f = readPrivateJson(this.d.file) as FileShape;
      if (f?.v !== 1 || !Number.isSafeInteger(f.revision) || !Array.isArray(f.tokens) || !Array.isArray(f.blocked)) throw new PrivateFileInvalid(`${this.d.file} is not version 1`);
      this.set(f);
      this.err = null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return this.set(EMPTY);
      // Unusable: no managed token matches (fail closed); local tokens are unaffected.
      this.set(EMPTY);
      this.err = e instanceof PrivateFileUnsafe || e instanceof PrivateFileInvalid ? e.message : `${this.d.file}: unreadable`;
    }
  }

  private set(f: FileShape): void {
    this.state = f;
    this.digests = f.tokens.filter((t) => !f.blocked.includes(t.id)).map((t) => ({ t, d: Buffer.from(t.hash.slice(7), 'hex') }));
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
    return { revision: this.state.revision, client: live.filter((t) => t.kind === 'client').length, admin: live.filter((t) => t.kind === 'admin').length, blocked: [...this.state.blocked] };
  }

  apply(a: TokensApplyArgs): TokensApplyResult {
    if (a.revision <= this.state.revision) return { revision: this.state.revision, applied: false, stale: true, ...this.countsOnly(), blocked: [] };
    const local = this.d.localDigests();
    for (const t of a.tokens) {
      const d = Buffer.from(t.hash.slice(7), 'hex');
      if (local.some((l) => timingSafeEqual(l, d))) throw new ShadowsLocalToken(`token ${t.id} has the hash of a local token`);
    }
    const blocked = a.tokens.filter((t) => this.state.blocked.includes(t.id)).map((t) => t.id);
    const next: FileShape = { v: 1, revision: a.revision, tokens: a.tokens, blocked: this.state.blocked.filter((b) => a.tokens.some((t) => t.id === b) || this.state.tokens.some((t) => t.id === b)).slice(-64) };
    writePrivateJson(this.d.file, next);
    this.set(next);
    this.err = null;
    return { revision: a.revision, applied: true, stale: false, ...this.countsOnly(), blocked };
  }

  private countsOnly(): { client: number; admin: number } {
    const c = this.counts();
    return { client: c.client, admin: c.admin };
  }

  block(id: string): void {
    if (this.state.blocked.includes(id)) return;
    const next = { ...this.state, blocked: [...this.state.blocked, id].slice(-64) };
    writePrivateJson(this.d.file, next);
    this.set(next);
  }

  unblock(id: string): void {
    const next = { ...this.state, blocked: this.state.blocked.filter((b) => b !== id), tokens: this.state.tokens.filter((t) => t.id !== id) };
    writePrivateJson(this.d.file, next);
    this.set(next);
  }

  list(): { id: string; kind: 'client' | 'admin'; label: string; retireAt: number | null; blocked: boolean; live: boolean; hashPrefix: string }[] {
    return this.state.tokens.map((t) => ({ id: t.id, kind: t.kind, label: t.label, retireAt: t.retireAt, blocked: this.state.blocked.includes(t.id), live: this.live(t), hashPrefix: t.hash.slice(0, 15) }));
  }
}
