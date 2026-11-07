import { readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../../log';
import { switchPasswordStore } from '../../config/switch-passwords';
import { legacyRef, PoeSwitch, PoeSwitchError, type HostSwitchConfig, type PoeSwitchDeps, type SessionLane } from '../poe-switch';
import type { SwitchRef } from './driver';

// The PoE switches this proxy operates, by cams-admin's switch id (spec
// 2026-11-07-poe-switches-design): one PoeSwitch controller each, so a switch
// has one session at a time whoever asks. The descriptors (no secrets) are
// kept in <dataDir>/switches.json so "Turn PoE on" works without cams-admin;
// the passwords are in <dataDir>/admin/switch-passwords.json.
// A stored password is bound to the switch address it was set for: a ref
// naming another host (cams-admin changed it) gets no password until it is set
// again here, so the password never goes to an address cams-admin chooses.
// The host config's switch (poeSwitch.*, retired later) is the `legacy`
// controller; a ref on the same host with no usable stored password uses its
// environment password (CAMPROXY_POE_SWITCH_PASSWORD).
export interface RegistryDeps extends Partial<Pick<PoeSwitchDeps, 'sleep' | 'now' | 'timeoutMs' | 'onRetryMs' | 'stopRecoveryMs' | 'stopWaitMs' | 'driver' | 'readCacheMs' | 'pingBurst'>> {
  dataDir: string;
  legacy: () => HostSwitchConfig;
  legacyPassword: () => string | undefined;
  // forget() stops the controller; this gets what it reports (a port may be left off).
  onForgotten?: (r: { id: string; ref: SwitchRef } & Awaited<ReturnType<PoeSwitch['stop']>>) => void;
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
  private readonly lanes = new Map<string, SessionLane>();
  private readonly file: string;
  private readonly passwords;
  private stopped = false;

  constructor(private readonly d: RegistryDeps) {
    this.file = join(d.dataDir, 'switches.json');
    this.passwords = switchPasswordStore(d.dataDir);
    this.legacy = new PoeSwitch({ ...this.common(), ref: () => legacyRef(d.legacy()), password: d.legacyPassword, lane: () => this.laneFor(d.legacy().host ?? '') });
    for (const r of this.load()) {
      this.entries.set(r.id, { ref: r, sw: this.make(r.id) });
      this.bindUnbound(r);
    }
  }

  // A password stored before the binding (no host) is bound to the switch's
  // host as this proxy knows it (on load, or when the id first appears).
  private bindUnbound(r: SwitchRef): void {
    try {
      if (this.passwords.bind(r.id, r.host)) logger.info({ id: r.id }, 'switch_password_bound_to_host');
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'switch_passwords_unreadable');
    }
  }

  private common(): Partial<PoeSwitchDeps> {
    const { sleep, now, timeoutMs, onRetryMs, stopRecoveryMs, stopWaitMs, driver, readCacheMs, pingBurst } = this.d;
    return { sleep, now, timeoutMs, onRetryMs, stopRecoveryMs, stopWaitMs, driver, readCacheMs, pingBurst };
  }

  // One queue per switch host (case-insensitive): the legacy controller and every id on it share it.
  private laneFor(host: string): SessionLane {
    const k = host.toLowerCase();
    let l = this.lanes.get(k);
    if (!l) this.lanes.set(k, (l = { tail: Promise.resolve() }));
    return l;
  }

  private make(id: string): PoeSwitch {
    return new PoeSwitch({
      ...this.common(),
      ref: () => this.entries.get(id)!.ref,
      lane: () => this.laneFor(this.entries.get(id)!.ref.host),
      password: () => this.password(id),
      passwordHint: () => this.passwordHint(id),
    });
  }

  private stored(id: string) {
    try {
      return this.passwords.get(id);
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'switch_passwords_unreadable');
      return undefined;
    }
  }

  // The stored password when it was set for the switch's current host; else,
  // for the host config's own switch (same host, model not none), the
  // environment password.
  private password(id: string): string | undefined {
    const stored = this.stored(id);
    const e = this.entries.get(id);
    if (stored && (!stored.host || !e || stored.host === e.ref.host.toLowerCase())) return stored.password;
    const l = this.d.legacy();
    if (e && l.model !== 'none' && l.host && l.host.toLowerCase() === e.ref.host.toLowerCase()) return this.d.legacyPassword();
    return undefined;
  }

  // Why there is no password (the password_unset message).
  private passwordHint(id: string): string {
    const stored = this.stored(id);
    const e = this.entries.get(id);
    if (stored?.host && e && stored.host !== e.ref.host.toLowerCase()) return `the switch password was set for another address: set it again for ${e.ref.host}`;
    return `no password is stored for switch ${id}`;
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
  // After stop() (the proxy is stopping) none: a controller made then would
  // escape the stop and could cut PoE with nothing to turn it on again.
  get(ref: SwitchRef): PoeSwitch {
    if (this.stopped) throw new PoeSwitchError('switch_error', 'the proxy is stopping');
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
    this.bindUnbound(r);
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
    const ref = { ...e.ref };
    void e.sw.stop().then((r) => {
      if (r.portsLeftOff.length || r.sessionMaybeOpen) logger.error({ id, ...r }, 'switch_forgotten_with_poe_or_session_left');
      this.d.onForgotten?.({ id, ref, ...r });
    });
    return true;
  }

  // On shutdown: every controller (PoE back on where a cycle is in its off time).
  async stop(): Promise<StopResult[]> {
    this.stopped = true;
    const all: Array<[string, PoeSwitch]> = [['legacy', this.legacy], ...[...this.entries].map(([id, e]): [string, PoeSwitch] => [id, e.sw])];
    return Promise.all(all.map(async ([id, sw]) => ({ id, ...(await sw.stop()) })));
  }
}
