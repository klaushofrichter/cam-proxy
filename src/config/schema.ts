// The description of every setting: one place that drives validation and the
// generated config.schema.json, so the two can't drift apart.

type Leaf =
  | { type: 'integer'; min: number; max: number; optional?: boolean; oneOf?: number[]; doc: string }
  | { type: 'boolean'; doc: string }
  | { type: 'string'; enum?: string[]; pattern?: string; optional?: boolean; doc: string };
export type Node = { [key: string]: Node | Leaf };

const port = (doc: string): Leaf => ({ type: 'integer', min: 1, max: 65535, doc });
const int = (min: number, max: number, doc: string, optional = false): Leaf => ({ type: 'integer', min, max, doc, optional });
const size = (doc: string): Leaf => ({ type: 'string', pattern: '^[1-9][0-9]{1,4}x[1-9][0-9]{1,4}$', doc });

const SETTINGS: Node = {
  server: {
    port: port('HTTP port for the API, control API and admin UI'),
    dataDir: { type: 'string', pattern: '^.+$', doc: 'data folder; relative to the config file' },
    logLevel: { type: 'string', enum: ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], doc: 'pino log level' },
    trustProxy: int(0, 5, 'reverse proxies in front (the cluster ingress: 1); rate limits then count clients by X-Forwarded-For', true),
    publicUrl: { type: 'string', pattern: '^https?://[^\\s]+$', optional: true, doc: 'where people reach this proxy (its admin UI); reported in /api/cameras so clients can link to it' },
  },
  camera: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,31}$', doc: 'camera id used in paths and the API' },
    name: { type: 'string', pattern: '^.{1,64}$', doc: "fallback display name until the camera's own name is read (the camera stores its name)" },
    host: { type: 'string', pattern: '^[^\\s/]*$', doc: 'address or name, optional :port (required)' },
    protocol: { type: 'string', enum: ['https', 'http'], doc: 'camera HTTP API protocol' },
    tlsName: { type: 'string', pattern: '^[^\\s]+$', optional: true, doc: 'verify the camera certificate against this name' },
    webUiUrl: { type: 'string', pattern: '^(https?://[^\\s]+|none)$', optional: true, doc: "the camera's own web page, linked from the admin UI; default https://<host>/, none for no link" },
    user: { type: 'string', pattern: '^[^\\s:]{1,31}$', doc: "the proxy's own camera user" },
    onvifPort: port('camera ONVIF port'),
    rtspPort: port('camera RTSP port'),
    baichuanPort: port("camera Baichuan port (recordings over TCP); the host is camera.host's"),
    statusPollS: int(5, 3600, 'seconds between status checks'),
    // The PoE switch the camera hangs on (issue #85): power-cycle the camera
    // through it. Applies at once; the password is CAMPROXY_POE_SWITCH_PASSWORD.
    poeSwitch: {
      model: { type: 'string', enum: ['none', 'sscpoe-web'], doc: "the camera's PoE switch: none, or sscpoe-web (the STEAMEMO/SSCPOE local web protocol: GPS-208 and kin)" },
      host: { type: 'string', pattern: '^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$', optional: true, doc: "the switch's address or name, optional :port (http)" },
      port: int(1, 48, 'the switch port the camera is on, as numbered on the switch', true),
      ports: int(1, 48, "the switch's PoE port count (maps the port to its internal index)"),
      offSeconds: int(5, 60, 'seconds the PoE stays off in a power-cycle'),
    },
  },
  go2rtc: {
    binary: { type: 'string', pattern: '^.+$', optional: true, doc: 'go2rtc binary started by the proxy' },
    url: { type: 'string', pattern: '^https?://[^\\s]+$', optional: true, doc: 'go2rtc API when it runs as its own container' },
    rtspPort: port('go2rtc local RTSP port'),
    apiPort: port('go2rtc local API port'),
  },
  stills: {
    enabled: { type: 'boolean', doc: 'store stills' },
    stream: { type: 'string', enum: ['sub', 'main'], doc: 'camera stream the stills come from' },
    intervalS: { type: 'integer', min: 1, max: 60, oneOf: [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60], doc: 'seconds between stills (divides a minute)' },
    size: size('still size, WxH'),
    quality: int(2, 31, 'ffmpeg JPEG quality (q:v); lower is better'),
    maxGB: int(1, 100000, 'size cap for stills', true),
  },
  previews: {
    tileSize: size('preview tile size, WxH'),
    grid: { type: 'string', pattern: '^[1-9][0-9]?x[1-9][0-9]?$', doc: 'sprite grid, CxR; holds one minute of tiles' },
    quality: int(2, 31, 'ffmpeg JPEG quality for tiles'),
    maxGB: int(1, 100000, 'size cap for previews', true),
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
    maxPercent: int(10, 99, 'size budget, percent of the disk', true),
    maxBytes: int(1, Number.MAX_SAFE_INTEGER, 'size budget, bytes (instead of maxPercent)', true),
    minFreeBytes: int(0, Number.MAX_SAFE_INTEGER, 'stop writing below this much free space'),
    keepHours: {
      stills: int(0, 8760, 'hours of stills never deleted for the budget'),
      clips: int(0, 8760, 'hours of clips never deleted for the budget'),
      previews: int(0, 8760, 'hours of previews never deleted for the budget'),
    },
  },
  composition: {
    font: { type: 'string', pattern: '^.+$', optional: true, doc: 'font file for the badge and card text of composed clips; default: the first of DejaVu Sans (Alpine, Debian) or Arial (macOS) that exists' },
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
    enabled: { type: 'boolean', doc: 'accept clip uploads from the camera' },
    port: port('FTP control port'),
    passive: { type: 'string', pattern: '^[1-9][0-9]{0,4}-[1-9][0-9]{0,4}$', doc: 'passive port range, A-B' },
    user: { type: 'string', pattern: '^[^\\s:]{1,31}$', doc: 'FTP user the camera logs in as' },
    tls: { type: 'boolean', doc: 'require FTPS' },
    stream: { type: 'string', enum: ['main', 'sub'], doc: 'the stream the camera uploads' },
    stalledHours: int(1, 72, 'warn on the Status page when no clip arrived for this many hours while the camera recorded events'),
    maxGB: int(1, 100000, 'size cap for clips', true),
    publicHost: { type: 'string', pattern: '^[A-Za-z0-9.:-]{1,253}$', optional: true, doc: 'the address the camera connects to (PASV replies and the camera FTP setup)' },
    certFile: { type: 'string', pattern: '^.+$', optional: true, doc: 'FTPS certificate (PEM); a self-signed one otherwise' },
    keyFile: { type: 'string', pattern: '^.+$', optional: true, doc: 'FTPS key (PEM)' },
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
      person: { type: 'boolean', doc: 'analyse person events' },
      vehicle: { type: 'boolean', doc: 'analyse vehicle events' },
      pet: { type: 'boolean', doc: 'analyse pet events' },
    },
    googleVision: {
      enabled: { type: 'boolean', doc: 'send event stills to Google Vision (needs CAMPROXY_GOOGLE_VISION_KEY)' },
      monthlyLimit: int(0, 100000, 'Google Vision calls per calendar month (camera time); 0 = none'),
      dailyCap: int(0, 10000, 'Google Vision calls per day at most; 0 = no daily cap'),
      checksPerDay: int(0, 1000, 'still checks (a second picked by hand in cams) per camera day at most, within the monthly limit and the daily cap; 0 = no checks'),
    },
  },
};

const isLeaf = (n: Node | Leaf): n is Leaf => typeof (n as Leaf).type === 'string' && typeof (n as Leaf).doc === 'string';

export class SettingError extends Error {}

function checkLeaf(path: string, leaf: Leaf, v: unknown): void {
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
// value valid. Throws SettingError naming the full path.
export function checkPartial(obj: unknown, node: Node = SETTINGS, prefix = ''): void {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new SettingError(`${prefix || 'config'}: must be an object`);
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (!Object.hasOwn(node, k)) throw new SettingError(`${path}: unknown setting`);
    const child = node[k];
    if (isLeaf(child)) checkLeaf(path, child, v);
    else checkPartial(v, child, path);
  }
}

// Every leaf path, e.g. 'sse.pingS'.
export function leafPaths(node: Node = SETTINGS, prefix = ''): string[] {
  return Object.entries(node).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return isLeaf(v) ? [path] : leafPaths(v, path);
  });
}

// The description of one setting, e.g. leafAt('sse.pingS').
export function leafAt(path: string): Leaf | undefined {
  let n: Node | Leaf | undefined = SETTINGS;
  for (const k of path.split('.')) n = n && !isLeaf(n) && Object.hasOwn(n, k) ? n[k] : undefined;
  return n && isLeaf(n) ? n : undefined;
}

// The JSON Schema written to config.schema.json (see scripts/gen-schema.ts).
export function jsonSchema(): object {
  const conv = (node: Node): object => ({
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(
      Object.entries(node).map(([k, v]) => {
        if (!isLeaf(v)) return [k, conv(v)];
        if (v.type === 'boolean') return [k, { type: 'boolean', description: v.doc }];
        if (v.type === 'integer') return [k, { type: 'integer', minimum: v.min, maximum: v.max, ...(v.oneOf ? { enum: v.oneOf } : {}), description: v.doc }];
        return [k, { type: 'string', ...(v.enum ? { enum: v.enum } : {}), ...(v.pattern ? { pattern: v.pattern } : {}), description: v.doc }];
      }),
    ),
  });
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'cam-proxy config.json', ...conv(SETTINGS) };
}
