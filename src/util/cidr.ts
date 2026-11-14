// IPv4 addresses and networks (config checks, the FTP login's source address).

// Plain decimal only: no signs, spaces, hex, exponents or leading zeros (010
// reads as 8 or 10 depending on who parses it).
const OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const PREFIX = /^(3[0-2]|[12]?\d)$/;

export const ipv4Int = (ip: string): number | null => {
  const parts = ip.split('.');
  return parts.length === 4 && parts.every((x) => OCTET.test(x)) ? parts.reduce((n, x) => n * 256 + Number(x), 0) : null;
};

// a.b.c.d/n: the network's address as a number and the prefix (a whole 0–32), or null.
export function parseCidr(cidr: string): { net: number; prefix: number } | null {
  const parts = cidr.split('/');
  if (parts.length !== 2 || !PREFIX.test(parts[1])) return null;
  const net = ipv4Int(parts[0]);
  return net === null ? null : { net, prefix: Number(parts[1]) };
}

// A socket's address without the IPv4-mapped prefix (::ffff:10.0.0.1 -> 10.0.0.1,
// any case), trimmed and lower-case so two forms of one address compare equal.
export const plainIp = (a: string | undefined): string => (a ?? '').trim().replace(/^::ffff:/i, '').toLowerCase();

// Whether ip (dotted, or IPv4-mapped IPv6 as sockets report it) lies in cidr (a.b.c.d/n).
export function inCidr(ip: string, cidr: string): boolean {
  const a = ipv4Int(plainIp(ip));
  const c = parseCidr(cidr);
  if (a === null || c === null) return false;
  const size = 2 ** (32 - c.prefix);
  return Math.floor(a / size) === Math.floor(c.net / size);
}
