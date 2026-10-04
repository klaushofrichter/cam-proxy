import { randomUUID } from 'crypto';
import dgram from 'dgram';
import { elements, field } from '../events/soap';

// "Find camera" (spec 2026-10-04-pi-config-design §3): one ONVIF
// WS-Discovery Probe for NetworkVideoTransmitter to the multicast group, and
// the ProbeMatches that come back within the timeout. No login: a Probe
// answer is public. Answers are untrusted input: parsed with the linear SOAP
// scanner, bounded in size and count, text fields cut and cleaned.

export const WS_DISCOVERY = { address: '239.255.255.250', port: 3702 };
const MAX_DEVICES = 64;
const MAX_DATAGRAM = 64 * 1024;
const MAX_TEXT = 64;

export interface FoundDevice {
  endpoint: string; // the device's EndpointReference (urn:uuid:…)
  address: string; // the first XAddr's host (IPv4 first), without the ONVIF port
  sender: string; // where the answer came from (the UDP source address)
  mismatch: boolean; // the XAddr host is not the sender: a device that names another address
  useAddress: string; // what "Use this address" writes: the address when they agree, else the sender
  xaddrs: string[];
  name: string | null;
  hardware: string | null;
  model: string | null; // a model scope, else the hardware scope
}

export function probeXml(messageId: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" ' +
    'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">' +
    `<s:Header><a:MessageID>${messageId}</a:MessageID><a:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To>` +
    '<a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action></s:Header>' +
    '<s:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></s:Body></s:Envelope>'
  );
}

// Shown as text: %-decoded, no control characters, at most 64 characters.
function clean(v: string | undefined): string | null {
  if (!v) return null;
  let s = v;
  try {
    s = decodeURIComponent(v);
  } catch {
    // not %-encoded
  }
  s = s.replace(/\p{C}/gu, '').trim().slice(0, MAX_TEXT);
  return s || null;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

// The device's address from its XAddrs: an IPv4 one first, else a name.
function addressOf(xaddrs: string[]): string | undefined {
  const hosts = xaddrs.flatMap((x) => {
    try {
      const u = new URL(x);
      return u.protocol === 'http:' || u.protocol === 'https:' ? [u.hostname] : [];
    } catch {
      return [];
    }
  });
  return hosts.find((h) => IPV4.test(h)) ?? hosts.find((h) => NAME.test(h));
}

function scope(scopes: string[], kind: string): string | null {
  const prefix = `onvif://www.onvif.org/${kind}/`;
  const s = scopes.find((x) => x.startsWith(prefix));
  return s ? clean(s.slice(prefix.length)) : null;
}

// The ProbeMatches in one answer to the Probe `messageId` (others: none).
// `sender`: the UDP source address; without it the XAddr host stands in.
export function parseProbeMatches(xml: string, messageId: string, sender?: string): FoundDevice[] {
  if (field(xml, 'RelatesTo') !== messageId) return [];
  const starts: number[] = [];
  for (const el of elements(xml)) if (el.local === 'ProbeMatch') starts.push(el.start);
  const out: FoundDevice[] = [];
  starts.forEach((from, i) => {
    const to = starts[i + 1] ?? xml.length;
    const xaddrs = (field(xml, 'XAddrs', from, to) ?? '').split(/\s+/).filter(Boolean).slice(0, 8).map((x) => x.slice(0, 256));
    const address = addressOf(xaddrs);
    if (!address) return;
    const scopes = (field(xml, 'Scopes', from, to) ?? '').split(/\s+/).filter(Boolean).slice(0, 64);
    const hardware = scope(scopes, 'hardware');
    out.push({
      endpoint: clean(field(xml, 'Address', from, to)) ?? address,
      address,
      sender: sender ?? address,
      mismatch: sender !== undefined && sender.toLowerCase() !== address.toLowerCase(),
      useAddress: sender ?? address,
      xaddrs,
      name: scope(scopes, 'name'),
      hardware,
      model: scope(scopes, 'model') ?? hardware,
    });
  });
  return out;
}

// Probes (twice: UDP may drop one) and collects the answers for `timeoutMs`.
// `target`: the multicast group by default; tests send to a fake on 127.0.0.1.
export async function discover(o: { timeoutMs?: number; target?: { address: string; port: number } } = {}): Promise<{ devices: FoundDevice[]; tookMs: number }> {
  const t0 = Date.now();
  const target = o.target ?? WS_DISCOVERY;
  const timeoutMs = o.timeoutMs ?? 3000;
  const messageId = `uuid:${randomUUID()}`;
  const probe = Buffer.from(probeXml(messageId), 'utf8');
  const found = new Map<string, FoundDevice>();
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('message', (msg, rinfo) => {
    if (msg.length > MAX_DATAGRAM || found.size >= MAX_DEVICES) return;
    for (const d of parseProbeMatches(msg.toString('utf8'), messageId, rinfo.address.replace(/^::ffff:/, ''))) {
      if (found.size >= MAX_DEVICES) break;
      if (!found.has(d.endpoint)) found.set(d.endpoint, d);
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, () => {
        socket.off('error', reject);
        resolve();
      });
    });
    socket.on('error', () => undefined); // a late send error ends nothing
    const send = () => socket.send(probe, target.port, target.address, () => undefined);
    send();
    const again = setTimeout(send, Math.min(250, timeoutMs / 4));
    await new Promise((r) => setTimeout(r, timeoutMs));
    clearTimeout(again);
  } finally {
    socket.close();
  }
  return { devices: [...found.values()], tookMs: Date.now() - t0 };
}
