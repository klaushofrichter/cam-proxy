// The description of every setting: one place that drives validation and the
// generated config.schema.json, so the two can't drift apart.

// `unset`: what the setting's unset state does (not set, none, empty, off,
// or 0 = none; `value` is that state, undefined for not set). The Settings
// page says it on a Reset that goes back to it, and in Reset to defaults.
type Unset = { value?: string | number | boolean; text: string };
export type Leaf =
  | { type: 'integer'; min: number; max: number; optional?: boolean; oneOf?: number[]; doc: string; unset?: Unset }
  | { type: 'boolean'; doc: string; unset?: Unset }
  | { type: 'string'; enum?: string[]; pattern?: string; optional?: boolean; doc: string; unset?: Unset };
// A keyed collection (spec 2026-10-05-multi-camera-host-design §4.1): an
// object keyed by camera id, each entry one `collection` node; config.json
// writes it as an array (order = display order).
export type Collection = { collection: Node; doc: string };
export type Node = { [key: string]: Node | Leaf | Collection };
export const CAMERA_ID = '^[a-z0-9][a-z0-9-]{0,31}$';
export const collection = (of: Node, doc: string): Collection => ({ collection: of, doc });
const isCollection = (n: Node | Leaf | Collection): n is Collection => typeof (n as Collection).collection === 'object' && typeof (n as Collection).doc === 'string';
const isLeaf = (n: Node | Leaf | Collection): n is Leaf => !isCollection(n) && typeof (n as Leaf).type === 'string' && typeof (n as Leaf).doc === 'string';

const port = (doc: string): Leaf => ({ type: 'integer', min: 1, max: 65535, doc });
const int = (min: number, max: number, doc: string, optional = false): Leaf => ({ type: 'integer', min, max, doc, optional });
// A leaf with its unset text (see Unset).
const unset = (leaf: Leaf, text: string, value?: Unset['value']): Leaf => ({ ...leaf, unset: { ...(value !== undefined ? { value } : {}), text } });
const size = (doc: string): Leaf => ({ type: 'string', pattern: '^[1-9][0-9]{1,4}x[1-9][0-9]{1,4}$', doc });

// Today's `camera` object (one camera): read from legacy files and translated
// at load (spec §4.2).
export const LEGACY_CAMERA: Node = {
  id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,31}$', doc: 'camera id used in paths and the API' },
  name: { type: 'string', pattern: '^.{1,64}$', doc: "fallback display name until the camera's own name is read (the camera stores its name)" },
  host: unset({ type: 'string', pattern: '^[^\\s/]*$', doc: 'address or name, optional :port (required)' }, 'no camera address: the camera waits idle (Find camera can still be used)', ''),
  protocol: { type: 'string', enum: ['https', 'http'], doc: 'camera HTTP API protocol' },
  tlsName: unset({ type: 'string', pattern: '^[^\\s]+$', optional: true, doc: 'verify the camera certificate against this name' }, "the camera's certificate is not verified"),
  webUiUrl: unset({ type: 'string', pattern: '^(https?://[^\\s]+|none)$', optional: true, doc: "the camera's own web page, linked from the admin UI; default https://<host>/, none for no link" }, 'the link goes to https://<camera.host>/'),
  user: { type: 'string', pattern: '^[^\\s:]{1,31}$', doc: "the proxy's own camera user" },
  onvifPort: port('camera ONVIF port'),
  rtspPort: port('camera RTSP port'),
  baichuanPort: port("camera Baichuan port (recordings over TCP); the host is camera.host's"),
  statusPollS: int(5, 3600, 'seconds between status checks'),
  // The PoE switch the camera hangs on (issue #85): power-cycle the camera
  // through it. Applies at once; the password is CAMPROXY_POE_SWITCH_PASSWORD.
  poeSwitch: {
    model: unset({ type: 'string', enum: ['none', 'sscpoe-web'], doc: "the camera's PoE switch: none, or sscpoe-web (the STEAMEMO/SSCPOE local web protocol: GPS-208 and kin)" }, 'no PoE switch: power-cycle off', 'none'),
    host: unset({ type: 'string', pattern: '^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$', optional: true, doc: "the switch's address or name, optional :port (http)" }, 'PoE switch control off: no switch address'),
    port: unset(int(1, 48, 'the switch port the camera is on, as numbered on the switch', true), "PoE switch control off: no camera port"),
    ports: int(1, 48, "the switch's PoE port count (maps the port to its internal index)"),
    offSeconds: int(5, 60, 'seconds the PoE stays off in a power-cycle'),
  },
};
// Today's top-level ftp.user (legacy files).
export const LEGACY_FTP_USER: Leaf = { type: 'string', pattern: '^[^\\s:]{1,31}$', doc: 'FTP user the camera logs in as' };

// One camera of `cameras` (spec §4.1): the per-camera keys and the closed
// list of host defaults it may override.
const hostValue = (path: string) => `the host value, ${path}`;
export const CAMERA_NODE: Node = {
  id: { type: 'string', pattern: CAMERA_ID, doc: 'camera id used in paths and the API' },
  name: { type: 'string', pattern: '^.{1,64}$', doc: "fallback display name until the camera's own name is read (default: the id)" },
  host: unset({ type: 'string', pattern: '^[^\\s/]*$', doc: 'address or name, optional :port' }, 'no camera address: the camera waits idle (Find camera can still be used)', ''),
  protocol: { type: 'string', enum: ['https', 'http'], doc: 'camera HTTP API protocol' },
  tlsName: unset({ type: 'string', pattern: '^[^\\s]+$', optional: true, doc: 'verify the camera certificate against this name' }, "the camera's certificate is not verified"),
  webUiUrl: unset({ type: 'string', pattern: '^(https?://[^\\s]+|none)$', optional: true, doc: "the camera's own web page, linked from the admin UI; default https://<host>/, none for no link" }, 'the link goes to https://<host>/'),
  user: { type: 'string', pattern: '^[^\\s:]{1,31}$', doc: "the proxy's own camera user" },
  onvifPort: port('camera ONVIF port'),
  rtspPort: port('camera RTSP port'),
  baichuanPort: port("camera Baichuan port (recordings over TCP); the host is the camera's host"),
  statusPollS: int(5, 3600, 'seconds between status checks'),
  poeSwitch: {
    port: unset(int(1, 48, "the port of the host's PoE switch this camera is on, as numbered on the switch", true), 'PoE switch control off for this camera: no port'),
  },
  ftp: {
    user: unset({ type: 'string', pattern: '^[^\\s:]{1,31}$', optional: true, doc: 'FTP user this camera logs in as' }, 'the camera id'),
    enabled: unset({ type: 'boolean', doc: 'accept clip uploads from this camera' }, hostValue('ftp.enabled')),
    stream: unset({ type: 'string', enum: ['main', 'sub'], optional: true, doc: 'the stream this camera uploads' }, hostValue('ftp.stream')),
  },
  stills: {
    enabled: unset({ type: 'boolean', doc: 'store stills of this camera' }, hostValue('stills.enabled')),
    stream: unset({ type: 'string', enum: ['sub', 'main'], optional: true, doc: 'camera stream the stills come from' }, hostValue('stills.stream')),
    intervalS: unset({ type: 'integer', min: 1, max: 60, optional: true, oneOf: [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60], doc: 'seconds between stills (divides a minute)' }, hostValue('stills.intervalS')),
  },
  analytics: {
    kinds: {
      person: unset({ type: 'boolean', doc: "analyse this camera's person events" }, hostValue('analytics.kinds.person')),
      vehicle: unset({ type: 'boolean', doc: "analyse this camera's vehicle events" }, hostValue('analytics.kinds.vehicle')),
      pet: unset({ type: 'boolean', doc: "analyse this camera's pet events" }, hostValue('analytics.kinds.pet')),
    },
  },
  events: {
    poll: {
      enabled: unset({ type: 'boolean', doc: 'poll GetMdState/GetAiState while ONVIF is down' }, hostValue('events.poll.enabled')),
    },
  },
};
export const HOST_POE_SWITCH: Node = {
  model: unset({ type: 'string', enum: ['none', 'sscpoe-web'], doc: "the cameras' PoE switch: none, or sscpoe-web (the STEAMEMO/SSCPOE local web protocol: GPS-208 and kin)" }, 'no PoE switch: power-cycle off', 'none'),
  host: unset({ type: 'string', pattern: '^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$', optional: true, doc: "the switch's address or name, optional :port (http)" }, 'PoE switch control off: no switch address'),
  ports: int(1, 48, "the switch's PoE port count (maps a port to its internal index)"),
  offSeconds: int(5, 60, 'seconds the PoE stays off in a power-cycle'),
};

const SETTINGS: Node = {
  server: {
    port: port('HTTP port for the API, control API and admin UI'),
    dataDir: { type: 'string', pattern: '^.+$', doc: 'data folder; relative to the config file' },
    logLevel: { type: 'string', enum: ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], doc: 'pino log level' },
    trustProxy: unset(int(0, 5, 'reverse proxies in front (the cluster ingress: 1); rate limits then count clients by X-Forwarded-For', true), 'no reverse proxy: rate limits count the connecting address'),
    publicUrl: unset({ type: 'string', pattern: '^https?://[^\\s]+$', optional: true, doc: 'where people reach this proxy (its admin UI); reported in /api/cameras so clients can link to it' }, 'no link to this proxy for clients'),
  },
  camera: LEGACY_CAMERA,
  go2rtc: {
    binary: unset({ type: 'string', pattern: '^.+$', optional: true, doc: 'go2rtc binary started by the proxy' }, 'no go2rtc started (go2rtc.url instead)'),
    url: unset({ type: 'string', pattern: '^https?://[^\\s]+$', optional: true, doc: 'go2rtc API when it runs as its own container' }, 'the proxy starts go2rtc itself (go2rtc.url is reserved, no effect yet)'),
    rtspPort: port('go2rtc local RTSP port'),
    apiPort: port('go2rtc local API port'),
  },
  stills: {
    enabled: { type: 'boolean', doc: 'store stills' },
    stream: { type: 'string', enum: ['sub', 'main'], doc: 'camera stream the stills come from' },
    intervalS: { type: 'integer', min: 1, max: 60, oneOf: [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60], doc: 'seconds between stills (divides a minute)' },
    size: size('still size, WxH'),
    quality: int(2, 31, 'ffmpeg JPEG quality (q:v); lower is better'),
    maxGB: unset(int(1, 100000, 'size cap for stills', true), 'no size cap for stills (the storage budget still applies)'),
  },
  previews: {
    tileSize: size('preview tile size, WxH'),
    grid: { type: 'string', pattern: '^[1-9][0-9]?x[1-9][0-9]?$', doc: 'sprite grid, CxR; holds one minute of tiles' },
    quality: int(2, 31, 'ffmpeg JPEG quality for tiles'),
    maxGB: unset(int(1, 100000, 'size cap for previews', true), 'no size cap for previews (the storage budget still applies)'),
  },
  events: {
    onvif: {
      subscribeMin: int(1, 60, 'ONVIF subscription lifetime, minutes'),
      pullTimeoutS: int(1, 60, 'ONVIF PullMessages timeout, seconds'),
    },
    poll: {
      enabled: { type: 'boolean', doc: 'poll GetMdState/GetAiState while ONVIF is down' },
      intervalS: int(1, 60, 'polling interval, seconds'),
      afterOnvifDownS: int(0, 3600, 'start polling after ONVIF is down this long'),
    },
    maxOpenMin: int(1, 1440, 'close an event still open after this many minutes'),
  },
  retention: {
    stillsDays: int(1, 365, 'days of stills'),
    previewsDays: int(1, 365, 'days of preview sprites'),
    clipsDays: int(1, 365, 'days of clips'),
    eventsDays: int(1, 3650, 'days of events'),
    auditDays: int(1, 3650, 'days of the audit log'),
    streamLogDays: int(1, 365, 'days of the SSE stream log'),
    intervalMin: int(1, 1440, 'minutes between storage runs'),
  },
  storage: {
    maxPercent: unset(int(10, 99, 'size budget, percent of the disk', true), 'no percent budget: storage.maxBytes applies'),
    maxBytes: unset(int(1, Number.MAX_SAFE_INTEGER, 'size budget, bytes (instead of maxPercent)', true), 'no byte budget: storage.maxPercent applies'),
    minFreeBytes: int(0, Number.MAX_SAFE_INTEGER, 'stop writing below this much free space'),
    keepHours: {
      stills: int(0, 8760, 'hours of stills never deleted for the budget'),
      clips: int(0, 8760, 'hours of clips never deleted for the budget'),
      previews: int(0, 8760, 'hours of previews never deleted for the budget'),
    },
  },
  composition: {
    font: unset({ type: 'string', pattern: '^.+$', optional: true, doc: 'font file for the badge and card text of composed clips; default: the first of DejaVu Sans (Alpine, Debian) or Arial (macOS) that exists' }, 'the first of DejaVu Sans or Arial that exists'),
  },
  sse: {
    maxClients: int(1, 1000, 'most SSE clients at once'),
    queuePerClient: int(10, 100000, 'messages queued per SSE client before it is dropped'),
    pingS: int(1, 300, 'seconds between keep-alive pings'),
  },
  recordings: {
    cacheMB: int(64, 1_048_576, 'size cap of the recordings cache, MB; least recently used files go first'),
  },
  ftp: {
    enabled: unset({ type: 'boolean', doc: 'accept clip uploads from the camera' }, 'no clip uploads from the camera', false),
    port: port('FTP control port'),
    passive: { type: 'string', pattern: '^[1-9][0-9]{0,4}-[1-9][0-9]{0,4}$', doc: 'passive port range, A-B' },
    user: LEGACY_FTP_USER,
    tls: { type: 'boolean', doc: 'require FTPS' },
    stream: { type: 'string', enum: ['main', 'sub'], doc: 'the stream the camera uploads' },
    stalledHours: int(1, 72, 'warn on the Status page when no clip arrived for this many hours while the camera recorded events'),
    maxGB: unset(int(1, 100000, 'size cap for clips', true), 'no size cap for clips (the storage budget still applies)'),
    publicHost: unset({ type: 'string', pattern: '^[A-Za-z0-9.:-]{1,253}$', optional: true, doc: 'the address the camera connects to (PASV replies and the camera FTP setup)' }, "PASV answers the connection's own address; the camera's FTP setup can't be set from here"),
    certFile: unset({ type: 'string', pattern: '^.+$', optional: true, doc: 'FTPS certificate (PEM); a self-signed one otherwise' }, 'a self-signed FTPS certificate'),
    keyFile: unset({ type: 'string', pattern: '^.+$', optional: true, doc: 'FTPS key (PEM)' }, 'the key of the self-signed FTPS certificate'),
  },
  // The health summary (spec 2026-10-03-health-summary-design): the Status
  // page's Health card and GET /api/local/health flag a problem at these.
  health: {
    diskPercent: int(50, 99, "the data volume's used space, percent, from which the health summary flags a problem"),
    tempC: int(40, 95, 'the CPU temperature, °C, from which the health summary flags a problem (on a Raspberry Pi)'),
  },
  host: {
    stats: { type: 'string', enum: ['auto', 'on', 'off'], doc: 'read the host figures (CPU temperature, under-voltage, memory, uptime, load): auto on a Raspberry Pi only, on, or off' },
  },
  // The Archive (spec 2026-10-05-archive-design §6): clips kept apart from
  // retention, in <dataDir>/archive. Both apply at once.
  archive: {
    enabled: { type: 'boolean', doc: 'take new clips into the Archive (reading, editing, deleting and its daily cleanup go on when off)' },
    warnPercent: int(1, 99, "the Archive's size, percent of the data volume, above which the Status page and the health summary warn (no limit)"),
  },
  analytics: {
    kinds: {
      person: unset({ type: 'boolean', doc: 'analyse person events' }, 'person events are not analysed', false),
      vehicle: unset({ type: 'boolean', doc: 'analyse vehicle events' }, 'vehicle events are not analysed', false),
      pet: unset({ type: 'boolean', doc: 'analyse pet events' }, 'pet events are not analysed', false),
    },
    googleVision: {
      enabled: unset({ type: 'boolean', doc: 'send event stills to Google Vision (needs CAMPROXY_GOOGLE_VISION_KEY)' }, 'no stills sent to Google Vision', false),
      monthlyLimit: unset(int(0, 100000, 'Google Vision calls per calendar month (camera time); 0 = none'), 'no Google Vision calls', 0),
      dailyCap: unset(int(0, 10000, 'Google Vision calls per day at most; 0 = no daily cap'), 'no daily cap (the monthly limit still applies)', 0),
      checksPerDay: unset(int(0, 1000, 'still checks (a second picked by hand in cams) per camera day at most, within the monthly limit and the daily cap; 0 = no checks'), 'no still checks', 0),
    },
  },
};


export class SettingError extends Error {}

export function checkValue(path: string, leaf: Leaf, v: unknown): void {
  const bad = (why: string) => {
    throw new SettingError(`${path}: ${why}`);
  };
  if (leaf.type === 'boolean') {
    if (typeof v !== 'boolean') bad('must be true or false');
  } else if (leaf.type === 'integer') {
    if (typeof v !== 'number' || !Number.isInteger(v)) bad('must be a whole number');
    const n = v as number;
    if (n < leaf.min || n > leaf.max) bad(`must be from ${leaf.min} to ${leaf.max}`);
    if (leaf.oneOf && !leaf.oneOf.includes(n)) bad(`must be one of ${leaf.oneOf.join(', ')}`);
  } else {
    if (typeof v !== 'string') bad('must be a string');
    const s = v as string;
    if (leaf.enum && !leaf.enum.includes(s)) bad(`must be one of ${leaf.enum.join(', ')}`);
    if (leaf.pattern && !new RegExp(leaf.pattern).test(s)) bad('has the wrong format');
    if (/^[1-9][0-9]*x[1-9][0-9]*$/.test(s) && leaf.pattern?.includes('{1,4}x')) {
      const [w, h] = s.split('x').map(Number);
      if (w % 2 || h % 2) bad('width and height must be even');
    }
  }
}

// Checks a (partial) settings object: every key must be known and every
// value valid. Throws SettingError naming the full path. A collection is an
// object keyed by camera id.
export function checkPartial(obj: unknown, node: Node = SETTINGS, prefix = ''): void {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new SettingError(`${prefix || 'config'}: must be an object`);
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (!Object.hasOwn(node, k)) throw new SettingError(`${path}: unknown setting`);
    const child = node[k];
    if (isLeaf(child)) checkValue(path, child, v);
    else if (isCollection(child)) {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SettingError(`${path}: must be an object`);
      for (const [id, entry] of Object.entries(v)) {
        if (!new RegExp(CAMERA_ID).test(id)) throw new SettingError(`${path}.${id}: not a camera id`);
        checkPartial(entry, child.collection, `${path}.${id}`);
        const own = (entry as Record<string, unknown>).id;
        if (own !== undefined && own !== id) throw new SettingError(`${path}.${id}.id: must be the camera's key (${id})`);
      }
    } else checkPartial(v, child, path);
  }
}

// Every leaf path, e.g. 'sse.pingS'; a collection expands to each of `ids`.
export function leafPaths(node: Node = SETTINGS, prefix = '', ids: string[] = []): string[] {
  return Object.entries(node).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isLeaf(v)) return [path];
    if (isCollection(v)) return ids.flatMap((id) => leafPaths(v.collection, `${path}.${id}`));
    return leafPaths(v, path, ids);
  });
}

// The description of one setting, e.g. leafAt('sse.pingS'); a collection
// consumes one id segment (leafAt('cameras.cam3.host')).
export function leafAt(path: string, node: Node = SETTINGS): Leaf | undefined {
  let n: Node | Leaf | Collection | undefined = node;
  const keys = path.split('.');
  for (let i = 0; i < keys.length && n; i++) {
    if (isLeaf(n)) return undefined;
    if (isCollection(n)) {
      n = n.collection; // keys[i] is the id
      continue;
    }
    n = Object.hasOwn(n, keys[i]) ? n[keys[i]] : undefined;
  }
  return n && isLeaf(n) ? n : undefined;
}

// The JSON Schema written to config.schema.json (see scripts/gen-schema.ts); a
// collection is an array of its node, id required.
export function jsonSchema(node: Node = SETTINGS, extra: Record<string, object> = {}): object {
  const leaf = (v: Leaf) =>
    v.type === 'boolean' ? { type: 'boolean', description: v.doc }
    : v.type === 'integer' ? { type: 'integer', minimum: v.min, maximum: v.max, ...(v.oneOf ? { enum: v.oneOf } : {}), description: v.doc }
    : { type: 'string', ...(v.enum ? { enum: v.enum } : {}), ...(v.pattern ? { pattern: v.pattern } : {}), description: v.doc };
  const conv = (n: Node): object => ({
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(Object.entries(n).map(([k, v]) => [k, isLeaf(v) ? leaf(v) : isCollection(v) ? { type: 'array', description: v.doc, items: { ...conv(v.collection), required: ['id'] } } : conv(v)])),
  });
  const root = conv(node) as { properties: Record<string, object> };
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'cam-proxy config.json', ...root, properties: { ...root.properties, ...extra } };
}
