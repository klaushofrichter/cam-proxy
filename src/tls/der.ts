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
