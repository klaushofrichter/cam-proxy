import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { nameConstraintsDer, parseNameConstraints } from '../src/tls/der';

describe('NameConstraints DER (RFC 5280 §4.2.1.10)', () => {
  it('permittedSubtrees: a dNSName and an iPAddress with its mask', () => {
    const der = nameConstraintsDer({ dns: ['g.internal'], ip: [{ address: '192.168.60.0', prefix: 24 }] });
    expect(der.toString('hex')).toBe(
      '301c' + // NameConstraints SEQUENCE
        'a01a' + // [0] permittedSubtrees
        '300c' + '820a' + Buffer.from('g.internal').toString('hex') + // GeneralSubtree { [2] dNSName }
        '300a' + '8708' + 'c0a83c00' + 'ffffff00', // GeneralSubtree { [7] iPAddress addr+mask }
    );
  });
  it('a /32 for one address', () => {
    expect(nameConstraintsDer({ dns: [], ip: [{ address: '192.168.1.230', prefix: 32 }] }).toString('hex')).toBe('300ea00c300a87' + '08c0a801e6ffffffff');
  });
  it('refuses what it cannot encode exactly', () => {
    expect(() => nameConstraintsDer({ dns: [], ip: [{ address: '192.168.1.0', prefix: 33 }] })).toThrow(/prefix/);
    expect(() => nameConstraintsDer({ dns: [], ip: [{ address: '192.168.1.256', prefix: 32 }] })).toThrow(/IPv4/);
  });
  it('reads back what it wrote (the CA checks its own constraints, not the settings)', () => {
    const p = { dns: ['garage.internal'], ip: [{ address: '192.168.60.0', prefix: 24 }, { address: '192.168.1.230', prefix: 32 }] };
    expect(parseNameConstraints(nameConstraintsDer(p))).toEqual(p);
    expect(() => parseNameConstraints(Buffer.from('3003020101', 'hex'))).toThrow();
  });
  it.skipIf(spawnSync('openssl', ['version']).status !== 0)('openssl parses it', () => {
    const der = nameConstraintsDer({ dns: ['garage.internal'], ip: [{ address: '192.168.60.0', prefix: 24 }] });
    const r = spawnSync('openssl', ['asn1parse', '-inform', 'DER'], { input: der, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('cont [ 0 ]');
  });
});
