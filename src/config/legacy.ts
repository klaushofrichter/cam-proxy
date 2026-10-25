import { ConfigError } from './load-error';
import { checkPartial, checkValue, LEGACY_CAMERA, LEGACY_FTP_USER, SettingError } from './schema';

// Today's one-camera files read as several-camera ones (spec
// 2026-10-05-multi-camera-host-design §4.2). Nothing is written here: the
// translation happens at every load; overrides are written back in the new
// form on the next save.
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const SWITCH_HOST_KEYS = ['model', 'host', 'ports', 'offSeconds'];

const settingError = <T>(f: () => T): T => {
  try {
    return f();
  } catch (e) {
    if (e instanceof SettingError) throw new ConfigError(e.message);
    throw e;
  }
};

// moves.maxCameras is the old name of profile.cameras (cams-admin spec
// 2026-10-25-proxy-profile-design §1, read for one release): taken out of
// `o` (config.json, overrides.json or a PUT body) and set as profile.cameras.
// Both set: equal is fine, different an error. Other moves.* keys stay (and
// fail as unknown settings).
const MAX_CAMERAS: Parameters<typeof checkValue>[1] = { type: 'integer', min: 1, max: 64, doc: 'moves.maxCameras' };
function aliasMaxCameras(o: Obj): void {
  if (!isObj(o.moves) || !Object.hasOwn(o.moves, 'maxCameras')) return;
  const moves = { ...(o.moves as Obj) };
  const n = moves.maxCameras;
  settingError(() => checkValue('moves.maxCameras', MAX_CAMERAS, n));
  const profile = isObj(o.profile) ? { ...(o.profile as Obj) } : {};
  if (profile.cameras !== undefined && profile.cameras !== n) throw new ConfigError(`moves.maxCameras: ${String(n)}, profile.cameras: ${String(profile.cameras)}; set profile.cameras only (moves.maxCameras is its old name)`);
  profile.cameras = n;
  o.profile = profile;
  delete moves.maxCameras;
  if (Object.keys(moves).length) o.moves = moves;
  else delete o.moves;
}

// A legacy camera object → [id, the camera node, the host switch keys].
function fromLegacyCamera(cam: Obj, ftpUser: unknown): [string, Obj, Obj] {
  const { poeSwitch, ...rest } = cam;
  const sw = isObj(poeSwitch) ? poeSwitch : {};
  const host: Obj = {};
  for (const k of SWITCH_HOST_KEYS) if (sw[k] !== undefined) host[k] = sw[k];
  const id = typeof rest.id === 'string' ? rest.id : 'cam1';
  // Today's defaults for the one camera (Ruling P1-11): the Pi keeps them.
  const node: Obj = { ...rest, id, name: rest.name ?? 'Den', ftp: { user: ftpUser ?? 'camera' } };
  if (sw.port !== undefined) node.poeSwitch = { port: sw.port };
  return [id, node, host];
}

export function normalizeFile(file: unknown): { settings: Obj; order: string[]; legacy: boolean } {
  if (!isObj(file)) return { settings: file as Obj, order: [], legacy: false };
  const { camera, cameras, ...rest } = file;
  if (camera !== undefined && cameras !== undefined) throw new ConfigError('camera: use either camera (one camera) or cameras, not both');
  const ftp = isObj(rest.ftp) ? { ...rest.ftp } : undefined;
  const ftpUser = ftp?.user;
  if (ftp) delete ftp.user;
  const settings: Obj = { ...rest, ...(ftp ? { ftp } : {}) };
  aliasMaxCameras(settings);
  if (cameras === undefined) {
    // Legacy: `camera`, or nothing at all (one default camera, Ruling P1-10).
    if (camera !== undefined) settingError(() => checkPartial(camera, LEGACY_CAMERA, 'camera'));
    if (ftpUser !== undefined) settingError(() => checkValue('ftp.user', LEGACY_FTP_USER, ftpUser));
    const [id, node, host] = fromLegacyCamera(isObj(camera) ? camera : {}, ftpUser);
    settings.cameras = { [id]: node };
    if (Object.keys(host).length) settings.poeSwitch = { ...(isObj(settings.poeSwitch) ? settings.poeSwitch : {}), ...host };
    return { settings, order: [id], legacy: true };
  }
  if (ftpUser !== undefined) throw new ConfigError('ftp.user: set cameras[].ftp.user instead');
  if (!Array.isArray(cameras)) throw new ConfigError('cameras: must be a list of cameras');
  if (!cameras.length) throw new ConfigError('cameras: at least one camera');
  const map: Obj = {};
  const order: string[] = [];
  cameras.forEach((c, i) => {
    if (!isObj(c)) throw new ConfigError(`cameras[${i}]: must be an object`);
    if (typeof c.id !== 'string') throw new ConfigError(`cameras[${i}].id: required`);
    if (Object.hasOwn(map, c.id)) throw new ConfigError(`cameras: duplicate id ${c.id}`);
    map[c.id] = c;
    order.push(c.id);
  });
  settings.cameras = map;
  return { settings, order, legacy: false };
}

// One legacy path → the new one (Ruling P1-8): camera.poeSwitch.{model,host,
// ports,offSeconds} → poeSwitch.*, camera.X → cameras.<id>.X, ftp.user →
// cameras.<id>.ftp.user; moves.maxCameras → profile.cameras. Other paths
// stay. Several cameras: an error.
export function translatePath(path: string, ids: string[]): string {
  if (path === 'moves.maxCameras') return 'profile.cameras';
  const legacy = path === 'ftp.user' || path.startsWith('camera.');
  if (!legacy) return path;
  if (ids.length !== 1) {
    const rest = path === 'ftp.user' ? 'ftp.user' : path.slice('camera.'.length);
    throw new ConfigError(`${path}: a legacy camera override can't be assigned with several cameras; use cameras.<id>.${rest}`);
  }
  const id = ids[0];
  if (path === 'ftp.user') return `cameras.${id}.ftp.user`;
  const m = /^camera\.poeSwitch\.(model|host|ports|offSeconds)$/.exec(path);
  if (m) return `poeSwitch.${m[1]}`;
  return `cameras.${id}.${path.slice('camera.'.length)}`;
}

const setIn = (o: Obj, path: string, v: unknown) => {
  const keys = path.split('.');
  let x = o;
  for (const k of keys.slice(0, -1)) x = (isObj(x[k]) ? x[k] : (x[k] = {})) as Obj;
  x[keys[keys.length - 1]] = v;
};

// overrides.json (or a PUT body) in the new form. Legacy paths mean the one
// config.json camera (`ids`: config.json's). A camera not in config.json
// and not added before (`added`) is added here and needs its host (Ruling P2-5).
export function normalizeOverrides(over: unknown, ids: string[], added: string[] = []): Obj {
  if (!isObj(over)) return over as Obj;
  const { camera, ...rest } = over;
  const out: Obj = structuredClone(rest);
  aliasMaxCameras(out);
  const ftp = isObj(out.ftp) ? (out.ftp as Obj) : undefined;
  const legacy: [string, unknown][] = [];
  if (ftp && ftp.user !== undefined) {
    legacy.push(['ftp.user', ftp.user]);
    delete ftp.user;
    if (!Object.keys(ftp).length) delete out.ftp;
  }
  if (camera !== undefined) {
    if (!isObj(camera)) throw new ConfigError('camera: must be an object');
    settingError(() => checkPartial(camera, LEGACY_CAMERA, 'camera'));
    const flat = (o: Obj, prefix: string): [string, unknown][] => Object.entries(o).flatMap(([k, v]) => (isObj(v) ? flat(v, `${prefix}.${k}`) : [[`${prefix}.${k}`, v] as [string, unknown]]));
    legacy.push(...flat(camera, 'camera'));
  }
  for (const [p, v] of legacy) {
    const to = translatePath(p, ids);
    // The id is the camera's key: a legacy camera.id equal to it says nothing.
    if (to === `cameras.${ids[0]}.id` && v === ids[0]) continue;
    setIn(out, to, v);
  }
  if (isObj(out.cameras)) {
    for (const [id, entry] of Object.entries(out.cameras)) {
      if (ids.includes(id) || added.includes(id)) continue;
      if (!isObj(entry) || typeof entry.host !== 'string') throw new ConfigError(`cameras.${id}.host: required for a camera added here`);
    }
  }
  return out;
}
