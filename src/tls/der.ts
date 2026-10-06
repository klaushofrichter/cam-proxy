// DER for the site CA's name constraints (spec 2026-10-05-multi-camera-host-design
// §10.1.1): NameConstraints ::= SEQUENCE { permittedSubtrees [0] GeneralSubtrees }
// with dNSName [2] and iPAddress [7] (address and mask, 8 bytes for IPv4).
// Small and exact: the X.509 library has no builder for it.
const len = (n: number): number[] => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]);
const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag, ...len(body.length)]), body]);

export function ipv4Bytes(ip: string): number[] {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) throw new Error(`${ip}: not an IPv4 address`);
  return parts;
}

const maskBytes = (prefix: number): number[] => {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error(`/${prefix}: not an IPv4 prefix length`);
  const m = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return [24, 16, 8, 0].map((s) => (m >>> s) & 0xff);
};

export function nameConstraintsDer(p: { dns: string[]; ip: { address: string; prefix: number }[] }): Buffer {
  const subtrees = [
    ...p.dns.map((d) => tlv(0x30, tlv(0x82, Buffer.from(d, 'ascii')))),
    ...p.ip.map((r) => tlv(0x30, tlv(0x87, Buffer.from([...ipv4Bytes(r.address), ...maskBytes(r.prefix)])))),
  ];
  return tlv(0x30, tlv(0xa0, Buffer.concat(subtrees)));
}

// Reads one TLV at `at`: its tag, and where its body starts and ends.
function readTlv(b: Buffer, at: number): { tag: number; start: number; end: number } {
  if (at + 2 > b.length) throw new Error('NameConstraints: truncated');
  const tag = b[at];
  let n = b[at + 1];
  let start = at + 2;
  if (n & 0x80) {
    const k = n & 0x7f;
    if (k < 1 || k > 2 || start + k > b.length) throw new Error('NameConstraints: bad length');
    n = k === 1 ? b[start] : (b[start] << 8) | b[start + 1];
    start += k;
  }
  if (start + n > b.length) throw new Error('NameConstraints: truncated');
  return { tag, start, end: start + n };
}

const prefixOf = (mask: number[]): number => {
  const bits = mask.map((x) => x.toString(2).padStart(8, '0')).join('');
  if (!/^1*0*$/.test(bits)) throw new Error('NameConstraints: a non-contiguous mask');
  return bits.indexOf('0') === -1 ? 32 : bits.indexOf('0');
};

// The inverse of nameConstraintsDer, for the CA's own extension: what the
// certificate really permits (the settings may have moved since, Ruling P5-3).
// Only the shapes nameConstraintsDer writes are accepted.
export function parseNameConstraints(der: Buffer): { dns: string[]; ip: { address: string; prefix: number }[] } {
  const seq = readTlv(der, 0);
  if (seq.tag !== 0x30 || seq.end !== der.length) throw new Error('NameConstraints: not a SEQUENCE');
  const out = { dns: [] as string[], ip: [] as { address: string; prefix: number }[] };
  if (seq.start === seq.end) return out;
  const permitted = readTlv(der, seq.start);
  if (permitted.tag !== 0xa0 || permitted.end !== seq.end) throw new Error('NameConstraints: only permittedSubtrees is supported');
  for (let at = permitted.start; at < permitted.end; ) {
    const sub = readTlv(der, at);
    if (sub.tag !== 0x30) throw new Error('NameConstraints: a GeneralSubtree is not a SEQUENCE');
    const name = readTlv(der, sub.start);
    if (name.end !== sub.end) throw new Error('NameConstraints: minimum/maximum are not supported');
    const body = der.subarray(name.start, name.end);
    if (name.tag === 0x82) out.dns.push(body.toString('ascii'));
    else if (name.tag === 0x87 && body.length === 8) out.ip.push({ address: [...body.subarray(0, 4)].join('.'), prefix: prefixOf([...body.subarray(4)]) });
    else throw new Error(`NameConstraints: unsupported name form 0x${name.tag.toString(16)}`);
    at = sub.end;
  }
  return out;
}
