import { join } from 'path';
import type { HealthSummary } from '../health/summary';
import { AdminClient, type ClientLog, type ClientView, type Timing } from './client';
import type { CommandRunner } from './commands';
import type { ReplayGuard } from './replay';
import { enrollWithCode, EnrollError } from './enroll';
import type { HeartbeatProxyInfo } from './heartbeat';
import { deleteKeyFile, KeyFileInvalid, KeyFileUnsafe, readKeyFile, type AdminKeyFile } from './keyfile';
import { fingerprint, trimSlashes } from './protocol';

// cams-admin for the proxy (spec 2026-10-06-cams-admin-phase1-design §9):
// follows camsAdmin.* and the key file, holds at most one client, and gives
// the Status card its view. Off (no client, no timer, no file touched) while
// camsAdmin.url is unset. Changes are applied one at a time, so a settings
// change never leaves a second socket behind.

export type CamsAdminState = 'off' | 'disabled' | 'not-enrolled' | 'key-unsafe' | 'key-invalid' | ClientView['state'];

export interface CamsAdminView {
  state: CamsAdminState;
  url: string | null; // the configured cams-admin
  account: string | null;
  proxyId: string | null;
  fingerprint: string | null; // the proxy key's (cams-admin shows the same)
  enrolledAt: number | null;
  connectedSince: number | null;
  lastHeartbeatAt: number | null;
  lastAckAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  retryInMs: number | null;
  truncated: boolean;
  lingering: number; // closed sockets cams-admin never let go (bounded)
}

export interface CamsAdminDeps {
  settings: () => { url?: string; keyFile: string; enabled: boolean };
  dataDir: () => string;
  version: string;
  cameraIds: () => string[];
  health: () => Promise<HealthSummary>;
  proxyInfo: () => HeartbeatProxyInfo;
  changeKey?: () => string;
  log: ClientLog;
  timing?: Partial<Timing>;
  // Sets (or with undefined clears) the camsAdmin.url override, as the Settings page would; the change comes back through apply().
  setUrl: (url: string | undefined) => Promise<void>;
  // Commands from cams-admin (migration P2), given to each client.
  commands?: () => CommandRunner | null;
  replay?: ReplayGuard;
}

const EMPTY = { account: null, proxyId: null, fingerprint: null, enrolledAt: null, connectedSince: null, lastHeartbeatAt: null, lastAckAt: null, retryInMs: null, truncated: false, lingering: 0 };

export class CamsAdmin {
  private client: AdminClient | null = null;
  private key: AdminKeyFile | null = null;
  private own: { state: CamsAdminState; lastError: string | null; lastErrorAt: number | null } = { state: 'off', lastError: null, lastErrorAt: null };
  private running: string | null = null; // what the client runs with: url|keyId|connectUrl
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  private warned: string | null = null;
  private enrolling = false;

  constructor(private readonly d: CamsAdminDeps) {}

  keyPath(): string {
    return join(this.d.dataDir(), this.d.settings().keyFile);
  }

  // The running key's proxy id and pinned server keys (the command runner's).
  keyInfo(): { proxyId: string; serverKeys: string[] } | null {
    return this.key ? { proxyId: this.key.proxyId, serverKeys: [...this.key.serverKeys] } : null;
  }

  active(): boolean {
    return this.client !== null;
  }

  view(): CamsAdminView {
    const url = this.d.settings().url ?? null;
    if (this.client) {
      const v = this.client.view();
      return { ...v, url, enrolledAt: this.key?.enrolledAt ?? null, lastError: v.lastError, lastErrorAt: v.lastErrorAt };
    }
    const k = this.key;
    return { ...EMPTY, ...(k ? { account: k.account, proxyId: k.proxyId, fingerprint: fingerprint(k.publicKey), enrolledAt: k.enrolledAt } : {}), state: this.own.state, url, lastError: this.own.lastError, lastErrorAt: this.own.lastErrorAt };
  }

  // Follows the settings and the key file now; one apply at a time.
  apply(): Promise<void> {
    this.chain = this.chain.then(() => this.applyNow()).catch((err: unknown) => this.d.log.warn({ err: (err as Error).message }, 'admin_client_error'));
    return this.chain;
  }
  // The key file again (after a chmod, a restore): same as a settings change.
  reload(): Promise<void> {
    this.running = null;
    return this.apply();
  }

  reconnect(): void {
    this.client?.reconnect();
  }

  // Shutdown (spec §9.1): bye, at most byeWaitMs; before the HTTP server.
  async stop(reason: 'shutdown' | 'restart' = 'shutdown'): Promise<void> {
    this.stopped = true;
    await this.chain;
    await this.stopClient(reason);
  }

  // Enrollment from the CLI or the admin UI: the key file, then the URL
  // override (which starts the client). Throws EnrollError.
  // One at a time: a second one is refused (busy), never redeemed alongside.
  async enroll(url: string, code: string): Promise<AdminKeyFile> {
    if (this.enrolling) throw new EnrollError('busy');
    this.enrolling = true;
    try {
      const key = await enrollWithCode({ url, code, keyPath: this.keyPath(), version: this.d.version, cameraIds: this.d.cameraIds() });
      this.running = null;
      if (this.d.settings().url !== key.url) await this.d.setUrl(key.url);
      await this.apply();
      return key;
    } finally {
      this.enrolling = false;
    }
  }

  // bye unenrolled if connected (cams-admin then revokes the key), the key
  // file deleted, the URL override cleared.
  async unenroll(): Promise<{ wasEnrolled: boolean }> {
    await this.chain;
    const was = this.key !== null || this.client !== null;
    await this.stopClient('unenrolled');
    deleteKeyFile(this.keyPath());
    this.key = null;
    this.running = null;
    await this.d.setUrl(undefined);
    await this.apply();
    return { wasEnrolled: was };
  }

  private setOwn(state: CamsAdminState, lastError: string | null): void {
    this.own = { state, lastError, lastErrorAt: lastError ? Date.now() : null };
  }

  private async stopClient(reason: 'shutdown' | 'restart' | 'unenrolled'): Promise<void> {
    const c = this.client;
    this.client = null;
    this.running = null;
    if (c) await c.stop(reason);
  }

  private async applyNow(): Promise<void> {
    if (this.stopped) return;
    const s = this.d.settings();
    if (!s.url) {
      // Off: nothing read, nothing written (the Pi until enrolled).
      await this.stopClient('shutdown');
      this.key = null;
      return this.setOwn('off', null);
    }
    let key: AdminKeyFile;
    try {
      key = readKeyFile(this.keyPath());
    } catch (err) {
      await this.stopClient('shutdown');
      this.key = null;
      if (err instanceof KeyFileUnsafe || err instanceof KeyFileInvalid) {
        const state = err instanceof KeyFileUnsafe ? 'key-unsafe' : 'key-invalid';
        if (this.warned !== err.message) this.d.log.warn({ err: err.message }, state === 'key-unsafe' ? 'admin_key_unsafe' : 'admin_key_invalid');
        this.warned = err.message;
        return this.setOwn(state, err.message);
      }
      return this.setOwn('not-enrolled', 'no key file: enroll with a code from cams-admin');
    }
    this.warned = null;
    this.key = key;
    if (trimSlashes(key.url) !== trimSlashes(s.url)) {
      await this.stopClient('shutdown');
      return this.setOwn('not-enrolled', `the key file is for ${key.url}: enroll with ${s.url}`);
    }
    if (!s.enabled) {
      await this.stopClient('shutdown');
      return this.setOwn('disabled', null);
    }
    const want = `${key.url}|${key.keyId}|${key.connectUrl}`;
    if (this.client && this.running === want) return;
    await this.stopClient(this.client ? 'restart' : 'shutdown');
    if (this.stopped) return;
    this.client = new AdminClient({ keyFile: key, health: this.d.health, proxyInfo: this.d.proxyInfo, version: this.d.version, log: this.d.log, changeKey: this.d.changeKey, timing: this.d.timing, commands: this.d.commands?.() ?? undefined, replay: this.d.replay });
    this.running = want;
    this.client.start();
  }
}
