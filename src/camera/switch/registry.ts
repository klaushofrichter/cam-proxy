import { readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../../log';
import { switchPasswordStore } from '../../config/switch-passwords';
import { legacyRef, PoeSwitch, type HostSwitchConfig, type PoeSwitchDeps } from '../poe-switch';
import type { SwitchRef } from './driver';

// The PoE switches this proxy operates, by cams-admin's switch id (spec
// 2026-11-07-poe-switches-design): one PoeSwitch controller each, so a switch
// has one session at a time whoever asks. The descriptors (no secrets) are
// kept in <dataDir>/switches.json so "Turn PoE on" works without cams-admin;
// the passwords are in <dataDir>/admin/switch-passwords.json.
// The host config's switch (poeSwitch.*, retired later) is the `legacy`
// controller; a ref on the same host with no stored password uses its
// environment password (CAMPROXY_POE_SWITCH_PASSWORD).
export interface RegistryDeps extends Partial<Pick<PoeSwitchDeps, 'sleep' | 'now' | 'timeoutMs' | 'onRetryMs' | 'stopRecoveryMs' | 'stopWaitMs' | 'driver' | 'readCacheMs' | 'pingBurst'>> {
  dataDir: string;
  legacy: () => HostSwitchConfig;
  legacyPassword: () => string | undefined;
}
export interface StopResult { id: string; portsLeftOff: number[]; sessionMaybeOpen: boolean }

interface Entry { ref: SwitchRef; sw: PoeSwitch }

const same = (a: SwitchRef, b: SwitchRef) => a.model === b.model && a.host === b.host && a.ports === b.ports && a.offSeconds === b.offSeconds;
const validRef = (r: unknown): r is SwitchRef => {
  const x = r as Partial<SwitchRef> | null;
  return !!x && typeof x.id === 'string' && x.id !== '' && x.model === 'sscpoe-web' && typeof x.host === 'string' && x.host !== '' && Number.isInteger(x.ports) && Number.isInteger(x.offSeconds);
};

export class SwitchRegistry {
  readonly legacy: PoeSwitch;
  private readonly entries = new Map<string, Entry>();
  private readonly file: string;
  private readonly passwords;

  constructor(private readonly d: RegistryDeps) {
    this.file = join(d.dataDir, 'switches.json');
    this.passwords = switchPasswordStore(d.dataDir);
    this.legacy = new PoeSwitch({ ...this.common(), ref: () => legacyRef(d.legacy()), password: d.legacyPassword });
    for (const r of this.load()) this.entries.set(r.id, { ref: r, sw: this.make(r.id) });
  }

  private common(): Partial<PoeSwitchDeps> {
    const { sleep, now, timeoutMs, onRetryMs, stopRecoveryMs, stopWaitMs, driver, readCacheMs, pingBurst } = this.d;
    return { sleep, now, timeoutMs, onRetryMs, stopRecoveryMs, stopWaitMs, driver, readCacheMs, pingBurst };
  }

  private make(id: string): PoeSwitch {
    return new PoeSwitch({
      ...this.common(),
      ref: () => this.entries.get(id)!.ref,
      password: () => this.password(id),
      passwordHint: `no password is stored for switch ${id}`,
    });
  }

  // The stored password; else, for the host config's own switch (same host,
  // model not none), the environment password.
  private password(id: string): string | undefined {
    let stored: string | undefined;
    try {
      stored = this.passwords.get(id);
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'switch_passwords_unreadable');
    }
    if (stored) return stored;
    const e = this.entries.get(id);
    const l = this.d.legacy();
    if (e && l.model !== 'none' && l.host && l.host.toLowerCase() === e.ref.host.toLowerCase()) return this.d.legacyPassword();
    return undefined;
  }

  passwordSet(id: string): boolean {
    return !!this.password(id);
  }

  private load(): SwitchRef[] {
    try {
      const f = JSON.parse(readFileSync(this.file, 'utf8')) as { v?: number; switches?: unknown[] };
      if (f.v !== 1 || !Array.isArray(f.switches)) throw new Error('not a switches file');
      return f.switches.filter(validRef).map(({ id, model, host, ports, offSeconds }) => ({ id, model, host, ports, offSeconds }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.error({ err: (err as Error).message }, 'switches_file_unreadable');
      return [];
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, switches: this.known() }, null, 2));
    renameSync(tmp, this.file);
  }

  // The controller for this switch; a new or changed descriptor is kept.
  get(ref: SwitchRef): PoeSwitch {
    const r: SwitchRef = { id: ref.id, model: ref.model, host: ref.host, ports: ref.ports, offSeconds: ref.offSeconds };
    const e = this.entries.get(r.id);
    if (e) {
      if (!same(e.ref, r)) {
        e.ref = r;
        this.save();
      }
      return e.sw;
    }
    this.entries.set(r.id, { ref: r, sw: this.make(r.id) });
    this.save();
    return this.entries.get(r.id)!.sw;
  }

  find(id: string): { ref: SwitchRef; sw: PoeSwitch } | undefined {
    return this.entries.get(id);
  }

  known(): SwitchRef[] {
    return [...this.entries.values()].map((e) => ({ ...e.ref }));
  }

  // Drops the switch and its password; false when unknown.
  forget(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    this.entries.delete(id);
    this.save();
    this.passwords.delete(id);
    void e.sw.stop();
    return true;
  }

  // On shutdown: every controller (PoE back on where a cycle is in its off time).
  async stop(): Promise<StopResult[]> {
    const all: Array<[string, PoeSwitch]> = [['legacy', this.legacy], ...[...this.entries].map(([id, e]): [string, PoeSwitch] => [id, e.sw])];
    return Promise.all(all.map(async ([id, sw]) => ({ id, ...(await sw.stop()) })));
  }
}
