import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { connect, isIP } from 'node:net';
import { splitHost } from '../camera/http';
import { ConfigError, planOverrides, type Loaded } from '../config/load';
import type { MoveOfferArgs } from '../fleet/command-args';
import { fingerprintOf, type SiteCa } from '../tls/ca';
import type { MoveJournal, MoveRecord } from './journal';
import type { MoveKind, MoveReason, Space } from './types';
import { MOVE_KINDS } from './types';

// The target's evaluation of an offered move (camera-move plan Task 6, S §6, §7,
// P4, Review Focus 4). Pure decisions over injected facts; the one effect is the
// target's journal record when the offer is accepted.

export const PROBE_BYTES = 64 * 1024 * 1024;
const PROBE_CAP_MS = 5000;
const CONNECT_MS = 3000;
const GB = 1024 ** 3;

export type Evaluation = { accept: true; space: Space; probeBps: number } | { accept: false; reason: MoveReason };

export interface EvaluateDeps {
  // The allow entry `move.receive` is in effect.
  receiveAllowed: () => boolean;
  journal: Pick<MoveJournal, 'active' | 'save'>;
  loaded: () => Loaded;
  ca: () => SiteCa | null;
  // Bytes now held of the kinds with a size cap.
  // `used`/`budget`: the storage budget's total use and limit (storage.budget()).
  usage: () => { stills: number; previews: number; clips: number; used: number; budget: number };
  freeBytes: () => number;
  now?: () => number;
  // Overridable for tests: a TCP connect, the source's address, the throughput probe.
  connect?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  resolve?: (host: string) => Promise<string | null>;
  probe?: (source: MoveOfferArgs['source'], moveId: string, token: string) => Promise<number>;
}

export function tcpConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function resolveHost(host: string): Promise<string | null> {
  if (isIP(host)) return host;
  try {
    return (await lookup(host)).address;
  } catch {
    return null;
  }
}

// What fits, per kind and on the disk (P4). `perKind` is what each kind needs
// (like the contract's fixture); `available` what could be taken in all.
export function spaceFor(deps: Pick<EvaluateDeps, 'loaded' | 'usage' | 'freeBytes'>, summary: MoveOfferArgs['summary']): Space {
  const cfg = deps.loaded().config;
  const use = deps.usage();
  const disk = Math.max(0, deps.freeBytes() - cfg.storage.minFreeBytes);
  const need = (k: MoveKind) => summary[k].bytes;
  // Headroom under the *.maxGB size caps; a kind without a cap has none (the disk limits it).
  const stillsCap = cfg.stills.maxGB !== undefined && cfg.previews.maxGB !== undefined ? (cfg.stills.maxGB + cfg.previews.maxGB) * GB : undefined;
  const clipsCap = cfg.ftp.maxGB !== undefined ? cfg.ftp.maxGB * GB : undefined;
  const room = (cap: number | undefined, used: number) => (cap === undefined ? Infinity : Math.max(0, cap - used));
  const headroom: Partial<Record<MoveKind, number>> = { stills: room(stillsCap, use.stills + use.previews), clips: room(clipsCap, use.clips) };
  const perKind: Space['perKind'] = {};
  let needed = 0;
  let takeable = 0;
  let capShort = false;
  for (const k of MOVE_KINDS) {
    const n = need(k);
    if (n > 0) perKind[k] = n;
    needed += n;
    const h = headroom[k] ?? Infinity;
    takeable += Math.min(n, h);
    if (n > h) capShort = true;
  }
  const budgetRoom = Math.max(0, use.budget - use.used);
  const available = Math.min(disk, takeable, budgetRoom);
  const fits = available >= needed;
  let retentionProposal: Space['retentionProposal'] = null;
  // Raising caps helps only when the disk can hold all of it.
  const budgetShort = needed > budgetRoom;
  if (!fits && (capShort || budgetShort) && needed <= disk) {
    const p: Record<string, number> = {};
    if (budgetShort) p['storage.maxBytes'] = use.used + needed;
    if (need('clips') > (headroom.clips ?? Infinity)) p['ftp.maxGB'] = Math.ceil((use.clips + need('clips')) / GB);
    if (need('stills') > (headroom.stills ?? Infinity)) {
      const total = Math.ceil((use.stills + use.previews + need('stills')) / GB);
      const s = cfg.stills.maxGB!;
      const pv = cfg.previews.maxGB!;
      p['stills.maxGB'] = Math.max(s, Math.ceil((total * s) / (s + pv)));
      p['previews.maxGB'] = Math.max(pv, Math.ceil((total * pv) / (s + pv)));
    }
    retentionProposal = p;
  }
  return { needed, available, fits, perKind, retentionProposal };
}

// The camera node the offer describes, as the target would store it.
function cameraNode(a: MoveOfferArgs): object {
  const c = a.camera;
  return { name: c.name, host: c.host, protocol: c.protocol, user: c.user, onvifPort: c.onvifPort, rtspPort: c.rtspPort, baichuanPort: c.baichuanPort, ...a.settings };
}

export async function evaluate(deps: EvaluateDeps, args: MoveOfferArgs): Promise<Evaluation> {
  const no = (reason: MoveReason): Evaluation => ({ accept: false, reason });
  const id = args.camera.proxyCameraId;
  if (!deps.receiveAllowed()) return no('moves_not_allowed');
  // An unreadable journal is not known to be idle.
  let active: MoveRecord[];
  try {
    active = deps.journal.active();
  } catch {
    return no('busy');
  }
  if (active.length > 0) return no('busy');
  const loaded = deps.loaded();
  const cfg = loaded.config;
  const ca = deps.ca();
  if (!cfg.tls.site || !ca) return no('no_site_ca');
  // Review Focus 4: a hidden `moved` leftover is free; anything else is taken.
  if (cfg.cameras[id] && !(cfg.cameras[id].moved && !active.some((r) => r.camera === id))) return no('id_taken');
  if (cfg.moves.maxCameras !== undefined && cfg.cameraOrder.filter((c) => !cfg.cameras[c]?.moved).length >= cfg.moves.maxCameras) return no('camera_limit');
  try {
    planOverrides(loaded, { cameras: { [id]: cameraNode(args) } });
  } catch (err) {
    if (err instanceof ConfigError) return no('incompatible');
    throw err;
  }
  const { hostname, port } = splitHost(args.camera.host);
  if (!ca.covers(hostname) || !ca.coversName(`${id}.${cfg.tls.site}.internal`)) return no('ca_does_not_cover_camera');
  const reachable = await (deps.connect ?? tcpConnect)(hostname, port ?? (args.camera.protocol === 'https' ? 443 : 80), CONNECT_MS);
  if (!reachable) return no('camera_unreachable');
  const space = spaceFor(deps, args.summary);
  const probeBps = await (deps.probe ?? probeSource)(args.source, args.moveId, args.token).catch(() => 0);
  const ip = await (deps.resolve ?? resolveHost)(new URL(args.source.url).hostname.replace(/^\[(.*)\]$/, '$1'));
  // MoveCameraConnection is the camera without cams' own id for it.
  const { camsId: _camsId, ...connection } = args.camera;
  deps.journal.save({
    v: 1, id: args.moveId, role: 'target', camera: id, phase: 'opened', plan: null,
    peer: { proxyId: args.source.proxyId, name: args.source.name, url: args.source.url, caFingerprints: args.source.caFingerprints, tlsServername: args.source.tlsServername, ...(ip ? { ip } : {}) },
    token: args.token, cameraConnection: connection, summary: args.summary, settings: args.settings, space,
    chunks: {}, bytesDone: 0, startedAt: (deps.now ?? Date.now)(),
  });
  return { accept: true, space, probeBps };
}

interface Fetched { status: number; received: number; ms: number; body: Buffer | null }

// One GET against the source. https: the source's CA is fetched from /tls/ca.pem
// without verification, accepted only when its fingerprint is one of the offered
// `caFingerprints`, and then the request is verified against it for
// `tlsServername` (the way cams pins the site CA). Nothing here puts the token
// in an error.
function get(source: MoveOfferArgs['source'], path: string, o: { token?: string; ca?: string; keep?: number; capMs: number }): Promise<Fetched> {
  const u = new URL(source.url);
  const https = u.protocol === 'https:';
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let finish: (() => void) | null = null;
    // A hard cap on the whole request: what arrived by then counts.
    const cap = setTimeout(() => {
      if (finish) finish();
      else reject(new Error('source did not answer in time'));
      req.destroy();
    }, o.capMs);
    cap.unref();
    const req = (https ? httpsRequest : httpRequest)(
      {
        hostname: u.hostname.replace(/^\[(.*)\]$/, '$1'), port: u.port || (https ? 443 : 80), path, method: 'GET',
        headers: o.token ? { Authorization: `Bearer ${o.token}` } : {},
        ...(https ? (o.ca ? { ca: o.ca, servername: source.tlsServername, rejectUnauthorized: true } : { rejectUnauthorized: false }) : {}),
      },
      (res) => {
        let received = 0;
        const kept: Buffer[] = [];
        let done = false;
        finish = () => {
          if (done) return;
          done = true;
          clearTimeout(cap);
          resolve({ status: res.statusCode ?? 0, received, ms: Date.now() - started, body: o.keep ? Buffer.concat(kept) : null });
        };
        const end = finish;
        res.on('data', (c: Buffer) => {
          received += c.length;
          if (o.keep && received <= o.keep) kept.push(c);
        });
        res.once('end', end);
        // The cap or a dropped connection ends the measurement with what arrived.
        res.once('close', end);
        res.once('error', end);
      },
    );
    req.once('error', () => {
      clearTimeout(cap);
      reject(new Error('source not reachable'));
    });
    req.end();
  });
}

// GET /api/moves/<id>/probe?bytes=N: bytes per second to the source, 0 when
// the probe fails (a failure does not refuse the offer).
export async function probeSource(source: MoveOfferArgs['source'], moveId: string, token: string): Promise<number> {
  try {
    return await probe(source, moveId, token);
  } catch {
    return 0;
  }
}

// The source's CA for an https source: fetched from /tls/ca.pem without
// verification, taken only when it is exactly one certificate whose
// fingerprint is one of the offered `caFingerprints`. undefined for http; null
// when the pin does not hold.
async function pinnedCa(source: MoveOfferArgs['source']): Promise<string | undefined | null> {
  if (!source.url.startsWith('https:')) return undefined;
  const f = await get(source, '/tls/ca.pem', { keep: 64 * 1024, capMs: 3000 });
  const text = f.status === 200 && f.body ? f.body.toString('utf8') : '';
  // Exactly one certificate: a bundle could carry a second CA behind the pinned one.
  if ((text.match(/BEGIN CERTIFICATE/g) ?? []).length !== 1) return null;
  let pem: string;
  try {
    pem = new X509Certificate(text).toString();
  } catch {
    return null;
  }
  return source.caFingerprints.includes(fingerprintOf(pem)) ? pem : null;
}

// One small GET against the source with the move token, pinned like the
// probe (the target's switch-over reads /secrets with it). Throws when the
// source can't be reached or its CA is not the pinned one; never puts the
// token in an error.
export async function sourceGet(source: MoveOfferArgs['source'], path: string, token: string, o: { keep?: number; capMs?: number } = {}): Promise<{ status: number; body: Buffer }> {
  const ca = await pinnedCa(source);
  if (ca === null) throw new Error('the source CA is not the pinned one');
  const keep = o.keep ?? 64 * 1024;
  const r = await get(source, path, { token, ca, keep, capMs: o.capMs ?? 10_000 });
  if (r.received > keep) throw new Error('the source answer is too large');
  return { status: r.status, body: r.body ?? Buffer.alloc(0) };
}

async function probe(source: MoveOfferArgs['source'], moveId: string, token: string): Promise<number> {
  const ca = await pinnedCa(source);
  if (ca === null) return 0;
  const t0 = Date.now();
  const r = await get(source, `/api/moves/${moveId}/probe?bytes=${PROBE_BYTES}`, { token, ca, capMs: PROBE_CAP_MS });
  if (r.status !== 200 || r.received === 0) return 0;
  return Math.round((r.received * 1000) / Math.max(1, Date.now() - t0));
}
