// IPv4 addresses and networks (config checks, the FTP login's source address).

export const ipv4Int = (ip: string): number | null => {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? parts.reduce((n, x) => n * 256 + x, 0) : null;
};

// Whether ip (dotted, or IPv4-mapped IPv6 as sockets report it) lies in cidr (a.b.c.d/n).
export function inCidr(ip: string, cidr: string): boolean {
  const [net, bits] = cidr.split('/');
  const a = ipv4Int(ip.replace(/^::ffff:/i, ''));
  const n = ipv4Int(net);
  const prefix = Number(bits);
  if (a === null || n === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const size = 2 ** (32 - prefix);
  return Math.floor(a / size) === Math.floor(n / size);
}
