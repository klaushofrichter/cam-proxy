import dgram from 'dgram';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { discover, parseProbeMatches, probeXml } from '../src/camera/discovery';

// Spec 2026-10-04-pi-config-design §3: ONVIF WS-Discovery. The Reolink sample
// is documented, not captured (test/fixtures/ws-discovery/README.md).

const SAMPLE = readFileSync(join(__dirname, 'fixtures', 'ws-discovery', 'reolink-probe-match.xml'), 'utf8');
const reolink = (relatesTo: string) => SAMPLE.replace('{{RELATES_TO}}', relatesTo);
const ID = 'uuid:7c4f8f2e-1111-4222-8333-444455556666';

// Another vendor's answer: two XAddrs, a %-encoded name, a model scope.
const other = (relatesTo: string, ip = '192.168.1.30') => `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"><s:Header><a:RelatesTo>${relatesTo}</a:RelatesTo></s:Header><s:Body><d:ProbeMatches><d:ProbeMatch><a:EndpointReference><a:Address>urn:uuid:aaaa-bbbb</a:Address></a:EndpointReference><d:Types>dn:NetworkVideoTransmitter</d:Types><d:Scopes>onvif://www.onvif.org/name/Garage%20Cam onvif://www.onvif.org/model/XY-100 onvif://www.onvif.org/hardware/XY</d:Scopes><d:XAddrs>http://${ip}/onvif/device_service http://[fe80::1]/onvif/device_service</d:XAddrs></d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>`;

describe('probeXml', () => {
  it('is a WS-Discovery Probe for NetworkVideoTransmitter with our MessageID', () => {
    const x = probeXml(ID);
    expect(x).toContain(`<a:MessageID>${ID}</a:MessageID>`);
    expect(x).toContain('<a:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To>');
    expect(x).toContain('<a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action>');
    expect(x).toContain('<d:Types>dn:NetworkVideoTransmitter</d:Types>');
    expect(x).toContain('xmlns:dn="http://www.onvif.org/ver10/network/wsdl"');
  });
});

describe('parseProbeMatches', () => {
  it('reads the Reolink sample: address from XAddrs (no ONVIF port), name and hardware from the scopes', () => {
    expect(parseProbeMatches(reolink(ID), ID, '192.168.1.20')).toEqual([
      { endpoint: 'urn:uuid:2419d68a-2dd2-21b2-a205-ec71db000001', address: '192.168.1.20', sender: '192.168.1.20', mismatch: false, useAddress: '192.168.1.20', xaddrs: ['http://192.168.1.20:8000/onvif/device_service'], name: 'RLC-1224A', hardware: 'RLC-1224A', model: 'RLC-1224A' },
    ]);
  });
  it('flags an XAddr that differs from the address the answer came from, and uses the sender then', () => {
    expect(parseProbeMatches(reolink(ID), ID, '192.168.1.66')[0]).toMatchObject({ address: '192.168.1.20', sender: '192.168.1.66', mismatch: true, useAddress: '192.168.1.66' });
  });
  it('decodes scopes, prefers an IPv4 XAddr, and reads a model scope', () => {
    expect(parseProbeMatches(other(ID), ID)[0]).toMatchObject({ address: '192.168.1.30', name: 'Garage Cam', hardware: 'XY', model: 'XY-100' });
  });
  it('ignores answers to another probe, and junk', () => {
    expect(parseProbeMatches(reolink('uuid:other'), ID)).toEqual([]);
    expect(parseProbeMatches('not xml at all', ID)).toEqual([]);
    expect(parseProbeMatches('<a><b>', ID)).toEqual([]);
  });
  it('cuts long fields and drops control characters', () => {
    const x = other(ID).replace('Garage%20Cam', `${'N'.repeat(100)}%07`);
    expect(parseProbeMatches(x, ID)[0].name).toBe('N'.repeat(64));
  });
  it('skips a match without a usable XAddr', () => {
    expect(parseProbeMatches(other(ID).replace(/<d:XAddrs>.*<\/d:XAddrs>/, '<d:XAddrs>urn:nothing</d:XAddrs>'), ID)).toEqual([]);
  });
});

describe('discover', () => {
  const sockets: dgram.Socket[] = [];
  afterEach(() => {
    for (const s of sockets.splice(0)) s.close();
  });
  // A fake camera on 127.0.0.1 that answers each Probe like the sample.
  const fake = async (answer: (messageId: string) => string[]) => {
    const s = dgram.createSocket('udp4');
    sockets.push(s);
    const probes: string[] = [];
    s.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      probes.push(text);
      const id = /<a:MessageID>([^<]+)<\/a:MessageID>/.exec(text)?.[1] ?? '';
      for (const a of answer(id)) s.send(a, rinfo.port, rinfo.address);
    });
    await new Promise<void>((r) => s.bind(0, '127.0.0.1', () => r()));
    return { port: (s.address() as { port: number }).port, probes };
  };

  it('sends the Probe twice, collects the answers for the timeout and merges duplicates', async () => {
    const f = await fake((id) => [reolink(id), other(id), reolink('uuid:someone-else')]);
    const r = await discover({ target: { address: '127.0.0.1', port: f.port }, timeoutMs: 400 });
    expect(f.probes).toHaveLength(2);
    expect(r.devices.map((d) => d.address).sort()).toEqual(['192.168.1.20', '192.168.1.30']);
    // The fake answers from 127.0.0.1: the sender, flagged as a mismatch.
    expect(r.devices.every((d) => d.sender === '127.0.0.1' && d.mismatch && d.useAddress === '127.0.0.1')).toBe(true);
    expect(r.tookMs).toBeGreaterThanOrEqual(350);
  });

  it('answers an empty list when nothing answers', async () => {
    const f = await fake(() => []);
    const r = await discover({ target: { address: '127.0.0.1', port: f.port }, timeoutMs: 200 });
    expect(r.devices).toEqual([]);
  });

  it('keeps at most 64 devices', async () => {
    const f = await fake((id) => Array.from({ length: 70 }, (_, i) => other(id, `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}`).replace('urn:uuid:aaaa-bbbb', `urn:uuid:dev-${i}`)));
    const r = await discover({ target: { address: '127.0.0.1', port: f.port }, timeoutMs: 400 });
    expect(r.devices).toHaveLength(64);
  });
});
