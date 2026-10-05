# Multi-camera P5: TLS without DNS, the site CA (proxy side) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A proxy with `tls.site` set runs its own name-constrained CA, issues and pushes RSA 2048 certificates to its cameras (push_cert.py's logic inside cam-proxy), serves its API over HTTPS with its own leaf, publishes the CA at `GET /tls/ca.pem`, verifies its cameras against the CA, keeps their NTP pointed at the host, and reports certificate health — so the mini PC needs nothing from the cluster for camera TLS.

**Architecture:** A `tls/` module set in cam-proxy: a DER encoder for the name constraints, the CA (created once in `<dataDir>/tls`, never served), leaf issuance and renewal timing, a camera certificate push with the measured firmware rules, and a scheduler with one state per camera. The worker's camera client trusts the CA (and the camera's `.internal` name) once the camera serves its leaf; an import the camera refuses falls back to pinning the camera's own (factory) certificate, reported to cams in `GET /api/cameras`. cam-sim gets the refusal fault and `GetNtp`/`SetNtp` first (Part A), so every proxy test runs against it. The cams side of P5 (CA pin, `tlsServername`, fallback pins) is planned separately and consumes only the interfaces named in **Interfaces for cams** below.

**Tech Stack:** Node 26 (`crypto.webcrypto`, `tls`, `https`), `@peculiar/x509` (already in the tree through `selfsigned`; becomes a direct dependency), TypeScript 7, Express 5, vitest 5, Playwright, Svelte 5; cam-sim (its `GetCertificateInfo`, `CertificateClear`, `ImportCertificate`, HTTPS listener).

**Spec:** `docs/superpowers/specs/2026-10-05-multi-camera-host-design.md` (§10 entire, §11 the Pi stays as it is, §14.2 the chrony/NTP part, §15 tests and "measure on the real camera first", §16 row P5). Builds on the P1, P2 and P4 plans in `docs/superpowers/plans/2026-10-05-multi-camera-*.md`.

## Global Constraints

- The site CA is per host and lives inside cam-proxy; it signs only that host's proxy and its cameras; two hosts have two unrelated CAs; the Pi doesn't get one (`tls.site` unset there = today's behaviour, HTTP on 8480) (spec §10.1, §11).
- Root CA: generated on first start when `tls.site` is set; **RSA 3072, valid 10 years**, subject `CN=cam-proxy site CA <site>`, **critical X.509 name constraints**: permitted DNS `.<site>.internal`, permitted IP ranges the camera subnet and the host's own LAN address (/32); key in `<dataDir>/tls/ca.key`, mode 600, never served, never logged (spec §10.1.1).
- Leaves signed directly by the root (no intermediate). Camera leaves **RSA 2048, 397 days**, SANs `DNS:<camId>.<site>.internal` and `IP:<camera address>`; the proxy's leaf SANs `DNS:proxy.<site>.internal`, its LAN and camera-side IPs (spec §10.1.2).
- Push: compare the served fingerprint; if different, `GetCertificateInfo` → `CertificateClear` (wait 10 s, log in again) → `ImportCertificate` → wait up to 90 s for the new fingerprint; retry once with a clear; log out; success only by the served fingerprint. File names `server.crt` / `server.key`. Schedule: on adding a camera, when the served fingerprint is not the current leaf, renewal 30 days before expiry, at 04:00 camera time, one camera at a time, never during an open event (spec §10.1.3, §2 measured facts).
- `GET /tls/ca.pem`: public, no token, mounted before the admin UI's catch-all (spec §10.1.4, §10.4).
- Fallback: when a camera refuses the import, `GET /api/cameras` reports `tls: {mode: "pinned", fingerprint}` with the camera's served (factory) fingerprint (spec §10.1.4).
- Settings: `tls.site` (unset = off), `tls.cameraCerts` (default true when `tls.site` is set), `server.tls.port` (HTTPS with the proxy's leaf; unset = HTTP only); the HTTP listener on 8480 stays (spec §10.4).
- The proxy verifies each camera against the site CA once its leaf is served; a set `tlsName` still means public-CA verification (spec §10.4).
- `GET /api/cameras` → `tls: {mode: "site-ca" | "pinned" | "public" | "none", servername, fingerprint, notAfter, lastPush: {at, outcome}}` (spec §10.4).
- FTPS uses the proxy's leaf (spec §10.4).
- Health item `certificates`: a problem when any served camera certificate or the proxy's own expires within 14 days, or the last push of a camera failed; metrics `camproxy_cert_not_after_seconds{cam}`, `camproxy_cert_push_total{cam,outcome}` (spec §10.5).
- The proxy sets each camera's NTP server to the host (192.168.60.1) by a whole-object `SetNtp`, after `GetNtp` was measured (spec §14.2, §15).
- Real camera settings: whole-object Sets only, re-read after writing, log out afterwards (CLAUDE.md). Never on cam1 (spec §11, §15).
- Secrets and private keys never in a log line, an error message, an audit record or an API answer.

## Interfaces for cams (the other P5 plan consumes these; they don't change without both plans)

- `GET /tls/ca.pem` → `200 application/x-pem-file`, the CA certificate; `404 {error: 'no_site_ca'}` when `tls.site` is unset. No token.
- The CA fingerprint cams pins: `SHA256:` + the upper-case hex SHA-256 of the CA certificate's DER, colon-free (e.g. `SHA256:9F…`), shown on the Certificates card and in `GET /control/tls` (`caFingerprint`).
- `GET /api/cameras` item `tls`: `{ mode: 'site-ca' | 'pinned' | 'public' | 'none'; servername: string | null; fingerprint: string | null /* SHA256:… of the served leaf */; notAfter: number | null; lastPush: { at: number; outcome: 'pushed' | 'current' | 'refused' | 'failed' } | null }`.
- The proxy's HTTPS URL: `https://<LAN address>:<server.tls.port>` with servername `proxy.<site>.internal`; camera servername `<camId>.<site>.internal`.

## Review Focus

1. **A camera that is mid-event at 04:00** (an open event): its renewal waits for the event to end and is not skipped for a day; the next camera in line goes first. Pinned in Task 7 (`never during an open event`).
2. **The CA's constraints no longer cover the proxy's address** (the router gave the PC another LAN address, `tls.proxyAddresses` changed): the proxy keeps serving, the health item `certificates` says the CA doesn't cover the address and how to rotate, never a silent bad leaf. Pinned in Task 9 (`address outside the CA`).
3. **The CA key file is unreadable or missing while `ca.pem` exists** (a restore without `tls/ca.key`): the proxy refuses to issue (no new CA over an old pin), says so in health, and serves HTTP as before. Pinned in Task 2 (`a CA without its key is not replaced`).
4. **A camera refuses the import twice** (firmware answering 200 and changing nothing): no retry storm — one retry with a clear, then `pinned` with the served fingerprint, and the next attempt only at the next scheduled window or a manual "Push now". Pinned in Task 6 (`refusal: one retry, then pinned`).
5. **A leaf key in PKCS#8 instead of PKCS#1**: the camera's measured import used cert-manager's RSA key (PKCS#1); the push sends PKCS#1. Pinned in Task 3 (`camera keys are PKCS#1`).

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| cam-sim: `src/engine/faults.ts`, `src/camera-api/commands.ts`, `src/engine/settings.ts`, README, CHANGELOG | `cert.ignoreImport` fault; `GetNtp`/`SetNtp` | A1 |
| `package.json` | cam-sim tarball bump; `@peculiar/x509` direct | A2, 2 |
| `src/tls/der.ts` (new) | NameConstraints DER | 1 |
| `src/tls/ca.ts` (new) | the site CA: create, load, fingerprint | 2 |
| `src/tls/leaf.ts` (new) | leaves, renewal timing | 3 |
| `src/config/schema.ts`, `defaults.ts`, `load.ts` | `tls.*`, `server.tls.port`, `ntp.server` | 4 |
| `src/camera/http.ts`, `src/camera/client.ts` | a CA per camera client | 5 |
| `src/tls/push.ts` (new) | the camera certificate push | 6 |
| `src/tls/camera-certs.ts` (new) | per-camera state, scheduler | 7 |
| `src/proxy.ts`, `src/api/tls-api.ts` (new), `src/clips/side.ts` | HTTPS listener, `/tls/ca.pem`, FTPS with the leaf | 8 |
| `src/health/summary.ts`, `src/api/metrics.ts`, `src/api/client-api.ts` | `certificates` item, metrics, `tls` block | 9 |
| `src/cameras/ntp.ts` (new), `src/cameras/worker.ts` | NTP on the cameras | 10 |
| `web/src/components/CertificatesCard.svelte` (new), `web/src/lib/tls.ts` (new) | the Certificates card | 11 |
| `test/site-ca.test.ts` (new) | end to end with cam-sim over HTTPS | 12 |
| docs | | 13, 14 |

## Rulings (spec gaps decided here)

- **Ruling P5-1: the DNS constraint is encoded as `<site>.internal` (RFC 5280 form, no leading dot)** — spec §10.1.1 writes `.<site>.internal`; RFC 5280 dNSName constraints have no leading dot and match the name and every name under it; OpenSSL, Go and Apple accept this form — cost if wrong: none for the names used (`<cam>.<site>.internal`, `proxy.<site>.internal`); Task 3's test proves Node enforces it.
- **Ruling P5-2: two new settings carry the addresses the CA must cover: `tls.cameraSubnet` (CIDR) and `tls.proxyAddresses` (comma-separated IPv4s: the LAN and the camera-side address)** — spec §10.1.1 names the ranges but no setting; the renderer of P4 writes both into the host's config.json — cost if wrong: two settings more on the Settings page.
- **Ruling P5-3: an address outside the CA's constraints is not fixed silently**: a camera or proxy address the CA doesn't cover gets no leaf; the health item `certificates` names it and the control action `tls-ca-rotate` makes a new CA (cams needs the new pin; spec §10.7 accepts a list of pins) — cost if wrong: a manual step after an address change of the PC.
- **Ruling P5-4: camera leaf keys are PKCS#1 PEM** (`-----BEGIN RSA PRIVATE KEY-----`), like cert-manager's default that the camera accepted (spec §2: "RSA 2048 (cert-manager's default) works"); the proxy's own key stays PKCS#8 — cost if wrong: one `export({ type: 'pkcs8' })` instead.
- **Ruling P5-5: a push for a new camera or a served fingerprint that isn't the current leaf runs at the next scheduler tick (10 min), not at 04:00; renewals run at 04:00 camera time** — spec §10.1.3 lists the three triggers and "at 04:00 camera time" together; waiting a day for a new camera's first certificate helps nobody — cost if wrong: a first push during the day (the camera's web server restarts for a few seconds).
- **Ruling P5-6: after a refused import, the next automatic attempt is the next 04:00 window** (and "Push now" any time) — prevents a push loop against firmware that answers 200 and changes nothing — cost if wrong: a camera stays `pinned` up to a day longer.
- **Ruling P5-7: NTP is set when the camera comes online and its `GetNtp` server differs from `ntp.server`, at most once per camera per hour**, plus a `camera-ntp-set` action — spec §14.2 says "the proxy also sets each camera's NTP server" without a schedule — cost if wrong: one SetNtp per camera per hour while a camera keeps refusing.
- **Ruling P5-9: a `refused` push counts as a failed push for the `certificates` health item** (also while the camera is `pinned`) — spec §10.5 says "the last push of a camera failed"; a refusal is the push not taking effect; the item clears once the camera serves its leaf (a later push, or a fix on the camera) — cost if wrong: a camera that can never take the leaf keeps the item red (by design visible; the pin still works).
- **Ruling P5-8: the CA certificate's fingerprint format for cams is `SHA256:` + upper-case hex** (no colons) — spec §12.1 shows `SHA256:…` — the cams plan must parse exactly this; cost if wrong: a pin mismatch that the cams plan's tests would catch.

---

## Part A — cam-sim (repo `~/Development/cam-sim`, its own branch and PR)

### Task A1: cam-sim: the import refusal fault and `GetNtp`/`SetNtp`

The real firmware answers an `ImportCertificate` over an installed certificate with 200 and changes nothing (spec §2); a camera may also refuse a site-CA leaf that way. cam-sim mirrors the real camera (memory: measure first), so `GetNtp`/`SetNtp` take the object measured in P4 Task 10 Step 7.

**Files (cam-sim):**
- Modify: `src/engine/faults.ts` (`cert.ignoreImport`), `src/camera-api/commands.ts` (`GetNtp`, the fault in `ImportCertificate`), `src/engine/settings.ts` (`SetNtp: 'Ntp'`), `src/profile/rlc1224a.ts` (`Ntp` default), `README.md` (fault table), `CHANGELOG.md`, the Simulator page's fault labels (where the other faults are labelled)
- Test: `test/conformance/settings-api.test.ts` (extend), `test/faults.test.ts` (extend)

**Interfaces:**
- Fault `{ name: 'cert.ignoreImport' }`: while set, `ImportCertificate` answers `{ rspCode: 200 }` and installs nothing.
- `GetNtp` → `{ Ntp: <object> }`; `SetNtp` with `{ Ntp: <whole object> }` stores it (the settings store's whole-object semantics, like `SetFtpV20`).

- [ ] **Step 1: Write the failing tests** (in cam-sim's style; `settings-api.test.ts` drives the camera API through its helpers)

```ts
it('GetNtp answers the measured object; SetNtp stores a whole object', async () => {
  const before = await cmd('GetNtp');
  expect(before.value.Ntp).toEqual(NTP_DEFAULT);
  await cmd('SetNtp', { Ntp: { ...NTP_DEFAULT, server: '192.168.60.1' } });
  expect((await cmd('GetNtp')).value.Ntp.server).toBe('192.168.60.1');
});
```

```ts
it('cert.ignoreImport: ImportCertificate answers 200 and changes nothing', async () => {
  engine.faults.set({ name: 'cert.ignoreImport' });
  const r = await cmd('ImportCertificate', { importCertificate: { crt: part(cert, 'server.crt'), key: part(key, 'server.key') } });
  expect(r.value).toEqual({ rspCode: 200 });
  expect(engine.certs.state.enable).toBe(0);
});
```

(`NTP_DEFAULT` is the object of P4 Task 10 Step 7; until that measurement exists use the Reolink API document's shape `{ enable: 1, interval: 1440, port: 123, server: 'pool.ntp.org' }` and replace it with the measured object in this same PR — the PR waits for P4's measurement.)

- [ ] **Step 2: Run them to verify they fail**

Run (in cam-sim): `npx vitest run test/conformance/settings-api.test.ts test/faults.test.ts`
Expected: FAIL — `GetNtp` is an unknown command; `cert.ignoreImport` is an unknown fault.

- [ ] **Step 3: Implement**

- `src/engine/faults.ts`: add `'cert.ignoreImport'` to `FAULT_NAMES`.
- `src/camera-api/commands.ts`: in `ImportCertificate`, first line: `if (c.engine.faults.active('cert.ignoreImport')) return ok(c.cmd, { rspCode: 200 });`; add `GetNtp: getter('Ntp', (e) => e.settings.get('Ntp')),`.
- `src/engine/settings.ts`: `SET_COMMANDS` gets `SetNtp: 'Ntp'`.
- `src/profile/rlc1224a.ts`: the `Settings` type gets `Ntp: Obj` and the defaults the measured object.
- README fault table, Simulator page label ("Certificate import ignored"), CHANGELOG `## Unreleased`: "Fault `cert.ignoreImport`; `GetNtp`/`SetNtp` as measured on the RLC-… (firmware …)."

- [ ] **Step 4: Run cam-sim's suites**

Run (in cam-sim): `npm test && npm run lint:types && npm run check`
Expected: all pass.

- [ ] **Step 5: Commit, PR, release** (cam-sim's own rules: PR to `main`, checks green incl. `cams` compat, then the release PR to `production`)

```bash
git add src test README.md CHANGELOG.md web
git commit -m "feat: cert.ignoreImport fault; GetNtp/SetNtp as measured"
```

### Task A2: cam-proxy uses the new cam-sim

**Files:** Modify `package.json`, `package-lock.json`, `test/helpers/sim.ts` (an `ignoreImport` option).

- [ ] **Step 1:** Bump the `cam-sim` tarball URL in `package.json` to the new release; `npm install`.
- [ ] **Step 2:** `SimCameraOptions` and `startSim(opts)` accept `ignoreImport?: boolean` (pushes `{ name: 'cert.ignoreImport' }`) — in `startSim`, `createCamSim({ …, faults: opts.ignoreImport ? [{ name: 'cert.ignoreImport' }] : [] })`.
- [ ] **Step 3:** Run: `npm test`
Expected: all pass (nothing else changed).
- [ ] **Step 4:** Commit: `git add package.json package-lock.json test/helpers/sim.ts && git commit -m "chore: cam-sim with cert.ignoreImport and NTP"`

---

## Part B — cam-proxy

### Task 1: The name constraints in DER

**Files:**
- Create: `src/tls/der.ts`
- Test: `test/tls-der.test.ts` (new)

**Interfaces:**
- Produces:

```ts
export function nameConstraintsDer(p: { dns: string[]; ip: { address: string; prefix: number }[] }): Buffer;  // NameConstraints with permittedSubtrees only
export function ipv4Bytes(ip: string): number[];
```

- [ ] **Step 1: Write the failing test**

Create `test/tls-der.test.ts`:

```ts
import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { nameConstraintsDer } from '../src/tls/der';

describe('NameConstraints DER (RFC 5280 §4.2.1.10)', () => {
  it('permittedSubtrees: a dNSName and an iPAddress with its mask', () => {
    const der = nameConstraintsDer({ dns: ['g.internal'], ip: [{ address: '192.168.60.0', prefix: 24 }] });
    expect(der.toString('hex')).toBe(
      '3020' + // NameConstraints SEQUENCE
        'a01e' + // [0] permittedSubtrees
        '300c' + '820a' + Buffer.from('g.internal').toString('hex') + // GeneralSubtree { [2] dNSName }
        '300a' + '8708' + 'c0a83c00' + 'ffffff00', // GeneralSubtree { [7] iPAddress addr+mask }
    );
  });
  it('a /32 for one address', () => {
    expect(nameConstraintsDer({ dns: [], ip: [{ address: '192.168.1.230', prefix: 32 }] }).toString('hex')).toBe('300ca00a300887' + '08c0a801e6ffffffff');
  });
  it.skipIf(spawnSync('openssl', ['version']).status !== 0)('openssl parses it', () => {
    const der = nameConstraintsDer({ dns: ['garage.internal'], ip: [{ address: '192.168.60.0', prefix: 24 }] });
    const r = spawnSync('openssl', ['asn1parse', '-inform', 'DER'], { input: der, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('cont [ 0 ]');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tls-der.test.ts`
Expected: FAIL with `Failed to resolve import "../src/tls/der"`.

- [ ] **Step 3: Implement**

Create `src/tls/der.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tls-der.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tls/der.ts test/tls-der.test.ts
git commit -m "feat(tls): name constraints in DER"
```

---

### Task 2: The site CA

**Files:**
- Create: `src/tls/ca.ts`
- Modify: `package.json` (`@peculiar/x509` as a direct dependency, the version already in `package-lock.json` via `selfsigned`)
- Test: `test/tls-ca.test.ts` (new)

**Interfaces:**
- Produces:

```ts
export interface SiteCa { certPem: string; keyPem: string; fingerprint: string /* SHA256:HEX */; notAfter: number; covers(ip: string): boolean; coversName(name: string): boolean }
export class CaError extends Error {}
export function fingerprintOf(pem: string): string;   // SHA256: + upper-case hex of the DER (Ruling P5-8)
// Loads <dir>/ca.pem + <dir>/ca.key, or creates both when neither exists. A ca.pem without its key → CaError (never replaced).
export async function siteCa(dir: string, o: { site: string; cameraSubnet: string; proxyAddresses: string[]; now?: () => number }): Promise<SiteCa>;
```

- [ ] **Step 1: Write the failing test**

Create `test/tls-ca.test.ts`:

```ts
import { X509Certificate } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { CaError, fingerprintOf, siteCa } from '../src/tls/ca';

const OPTS = { site: 'garage', cameraSubnet: '192.168.60.0/24', proxyAddresses: ['192.168.1.230', '192.168.60.1'] };

describe('the site CA (spec §10.1.1)', () => {
  it('RSA 3072, 10 years, CN, critical name constraints; key 600, never in the cert file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-ca-'));
    const ca = await siteCa(dir, OPTS);
    const x = new X509Certificate(ca.certPem);
    expect(x.subject).toBe('CN=cam-proxy site CA garage');
    expect(x.ca).toBe(true);
    expect(x.publicKey.asymmetricKeyDetails?.modulusLength).toBe(3072);
    expect(Date.parse(x.validTo) - Date.parse(x.validFrom)).toBeGreaterThan(3650 * 86400_000 - 86400_000);
    expect(statSync(join(dir, 'ca.key')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'ca.pem'), 'utf8')).not.toContain('PRIVATE KEY');
    expect(ca.fingerprint).toMatch(/^SHA256:[0-9A-F]{64}$/);
    expect(ca.fingerprint).toBe(fingerprintOf(ca.certPem));
    expect(ca.covers('192.168.60.13')).toBe(true);
    expect(ca.covers('192.168.1.230')).toBe(true);
    expect(ca.covers('192.168.1.231')).toBe(false);
    expect(ca.coversName('cam3.garage.internal')).toBe(true);
    expect(ca.coversName('evil.example')).toBe(false);
  }, 60_000);

  it('a second start loads the same CA', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-ca-'));
    const a = await siteCa(dir, OPTS);
    const b = await siteCa(dir, OPTS);
    expect(b.fingerprint).toBe(a.fingerprint);
  }, 60_000);

  it('a CA without its key is not replaced', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-ca-'));
    await siteCa(dir, OPTS);
    rmSync(join(dir, 'ca.key'));
    await expect(siteCa(dir, OPTS)).rejects.toThrow(CaError);
    expect(existsSync(join(dir, 'ca.pem'))).toBe(true);
  }, 60_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tls-ca.test.ts`
Expected: FAIL with `Failed to resolve import "../src/tls/ca"`.

- [ ] **Step 3: Implement**

`package.json` `dependencies`: add `"@peculiar/x509"` with the version range `selfsigned` already pulls (read it from `package-lock.json`: `node_modules/@peculiar/x509` `version`), then `npm install` (no new download).

Create `src/tls/ca.ts`:

```ts
import * as x509 from '@peculiar/x509';
import { createHash, randomBytes, webcrypto, X509Certificate } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { nameConstraintsDer } from './der';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export const RSA = (bits: number) => ({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]), modulusLength: bits }) as const;
const YEAR = 365 * 86400_000;

export class CaError extends Error {}
export interface SiteCa { certPem: string; keyPem: string; fingerprint: string; notAfter: number; covers(ip: string): boolean; coversName(name: string): boolean }

export function fingerprintOf(pem: string): string {
  return `SHA256:${createHash('sha256').update(new X509Certificate(pem).raw).digest('hex').toUpperCase()}`;
}

const ipInt = (ip: string) => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0);
const cidr = (s: string) => {
  const [ip, p] = s.split('/');
  return { address: ip, prefix: Number(p ?? 32) };
};
const within = (ip: string, r: { address: string; prefix: number }) => {
  const m = r.prefix === 0 ? 0 : (0xffffffff << (32 - r.prefix)) >>> 0;
  return ((ipInt(ip) & m) >>> 0) === ((ipInt(r.address) & m) >>> 0);
};

const writeSecret = (file: string, text: string, mode: number) => {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, file);
};

// The host's own CA (spec §10.1.1): created once, then loaded. The key never
// leaves <dir>/ca.key (600); a ca.pem without it is never replaced: cams pins
// the CA, and a silent new one would break every pin (Review Focus 3).
export async function siteCa(dir: string, o: { site: string; cameraSubnet: string; proxyAddresses: string[]; now?: () => number }): Promise<SiteCa> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pemFile = join(dir, 'ca.pem');
  const keyFile = join(dir, 'ca.key');
  const ranges = [cidr(o.cameraSubnet), ...o.proxyAddresses.map((a) => ({ address: a, prefix: 32 }))];
  const dnsBase = `${o.site}.internal`; // Ruling P5-1
  if (existsSync(pemFile) || existsSync(keyFile)) {
    if (!existsSync(pemFile) || !existsSync(keyFile)) throw new CaError(`${existsSync(pemFile) ? 'ca.key' : 'ca.pem'} is missing in ${dir}: restore it from the backup, or rotate the CA (cams needs the new pin)`);
  } else {
    const now = (o.now ?? Date.now)();
    const alg = RSA(3072);
    const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: randomBytes(16).toString('hex'),
      name: `CN=cam-proxy site CA ${o.site}`,
      notBefore: new Date(now - 3600_000),
      notAfter: new Date(now + 10 * YEAR),
      keys,
      signingAlgorithm: alg,
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
        new x509.Extension('2.5.29.30', true, nameConstraintsDer({ dns: [dnsBase], ip: ranges })),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      ],
    });
    const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64').replace(/(.{64})/g, '$1\n');
    writeSecret(keyFile, `-----BEGIN PRIVATE KEY-----\n${pkcs8.trim()}\n-----END PRIVATE KEY-----\n`, 0o600);
    writeFileSync(pemFile, cert.toString('pem') + '\n', { mode: 0o644 });
  }
  const certPem = readFileSync(pemFile, 'utf8');
  const keyPem = readFileSync(keyFile, 'utf8');
  const x = new X509Certificate(certPem);
  return {
    certPem,
    keyPem,
    fingerprint: fingerprintOf(certPem),
    notAfter: Date.parse(x.validTo),
    covers: (ip) => ranges.some((r) => within(ip, r)),
    coversName: (name) => name === dnsBase || name.endsWith(`.${dnsBase}`),
  };
}
```

(The `covers` ranges are the ones in the settings now; Task 9 compares them with the CA's own constraints to detect the "address outside the CA" case. If an `@peculiar/x509` class or argument differs in the installed version, adapt the call to its `index.d.ts` — the test is the contract.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tls-ca.test.ts && npm run lint:types`
Expected: PASS (`3 passed`; RSA 3072 generation takes a few seconds).

- [ ] **Step 5: Commit**

```bash
git add src/tls/ca.ts package.json package-lock.json test/tls-ca.test.ts
git commit -m "feat(tls): the per-host site CA, name-constrained"
```

---

### Task 3: Leaves and their renewal

**Files:**
- Create: `src/tls/leaf.ts`
- Test: `test/tls-leaf.test.ts` (new)

**Interfaces:**
- Produces:

```ts
export interface Leaf { certPem: string; keyPem: string; fingerprint: string; notAfter: number; names: string[]; ips: string[] }
export async function issueLeaf(ca: SiteCa, o: { cn: string; dns: string[]; ips: string[]; days?: number /* 397 */; keyFormat?: 'pkcs1' | 'pkcs8' /* pkcs1 */; now?: () => number }): Promise<Leaf>;
export const RENEW_BEFORE_MS = 30 * 86400_000;
export function renewalDue(leaf: { notAfter: number }, now: number): boolean;
export function leafOf(certPem: string, keyPem: string): Leaf;      // a stored leaf, read back
```

- [ ] **Step 1: Write the failing test**

Create `test/tls-leaf.test.ts`:

```ts
import { X509Certificate } from 'crypto';
import { mkdtempSync } from 'fs';
import https from 'https';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { siteCa, type SiteCa } from '../src/tls/ca';
import { issueLeaf, renewalDue } from '../src/tls/leaf';

let ca: SiteCa;
beforeAll(async () => {
  ca = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-leaf-')), { site: 'garage', cameraSubnet: '127.0.0.0/8', proxyAddresses: ['192.168.1.230'] });
}, 60_000);

// A TLS server with the leaf; a client that trusts only the CA (as cams will).
async function handshake(leaf: { certPem: string; keyPem: string }, servername: string): Promise<string> {
  const server = https.createServer({ cert: leaf.certPem, key: leaf.keyPem }, (_req, res) => res.end('ok'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    return await new Promise<string>((resolve) => {
      https.get({ host: '127.0.0.1', port, servername, ca: ca.certPem, path: '/' }, (res) => {
        res.resume();
        resolve('ok');
      }).on('error', (e) => resolve(e.message));
    });
  } finally {
    server.close();
  }
}

describe('leaves (spec §10.1.2)', () => {
  it('a camera leaf: RSA 2048, 397 days, SANs, verifies against the CA by name and by IP', async () => {
    const leaf = await issueLeaf(ca, { cn: 'cam3.garage.internal', dns: ['cam3.garage.internal'], ips: ['127.0.0.1'] });
    const x = new X509Certificate(leaf.certPem);
    expect(x.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(Math.round((Date.parse(x.validTo) - Date.parse(x.validFrom)) / 86400_000)).toBe(397);
    expect(x.subjectAltName).toBe('DNS:cam3.garage.internal, IP Address:127.0.0.1');
    expect(x.verify(new X509Certificate(ca.certPem).publicKey)).toBe(true);
    expect(await handshake(leaf, 'cam3.garage.internal')).toBe('ok');
  }, 60_000);

  it('camera keys are PKCS#1 (Ruling P5-4)', async () => {
    const leaf = await issueLeaf(ca, { cn: 'cam4.garage.internal', dns: ['cam4.garage.internal'], ips: ['127.0.0.1'] });
    expect(leaf.keyPem.startsWith('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
  }, 60_000);

  it("Node enforces the CA's name constraints: a name or an address outside is refused", async () => {
    const evil = await issueLeaf(ca, { cn: 'evil.example', dns: ['evil.example'], ips: ['127.0.0.1'] });
    expect(await handshake(evil, 'evil.example')).toMatch(/permitted|constraint/i);
    const far = await issueLeaf(ca, { cn: 'cam9.garage.internal', dns: ['cam9.garage.internal'], ips: ['10.9.9.9'] });
    expect(await handshake(far, 'cam9.garage.internal')).toMatch(/permitted|constraint/i);
  }, 60_000);

  it('renewal 30 days before expiry', () => {
    const notAfter = Date.UTC(2027, 10, 5);
    expect(renewalDue({ notAfter }, notAfter - 31 * 86400_000)).toBe(false);
    expect(renewalDue({ notAfter }, notAfter - 30 * 86400_000)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tls-leaf.test.ts`
Expected: FAIL with `Failed to resolve import "../src/tls/leaf"`.

- [ ] **Step 3: Implement**

Create `src/tls/leaf.ts`:

```ts
import * as x509 from '@peculiar/x509';
import { createPrivateKey, randomBytes, webcrypto, X509Certificate } from 'crypto';
import { fingerprintOf, RSA, type SiteCa } from './ca';

export interface Leaf { certPem: string; keyPem: string; fingerprint: string; notAfter: number; names: string[]; ips: string[] }
export const RENEW_BEFORE_MS = 30 * 86400_000;
export const renewalDue = (leaf: { notAfter: number }, now: number): boolean => leaf.notAfter - now <= RENEW_BEFORE_MS;

const sans = (x: X509Certificate) => {
  const parts = (x.subjectAltName ?? '').split(', ');
  return { names: parts.filter((p) => p.startsWith('DNS:')).map((p) => p.slice(4)), ips: parts.filter((p) => p.startsWith('IP Address:')).map((p) => p.slice(11)) };
};

export function leafOf(certPem: string, keyPem: string): Leaf {
  const x = new X509Certificate(certPem);
  return { certPem, keyPem, fingerprint: fingerprintOf(certPem), notAfter: Date.parse(x.validTo), ...sans(x) };
}

// A leaf signed directly by the site CA (spec §10.1.2): RSA 2048, 397 days
// (under Apple's 825-day limit), serverAuth, the SANs given.
export async function issueLeaf(ca: SiteCa, o: { cn: string; dns: string[]; ips: string[]; days?: number; keyFormat?: 'pkcs1' | 'pkcs8'; now?: () => number }): Promise<Leaf> {
  const now = (o.now ?? Date.now)();
  const alg = RSA(2048);
  const caKey = await webcrypto.subtle.importKey('pkcs8', createPrivateKey(ca.keyPem).export({ type: 'pkcs8', format: 'der' }), alg, false, ['sign']);
  const caCert = new x509.X509Certificate(ca.certPem);
  const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const notBefore = new Date(now - 3600_000);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomBytes(16).toString('hex'),
    subject: `CN=${o.cn}`,
    issuer: caCert.subject,
    notBefore,
    notAfter: new Date(notBefore.getTime() + (o.days ?? 397) * 86400_000),
    signingKey: caKey,
    publicKey: keys.publicKey,
    signingAlgorithm: alg,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension([...o.dns.map((value) => ({ type: 'dns' as const, value })), ...o.ips.map((value) => ({ type: 'ip' as const, value }))]),
      await x509.AuthorityKeyIdentifierExtension.create(caCert),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  // The camera's measured import used an RSA key as cert-manager writes it: PKCS#1 (Ruling P5-4).
  const keyPem = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({ type: o.keyFormat ?? 'pkcs1', format: 'pem' }).toString();
  return leafOf(cert.toString('pem') + '\n', keyPem);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tls-leaf.test.ts && npm run lint:types`
Expected: PASS (`4 passed`). If the constraint test passes the handshake, the DER of Task 1 or its extension wiring is wrong — fix there, never weaken the test.

- [ ] **Step 5: Commit**

```bash
git add src/tls/leaf.ts test/tls-leaf.test.ts
git commit -m "feat(tls): leaves from the site CA; renewal timing; Node enforces the constraints"
```

---

### Task 4: Settings: `tls.*`, `server.tls.port`, `ntp.server`

**Files:**
- Modify: `src/config/schema.ts`, `src/config/defaults.ts`, `src/config/load.ts` (cross checks, restart rules), `config.schema.json` (regenerated)
- Test: `test/config-tls.test.ts` (new)

**Interfaces:**
- Produces: `Config.tls: { site?: string; cameraCerts: boolean; cameraSubnet?: string; proxyAddresses?: string }`, `Config.server.tls: { port?: number }`, `Config.ntp: { server?: string }`; all `tls.*` and `server.tls.port` need a new process (`needsProcessRestart`); `ntp.server` is live.

- [ ] **Step 1: Write the failing test**

Create `test/config-tls.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, needsProcessRestart } from '../src/config/load';

const SECRETS = { CAMPROXY_TOKENS: 'a'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'c'.repeat(32), CAMPROXY_CAMERA_PASSWORD: 'x' };
const load = (cfg: object) => {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-tlscfg-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ cameras: [{ id: 'cam3', host: '192.168.60.13' }], ...cfg }));
  return loadConfig(SECRETS, { cwd: dir });
};
const err = (cfg: object) => {
  try {
    load(cfg);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error('expected a ConfigError');
};

describe('TLS settings (spec §10.4)', () => {
  it('off by default: no site, HTTP only (the Pi)', () => {
    const c = load({}).config;
    expect(c.tls).toEqual({ cameraCerts: true });
    expect(c.server.tls).toEqual({});
  });
  it('a site needs the addresses its CA covers (Ruling P5-2)', () => {
    expect(err({ tls: { site: 'garage' } })).toBe('tls.cameraSubnet: required with tls.site');
    expect(err({ tls: { site: 'garage', cameraSubnet: '192.168.60.0/24' } })).toBe('tls.proxyAddresses: required with tls.site');
    expect(load({ tls: { site: 'garage', cameraSubnet: '192.168.60.0/24', proxyAddresses: '192.168.1.230,192.168.60.1' } }).config.tls.site).toBe('garage');
  });
  it('HTTPS needs a site; the settings need a new process', () => {
    expect(err({ server: { tls: { port: 8443 } } })).toBe('server.tls.port: needs tls.site (the proxy certificate comes from the site CA)');
    expect(needsProcessRestart('tls.site')).toBe(true);
    expect(needsProcessRestart('server.tls.port')).toBe(true);
    expect(needsProcessRestart('ntp.server')).toBe(false);
  });
  it('bad values', () => {
    expect(err({ tls: { site: 'Garage' } })).toBe('tls.site: has the wrong format');
    expect(err({ tls: { site: 'g', cameraSubnet: '192.168.60.0', proxyAddresses: '1.2.3.4' } })).toBe('tls.cameraSubnet: has the wrong format');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config-tls.test.ts`
Expected: FAIL — `tls: unknown setting`.

- [ ] **Step 3: Implement**

`SETTINGS`:

```ts
  // The site CA (spec 2026-10-05-multi-camera-host-design §10): unset site = off (the Pi).
  tls: {
    site: unset({ type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,30}$', optional: true, doc: "this host's site label: names are <camera>.<site>.internal and proxy.<site>.internal" }, 'no site CA: HTTP only, cameras verified as configured'),
    cameraCerts: { type: 'boolean', doc: 'issue and push camera certificates from the site CA' },
    cameraSubnet: unset({ type: 'string', pattern: '^\\d{1,3}(\\.\\d{1,3}){3}/\\d{1,2}$', optional: true, doc: "the camera network the CA may vouch for (CIDR), e.g. 192.168.60.0/24" }, 'none'),
    proxyAddresses: unset({ type: 'string', pattern: '^\\d{1,3}(\\.\\d{1,3}){3}(,\\d{1,3}(\\.\\d{1,3}){3})*$', optional: true, doc: "the proxy's own IPv4 addresses (LAN, camera side), comma-separated: its certificate's IP names" }, 'none'),
  },
  ntp: {
    server: unset({ type: 'string', pattern: '^[A-Za-z0-9.-]{1,253}$', optional: true, doc: "the NTP server the proxy sets on its cameras (the host's camera-side address)" }, "the cameras' NTP setting is left alone"),
  },
```

and in `server`: `tls: { port: unset(int(1, 65535, 'HTTPS port with the site CA certificate', true), 'HTTP only') }`. `Config`/`DEFAULTS`: `tls: { cameraCerts: true }`, `ntp: {}`, `server.tls: {}`. `PROCESS` gains `'server.tls.port', 'tls.site', 'tls.cameraCerts', 'tls.cameraSubnet', 'tls.proxyAddresses'`. `crossCheck`:

```ts
  if (c.tls.site) {
    if (!c.tls.cameraSubnet) throw new ConfigError('tls.cameraSubnet: required with tls.site');
    if (!c.tls.proxyAddresses) throw new ConfigError('tls.proxyAddresses: required with tls.site');
  }
  if (c.server.tls.port !== undefined && !c.tls.site) throw new ConfigError('server.tls.port: needs tls.site (the proxy certificate comes from the site CA)');
```

Run `npm run schema`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/config-tls.test.ts test/config.test.ts && npm run lint:types && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/config config.schema.json test/config-tls.test.ts
git commit -m "feat(config): tls.site, tls.cameraSubnet, tls.proxyAddresses, server.tls.port, ntp.server"
```

---

### Task 5: The camera client trusts a CA

**Files:**
- Modify: `src/camera/http.ts` (`CameraTarget.ca`), `src/camera/client.ts` (`CameraConfig.tlsCa`)
- Test: `test/camera-client-ca.test.ts` (new)

**Interfaces:**
- Produces: `CameraTarget.ca?: string` and `CameraConfig.tlsCa?: string`: with `ca`, a request verifies the camera against that CA only, with `tlsServername` as the name (`rejectUnauthorized: true`).

- [ ] **Step 1: Write the failing test**

Create `test/camera-client-ca.test.ts`:

```ts
import { mkdtempSync } from 'fs';
import https from 'https';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { openRequest } from '../src/camera/http';
import { siteCa } from '../src/tls/ca';
import { issueLeaf } from '../src/tls/leaf';

describe('camera requests verified against the site CA (spec §10.4)', () => {
  it('the right CA and name: ok; another CA: refused', async () => {
    const ca = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-cca-')), { site: 'g', cameraSubnet: '127.0.0.0/8', proxyAddresses: ['127.0.0.1'] });
    const other = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-cca2-')), { site: 'g', cameraSubnet: '127.0.0.0/8', proxyAddresses: ['127.0.0.1'] });
    const leaf = await issueLeaf(ca, { cn: 'cam3.g.internal', dns: ['cam3.g.internal'], ips: ['127.0.0.1'] });
    const server = https.createServer({ cert: leaf.certPem, key: leaf.keyPem }, (_q, r) => r.end('{}'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const ok = await openRequest({ protocol: 'https', host, tlsServername: 'cam3.g.internal', ca: ca.certPem }, '/', { timeoutMs: 5000 });
      ok.resume();
      expect(ok.statusCode).toBe(200);
      await expect(openRequest({ protocol: 'https', host, tlsServername: 'cam3.g.internal', ca: other.certPem }, '/', { timeoutMs: 5000 })).rejects.toThrow();
    } finally {
      server.close();
    }
  }, 120_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/camera-client-ca.test.ts`
Expected: FAIL — the request with another CA succeeds (no `ca` option yet; `rejectUnauthorized` uses public CAs, which fail both… the first assertion fails with a verification error instead): either way FAIL.

- [ ] **Step 3: Implement**

`src/camera/http.ts`: `CameraTarget` gets `ca?: string`; the TLS options become

```ts
  const tls =
    target.protocol === 'https'
      ? { servername: target.tlsServername, rejectUnauthorized: Boolean(target.tlsServername), ...(target.ca ? { ca: target.ca } : {}) }
      : {};
```

`src/camera/client.ts`: `CameraConfig` gets `tlsCa?: string`; `this.target = { protocol, host, tlsServername, ...(cam.tlsCa ? { ca: cam.tlsCa } : {}) }`; `cameraCertificate()` uses `ca: this.cam.tlsCa ?? this.opts.tlsCa`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/camera-client-ca.test.ts test/camera-client.test.ts && npm run lint:types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/camera/http.ts src/camera/client.ts test/camera-client-ca.test.ts
git commit -m "feat(camera): verify a camera against a given CA"
```

---

### Task 6: The camera certificate push

**Files:**
- Create: `src/tls/push.ts`
- Test: `test/tls-push.test.ts` (new)

**Interfaces:**
- Produces:

```ts
export type PushOutcome = 'current' | 'pushed' | 'refused' | 'failed';
export interface PushResult { outcome: PushOutcome; served: string | null /* SHA256:… */; detail?: string; tookMs: number }
export interface PushDeps {
  served(): Promise<string | null>;                                // the leaf the camera presents now (not verified)
  command<T>(cmd: string, param?: object): Promise<T>;             // the camera API, logged in (ReolinkClient.command)
  relogin(): void;                                                 // drop the session (the web server restarted)
  logout(): Promise<void>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}
export async function pushCertificate(d: PushDeps, leaf: { certPem: string; keyPem: string; fingerprint: string }, o?: { clearWaitMs?: number; verifyMs?: number; pollMs?: number }): Promise<PushResult>;
export async function servedFingerprint(host: string, port: number, timeoutMs?: number): Promise<string | null>;
```

- [ ] **Step 1: Write the failing test**

Create `test/tls-push.test.ts`:

```ts
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ReolinkClient } from '../src/camera/client';
import { siteCa, type SiteCa } from '../src/tls/ca';
import { issueLeaf } from '../src/tls/leaf';
import { pushCertificate, servedFingerprint } from '../src/tls/push';
import { startSim } from './helpers/sim';

let ca: SiteCa;
beforeAll(async () => {
  ca = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-push-')), { site: 'g', cameraSubnet: '127.0.0.0/8', proxyAddresses: ['127.0.0.1'] });
}, 60_000);
const sims: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of sims.splice(0)) await s.close();
});

async function camera(o: { ignoreImport?: boolean } = {}) {
  const sim = await startSim(o);
  sims.push(sim);
  const host = `127.0.0.1:${sim.ports.https}`;
  const client = new ReolinkClient({ id: 'cam3', host, protocol: 'https', user: 'proxy', password: sim.password });
  const deps = {
    served: () => servedFingerprint('127.0.0.1', sim.ports.https),
    command: <T>(cmd: string, p?: object) => client.command<T>(cmd, p),
    relogin: () => client.forgetToken(),
    logout: () => client.logout(),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 50))),
  };
  return { sim, deps };
}

describe('camera certificate push (spec §10.1.3)', () => {
  it('pushes, judged by the served fingerprint; a second run is current', async () => {
    const { deps } = await camera();
    const leaf = await issueLeaf(ca, { cn: 'cam3.g.internal', dns: ['cam3.g.internal'], ips: ['127.0.0.1'] });
    const r = await pushCertificate(deps, leaf, { clearWaitMs: 10, verifyMs: 5000, pollMs: 50 });
    expect(r).toMatchObject({ outcome: 'pushed', served: leaf.fingerprint });
    expect((await pushCertificate(deps, leaf, { clearWaitMs: 10, verifyMs: 5000, pollMs: 50 })).outcome).toBe('current');
  }, 60_000);

  it('over an installed certificate: cleared first (the firmware ignores an import over one)', async () => {
    const { deps } = await camera();
    const a = await issueLeaf(ca, { cn: 'cam3.g.internal', dns: ['cam3.g.internal'], ips: ['127.0.0.1'] });
    const b = await issueLeaf(ca, { cn: 'cam3.g.internal', dns: ['cam3.g.internal'], ips: ['127.0.0.1'] });
    await pushCertificate(deps, a, { clearWaitMs: 10, verifyMs: 5000, pollMs: 50 });
    expect(await pushCertificate(deps, b, { clearWaitMs: 10, verifyMs: 5000, pollMs: 50 })).toMatchObject({ outcome: 'pushed', served: b.fingerprint });
  }, 60_000);

  it('refusal: one retry, then refused with the served (factory) fingerprint', async () => {
    const { deps } = await camera({ ignoreImport: true });
    const factory = await deps.served();
    const leaf = await issueLeaf(ca, { cn: 'cam3.g.internal', dns: ['cam3.g.internal'], ips: ['127.0.0.1'] });
    const calls: string[] = [];
    const counted = { ...deps, command: <T>(cmd: string, p?: object) => (calls.push(cmd), deps.command<T>(cmd, p)) };
    const r = await pushCertificate(counted, leaf, { clearWaitMs: 10, verifyMs: 300, pollMs: 50 });
    expect(r).toMatchObject({ outcome: 'refused', served: factory });
    expect(calls.filter((c) => c === 'ImportCertificate')).toHaveLength(2);
    expect(calls.filter((c) => c === 'CertificateClear')).toHaveLength(1);
  }, 60_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tls-push.test.ts`
Expected: FAIL with `Failed to resolve import "../src/tls/push"`.

- [ ] **Step 3: Implement**

Create `src/tls/push.ts`:

```ts
import { createHash } from 'crypto';
import { connect } from 'tls';
import { sleep as realSleep } from '../async';

// push_cert.py's logic inside cam-proxy (spec 2026-10-05-multi-camera-host-design
// §10.1.3), with the measured firmware rules (spec §2): an import over an
// installed custom certificate answers 200 and changes nothing, so an
// installed one is cleared first; the files are server.crt / server.key;
// success only ever by the fingerprint the camera serves. The key never
// reaches a log line or an error message.
export type PushOutcome = 'current' | 'pushed' | 'refused' | 'failed';
export interface PushResult { outcome: PushOutcome; served: string | null; detail?: string; tookMs: number }
export interface PushDeps {
  served(): Promise<string | null>;
  command<T>(cmd: string, param?: object): Promise<T>;
  relogin(): void;
  logout(): Promise<void>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export function servedFingerprint(host: string, port: number, timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    const s = connect({ host, port, rejectUnauthorized: false }, () => {
      const raw = s.getPeerCertificate()?.raw;
      s.destroy();
      resolve(raw ? `SHA256:${createHash('sha256').update(raw).digest('hex').toUpperCase()}` : null);
    });
    s.setTimeout(timeoutMs, () => (s.destroy(), resolve(null)));
    s.on('error', () => resolve(null));
  });
}

const part = (pem: string, name: string) => {
  const b = Buffer.from(pem, 'utf8');
  return { size: b.length, name, content: b.toString('base64') };
};

export async function pushCertificate(d: PushDeps, leaf: { certPem: string; keyPem: string; fingerprint: string }, o: { clearWaitMs?: number; verifyMs?: number; pollMs?: number } = {}): Promise<PushResult> {
  const sleep = d.sleep ?? realSleep;
  const now = d.now ?? Date.now;
  const t0 = now();
  const done = (outcome: PushOutcome, served: string | null, detail?: string): PushResult => ({ outcome, served, ...(detail ? { detail } : {}), tookMs: now() - t0 });
  const waitFor = async (): Promise<string | null> => {
    const until = now() + (o.verifyMs ?? 90_000);
    let last: string | null = null;
    while (now() < until) {
      await sleep(o.pollMs ?? 5000);
      last = await d.served(); // null while the web server restarts
      if (last === leaf.fingerprint) return last;
    }
    return last;
  };
  const once = async (clearFirst: boolean): Promise<string | null> => {
    if (clearFirst) {
      await d.command('CertificateClear');
      d.relogin(); // the web server restarts: a new session after the wait
      await sleep(o.clearWaitMs ?? 10_000);
    }
    await d.command('ImportCertificate', { importCertificate: { crt: part(leaf.certPem, 'server.crt'), key: part(leaf.keyPem, 'server.key') } });
    d.relogin();
    return waitFor();
  };
  try {
    const before = await d.served();
    if (before === leaf.fingerprint) return done('current', before);
    const info = await d.command<{ CertificateInfo?: { enable?: number } }>('GetCertificateInfo');
    const installed = info.CertificateInfo?.enable === 1;
    let served = await once(installed);
    if (served === leaf.fingerprint) return done('pushed', served);
    served = await once(true); // retry once, with a clear
    if (served === leaf.fingerprint) return done('pushed', served);
    return done('refused', served ?? (await d.served()), 'the camera kept serving another certificate');
  } catch (err) {
    return done('failed', await d.served().catch(() => null), (err as Error).message);
  } finally {
    await d.logout().catch(() => undefined);
  }
}
```

(The refusal test expects one `CertificateClear`: the first attempt has no installed certificate on a fresh cam-sim, so it imports without a clear; the retry clears once.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/tls-push.test.ts && npm run lint:types`
Expected: PASS (`3 passed`).

- [ ] **Step 5: Commit**

```bash
git add src/tls/push.ts test/tls-push.test.ts
git commit -m "feat(tls): push a camera certificate the way the firmware needs it"
```

---

### Task 7: Camera certificates: state per camera and the scheduler

**Files:**
- Create: `src/tls/camera-certs.ts`
- Modify: `src/audit/actions.ts` (`camera-cert-push`)
- Test: `test/tls-camera-certs.test.ts` (new)

**Interfaces:**
- Consumes: `SiteCa` (Task 2), `issueLeaf`, `leafOf`, `renewalDue`, `Leaf` (Task 3), `PushResult` (Task 6).
- Produces:

```ts
export type CertMode = 'site-ca' | 'pinned' | 'public' | 'none';
export interface CertState { mode: CertMode; servername: string | null; fingerprint: string | null; notAfter: number | null; lastPush: { at: number; outcome: PushOutcome } | null; problem: string | null }
export interface CertCamera { id: string; address: string; protocol: 'https' | 'http'; tlsName?: string }
export interface CameraCertsDeps {
  dir: string;                                                   // <dataDir>/tls
  ca: () => SiteCa | null;
  site: () => string | undefined;
  enabled: () => boolean;                                        // tls.cameraCerts
  cameras: () => CertCamera[];
  served: (id: string) => Promise<string | null>;
  push: (id: string, leaf: Leaf) => Promise<PushResult>;
  openEvent: (id: string) => boolean;
  localHour: (now: number) => number;                            // camera time
  onSiteCa?: (id: string) => void;                               // the camera serves its leaf now: its client switches to the CA
  audit?: Pick<AuditLog, 'write'>;
  onPush?: (id: string, outcome: PushOutcome) => void;           // metrics
  now?: () => number;
}
export class CameraCerts {
  constructor(d: CameraCertsDeps);
  state(id: string): CertState;
  leaf(id: string): Leaf | null;                                 // the current leaf (stored), if any
  tick(): Promise<void>;                                         // one camera at a time
  pushNow(id: string): Promise<PushResult>;                      // the "Push now" action: no window, still not during an open event
  start(everyMs?: number): void;                                 // 10 min
  stop(): void;
}
```
- Files: `<dir>/cameras/<id>.crt`, `<dir>/cameras/<id>.key` (600), `<dir>/cameras/state.json` (`lastPush` per camera).
- Rules: a camera on `http` → `none`; with `tlsName` → `public` (verified against public CAs, as cam1 on the Pi); an address the CA doesn't cover → `none` with `problem` "<address> is outside the site CA: rotate the CA (tls-ca-rotate)"; a missing leaf, or one whose IP is not the camera's address → a new leaf; a served fingerprint ≠ the leaf → push at the next tick (Ruling P5-5); renewal due → a new leaf, pushed at the 04:00 window; after `refused` → next try in the 04:00 window (Ruling P5-6); never while `openEvent(id)`.

- [ ] **Step 1: Write the failing test**

Create `test/tls-camera-certs.test.ts`:

```ts
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { siteCa, type SiteCa } from '../src/tls/ca';
import { CameraCerts, type CertCamera } from '../src/tls/camera-certs';
import type { Leaf } from '../src/tls/leaf';
import type { PushResult } from '../src/tls/push';

let ca: SiteCa;
beforeAll(async () => {
  ca = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-ccerts-ca-')), { site: 'garage', cameraSubnet: '192.168.60.0/24', proxyAddresses: ['192.168.1.230'] });
}, 60_000);

function setup(o: { cameras?: CertCamera[]; refuse?: boolean } = {}) {
  let now = Date.UTC(2026, 9, 20, 10, 0); // 10:00 camera time (localHour = UTC hour here)
  const served = new Map<string, string | null>([['cam3', 'SHA256:FACTORY3'], ['cam4', 'SHA256:FACTORY4']]);
  const open = new Set<string>();
  const pushes: string[] = [];
  const certs = new CameraCerts({
    dir: mkdtempSync(join(tmpdir(), 'camproxy-ccerts-')),
    ca: () => ca, site: () => 'garage', enabled: () => true,
    cameras: () => o.cameras ?? [{ id: 'cam3', address: '192.168.60.13', protocol: 'https' }],
    served: async (id) => served.get(id) ?? null,
    push: async (id: string, leaf: Leaf): Promise<PushResult> => {
      pushes.push(id);
      if (o.refuse) return { outcome: 'refused', served: served.get(id) ?? null, tookMs: 1 };
      served.set(id, leaf.fingerprint);
      return { outcome: 'pushed', served: leaf.fingerprint, tookMs: 1 };
    },
    openEvent: (id) => open.has(id),
    localHour: (t) => new Date(t).getUTCHours(),
    now: () => now,
  });
  return { certs, pushes, open, served, at: (ms: number) => (now = ms), now: () => now };
}

describe('camera certificates (spec §10.1.3)', () => {
  it('a new camera gets its leaf and a push at the next tick (Ruling P5-5); then site-ca', async () => {
    const { certs, pushes } = setup();
    await certs.tick();
    expect(pushes).toEqual(['cam3']);
    expect(certs.state('cam3')).toMatchObject({ mode: 'site-ca', servername: 'cam3.garage.internal', fingerprint: certs.leaf('cam3')!.fingerprint, lastPush: { outcome: 'pushed' }, problem: null });
    await certs.tick();
    expect(pushes).toEqual(['cam3']); // served = the leaf: nothing to do
  }, 60_000);

  it('never during an open event', async () => {
    const { certs, pushes, open } = setup();
    open.add('cam3');
    await certs.tick();
    expect(pushes).toEqual([]);
    open.delete('cam3');
    await certs.tick();
    expect(pushes).toEqual(['cam3']);
  }, 60_000);

  it('renewal: a new leaf 30 days before expiry, pushed at 04:00 camera time only', async () => {
    const { certs, pushes, at } = setup();
    await certs.tick();
    const first = certs.leaf('cam3')!;
    const d = new Date(first.notAfter - 20 * 86400_000);
    at(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 10, 0));
    await certs.tick();
    expect(pushes).toEqual(['cam3']); // renewal due, but not at 10:00
    at(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 4, 5));
    await certs.tick();
    expect(pushes).toEqual(['cam3', 'cam3']);
    expect(certs.leaf('cam3')!.fingerprint).not.toBe(first.fingerprint);
  }, 60_000);

  it('refused: pinned with the served fingerprint; the next try waits for 04:00 (Ruling P5-6)', async () => {
    const { certs, pushes } = setup({ refuse: true });
    await certs.tick();
    expect(certs.state('cam3')).toMatchObject({ mode: 'pinned', fingerprint: 'SHA256:FACTORY3', lastPush: { outcome: 'refused' } });
    await certs.tick();
    expect(pushes).toEqual(['cam3']);
  }, 60_000);

  it('http: none; tlsName: public; an address outside the CA: none with the problem', async () => {
    const { certs, pushes } = setup({ cameras: [
      { id: 'cam3', address: '192.168.60.13', protocol: 'http' },
      { id: 'cam4', address: '192.168.60.14', protocol: 'https', tlsName: 'cam4.example.org' },
      { id: 'cam5', address: '192.168.61.15', protocol: 'https' },
    ] });
    await certs.tick();
    expect(pushes).toEqual([]);
    expect(certs.state('cam3').mode).toBe('none');
    expect(certs.state('cam4')).toMatchObject({ mode: 'public', servername: 'cam4.example.org' });
    expect(certs.state('cam5')).toMatchObject({ mode: 'none', problem: '192.168.61.15 is outside the site CA: rotate the CA (tls-ca-rotate)' });
  }, 60_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tls-camera-certs.test.ts`
Expected: FAIL with `Failed to resolve import "../src/tls/camera-certs"`.

- [ ] **Step 3: Implement**

Create `src/tls/camera-certs.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AuditLog } from '../audit/audit-log';
import { logger } from '../log';
import type { SiteCa } from './ca';
import { issueLeaf, leafOf, renewalDue, type Leaf } from './leaf';
import type { PushOutcome, PushResult } from './push';

export type CertMode = 'site-ca' | 'pinned' | 'public' | 'none';
export interface CertState { mode: CertMode; servername: string | null; fingerprint: string | null; notAfter: number | null; lastPush: { at: number; outcome: PushOutcome } | null; problem: string | null }
export interface CertCamera { id: string; address: string; protocol: 'https' | 'http'; tlsName?: string }
export interface CameraCertsDeps {
  dir: string;
  ca: () => SiteCa | null;
  site: () => string | undefined;
  enabled: () => boolean;
  cameras: () => CertCamera[];
  served: (id: string) => Promise<string | null>;
  push: (id: string, leaf: Leaf) => Promise<PushResult>;
  openEvent: (id: string) => boolean;
  localHour: (now: number) => number;
  onSiteCa?: (id: string) => void;
  audit?: Pick<AuditLog, 'write'>;
  onPush?: (id: string, outcome: PushOutcome) => void;
  now?: () => number;
}

const WINDOW_HOUR = 4; // renewals and retries after a refusal: 04:00 camera time

// Each camera's certificate from the site CA (spec 2026-10-05-multi-camera-host-design
// §10.1.3, §10.4): issued, pushed and renewed one camera at a time.
export class CameraCerts {
  private readonly states = new Map<string, CertState>();
  private readonly leaves = new Map<string, Leaf>();
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;

  constructor(private readonly d: CameraCertsDeps) {
    for (const [id, lastPush] of Object.entries(this.readState())) this.states.set(id, { ...this.blank(), lastPush });
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }
  private blank(): CertState {
    return { mode: 'none', servername: null, fingerprint: null, notAfter: null, lastPush: null, problem: null };
  }
  private camDir(): string {
    const dir = join(this.d.dir, 'cameras');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  private readState(): Record<string, CertState['lastPush']> {
    try {
      return JSON.parse(readFileSync(join(this.d.dir, 'cameras', 'state.json'), 'utf8'));
    } catch {
      return {};
    }
  }
  private saveState(): void {
    const out = Object.fromEntries([...this.states].map(([id, s]) => [id, s.lastPush]));
    const file = join(this.camDir(), 'state.json');
    writeFileSync(`${file}.tmp`, JSON.stringify(out));
    renameSync(`${file}.tmp`, file);
  }

  state(id: string): CertState {
    return { ...(this.states.get(id) ?? this.blank()) };
  }
  leaf(id: string): Leaf | null {
    return this.leaves.get(id) ?? this.load(id);
  }

  private load(id: string): Leaf | null {
    const crt = join(this.d.dir, 'cameras', `${id}.crt`);
    const key = join(this.d.dir, 'cameras', `${id}.key`);
    if (!existsSync(crt) || !existsSync(key)) return null;
    const l = leafOf(readFileSync(crt, 'utf8'), readFileSync(key, 'utf8'));
    this.leaves.set(id, l);
    return l;
  }

  private async issue(id: string, cam: CertCamera, ca: SiteCa, site: string): Promise<Leaf> {
    const name = `${id}.${site}.internal`;
    const l = await issueLeaf(ca, { cn: name, dns: [name], ips: [cam.address] });
    const dir = this.camDir();
    writeFileSync(join(dir, `${id}.key`), l.keyPem, { mode: 0o600 });
    writeFileSync(join(dir, `${id}.crt`), l.certPem, { mode: 0o644 });
    this.leaves.set(id, l);
    return l;
  }

  private set(id: string, s: Partial<CertState>): CertState {
    const next = { ...(this.states.get(id) ?? this.blank()), ...s };
    this.states.set(id, next);
    return next;
  }

  // One pass over the cameras, one at a time (a second call joins the first).
  tick(): Promise<void> {
    this.running ??= this.pass().finally(() => (this.running = null));
    return this.running;
  }

  private async pass(): Promise<void> {
    for (const cam of this.d.cameras()) {
      try {
        await this.one(cam, false);
      } catch (err) {
        logger.warn({ cameraId: cam.id, err: (err as Error).message }, 'camera_cert_check_failed');
      }
    }
  }

  async pushNow(id: string): Promise<PushResult> {
    const cam = this.d.cameras().find((c) => c.id === id);
    if (!cam) return { outcome: 'failed', served: null, detail: 'no such camera', tookMs: 0 };
    return (await this.one(cam, true)) ?? { outcome: 'current', served: this.state(id).fingerprint, tookMs: 0 };
  }

  private async one(cam: CertCamera, manual: boolean): Promise<PushResult | null> {
    const ca = this.d.ca();
    const site = this.d.site();
    if (cam.protocol !== 'https') return this.set(cam.id, { mode: 'none', servername: null, problem: null }), null;
    if (cam.tlsName) return this.set(cam.id, { mode: 'public', servername: cam.tlsName, fingerprint: await this.d.served(cam.id), problem: null }), null;
    if (!ca || !site || !this.d.enabled()) return this.set(cam.id, { mode: 'none', problem: null }), null;
    if (!ca.covers(cam.address)) return this.set(cam.id, { mode: 'none', problem: `${cam.address} is outside the site CA: rotate the CA (tls-ca-rotate)` }), null;
    const now = this.now();
    const inWindow = this.d.localHour(now) === WINDOW_HOUR;
    let leaf = this.leaf(cam.id);
    if (!leaf || !leaf.ips.includes(cam.address)) leaf = await this.issue(cam.id, cam, ca, site);
    const served = await this.d.served(cam.id);
    const renewing = renewalDue(leaf, now);
    if (renewing && (inWindow || manual)) leaf = await this.issue(cam.id, cam, ca, site);
    const s = this.states.get(cam.id);
    const servesLeaf = served === leaf.fingerprint;
    if (servesLeaf) {
      // Serving the leaf clears an earlier failed or refused push (the health item, Ruling P5-9).
      const stale = s?.lastPush && s.lastPush.outcome !== 'pushed' && s.lastPush.outcome !== 'current';
      this.set(cam.id, { mode: 'site-ca', servername: `${cam.id}.${site}.internal`, fingerprint: leaf.fingerprint, notAfter: leaf.notAfter, problem: null, ...(stale ? { lastPush: { at: now, outcome: 'current' as const } } : {}) });
      if (stale) this.saveState();
      if (s?.mode !== 'site-ca') this.d.onSiteCa?.(cam.id);
      return null;
    }
    const refusedBefore = s?.lastPush?.outcome === 'refused';
    if (!manual && (refusedBefore || renewing) && !inWindow) {
      if (refusedBefore) this.set(cam.id, { mode: 'pinned', fingerprint: served });
      return null;
    }
    if (this.d.openEvent(cam.id)) return null; // never during an open event: the next tick
    const r = await this.d.push(cam.id, leaf);
    const lastPush = { at: now, outcome: r.outcome };
    if (r.outcome === 'pushed' || r.outcome === 'current') {
      this.set(cam.id, { mode: 'site-ca', servername: `${cam.id}.${site}.internal`, fingerprint: leaf.fingerprint, notAfter: leaf.notAfter, lastPush, problem: null });
      this.d.onSiteCa?.(cam.id);
    } else {
      // The fallback (spec §10.1.4): cams pins what the camera serves.
      this.set(cam.id, { mode: 'pinned', servername: null, fingerprint: r.served, notAfter: null, lastPush, problem: r.outcome === 'failed' ? `push failed: ${r.detail ?? 'unknown'}` : null });
    }
    this.saveState();
    this.d.onPush?.(cam.id, r.outcome);
    this.d.audit?.write({ action: 'camera-cert-push', category: ['configuration'], type: ['change'], outcome: r.outcome === 'pushed' || r.outcome === 'current' ? 'success' : 'failure', user: manual ? 'admin' : 'system', camera: cam.id, message: `Camera certificate ${r.outcome} (${cam.id}, ${Math.round(r.tookMs / 1000)} s)`, details: { served: r.served, leaf: leaf.fingerprint, notAfter: leaf.notAfter, ...(r.detail ? { detail: r.detail } : {}) } });
    return r;
  }

  start(everyMs = 600_000): void {
    const t = () => void this.tick().finally(() => (this.timer = setTimeout(t, everyMs)));
    this.timer = setTimeout(t, 30_000);
    this.timer.unref();
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}
```

Add `'camera-cert-push'` (and, for Task 10, `'camera-ntp'`) to `AUDIT_ACTIONS` after `'camera-address'`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/tls-camera-certs.test.ts test/audit-actions.test.ts && npm run lint:types`
Expected: PASS (`5 passed` and the actions test).

- [ ] **Step 5: Commit**

```bash
git add src/tls/camera-certs.ts src/audit/actions.ts test/tls-camera-certs.test.ts
git commit -m "feat(tls): camera certificate state and scheduler (one at a time, 04:00 renewals, never during an event)"
```

---

### Task 8: The proxy: CA at start, HTTPS listener, `/tls/ca.pem`, FTPS, the workers' trust

**Files:**
- Create: `src/api/tls-api.ts`
- Modify: `src/proxy.ts`, `src/cameras/worker.ts` (`tls` dep: the CA and servername for its client), `src/clips/side.ts` (FTPS certificate from the proxy leaf), `src/api/control-api.ts` (`camera-cert-push` camera action, `tls-ca-rotate` host action, `GET /control/tls`), `openapi.yaml`, `test/openapi.test.ts` (the filter takes `/tls/`)
- Test: `test/tls-api.test.ts` (new)

**Interfaces:**
- Produces:
  - `tlsApi(d: { ca: () => SiteCa | null }): express.Router` — `GET /tls/ca.pem` (no auth).
  - `GET /control/tls` → `{ site: string | null; caFingerprint: string | null; caNotAfter: number | null; proxy: { servername: string; fingerprint: string; notAfter: number } | null; cameras: (CertState & { id: string })[]; problems: string[] }`.
  - Actions: `POST /control/cameras/:cam/actions/camera-cert-push` → `200 PushResult`; `POST /control/actions/tls-ca-rotate` with `{ confirm: 'rotate' }` → `200 { caFingerprint }` (a new CA; the old files kept as `ca.pem.old-<time>`, `ca.key.old-<time>`; every camera re-pushed at the next tick).
  - `WorkerDeps.tls?: (id: string) => { ca: string; servername: string } | undefined` — used when building the client: `tlsServername: t.servername, tlsCa: t.ca` (a camera with `tlsName` keeps public-CA verification).
  - `Proxy.certs?: CameraCerts` (test seam: `tick()`).

- [ ] **Step 1: Write the failing test**

Create `test/tls-api.test.ts`:

```ts
import { mkdtempSync } from 'fs';
import https from 'https';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, auth, freePort, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
let tlsPort = 0;
beforeAll(async () => {
  sim = await startSim();
  tlsPort = await freePort();
  p = await startProxy(sim, { settings: { tls: { site: 'test', cameraSubnet: '127.0.0.0/8', proxyAddresses: '127.0.0.1' }, server: { logLevel: 'silent', tls: { port: tlsPort } } } });
}, 90_000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

describe('the proxy side of the site CA (spec §10.4)', () => {
  it('GET /tls/ca.pem: public, the CA; its fingerprint in /control/tls', async () => {
    const r = await request(p.base).get('/tls/ca.pem');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/x-pem-file/);
    expect(r.text).toContain('BEGIN CERTIFICATE');
    const t = (await request(p.base).get('/control/tls').set(auth(ADMIN_TOKEN))).body;
    expect(t).toMatchObject({ site: 'test', caFingerprint: expect.stringMatching(/^SHA256:[0-9A-F]{64}$/), proxy: { servername: 'proxy.test.internal' } });
  });

  it('HTTPS with the proxy leaf, verified against the CA by its .internal name', async () => {
    const ca = (await request(p.base).get('/tls/ca.pem')).text;
    const body = await new Promise<string>((resolve, reject) => {
      https.get({ host: '127.0.0.1', port: tlsPort, path: '/health', servername: 'proxy.test.internal', ca }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve(b));
      }).on('error', reject);
    });
    expect(JSON.parse(body).ok).toBe(true);
  });

  it('without tls.site: 404 no_site_ca', async () => {
    const s2 = await startSim();
    const q = await startProxy(s2);
    try {
      expect((await request(q.base).get('/tls/ca.pem')).body).toEqual({ error: 'no_site_ca' });
    } finally {
      await q.proxy.stop();
      await s2.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tls-api.test.ts`
Expected: FAIL — `/tls/ca.pem` answers the admin UI page or 404 `not_found`.

- [ ] **Step 3: Implement**

Create `src/api/tls-api.ts`:

```ts
import express from 'express';
import type { SiteCa } from '../tls/ca';

// The site CA's certificate, public (spec 2026-10-05-multi-camera-host-design
// §10.1.4): cams fetches it and accepts it only if its fingerprint matches its
// pin. Never the key.
export function tlsApi(d: { ca: () => SiteCa | null }): express.Router {
  const r = express.Router();
  r.get('/tls/ca.pem', (_req, res) => {
    const ca = d.ca();
    if (!ca) return void res.status(404).json({ error: 'no_site_ca' });
    res.type('application/x-pem-file').set('Cache-Control', 'no-cache').send(ca.certPem);
  });
  return r;
}
```

`src/proxy.ts`:
- `createProxy` stays synchronous; the CA is loaded in `start()` (RSA generation is async): `let ca: SiteCa | null = null; let caProblem: string | null = null; let proxyLeaf: Leaf | null = null;`. In `start()`, before the listeners:

```ts
      if (running.tls.site) {
        try {
          ca = await siteCa(join(running.server.dataDir, 'tls'), { site: running.tls.site, cameraSubnet: running.tls.cameraSubnet!, proxyAddresses: running.tls.proxyAddresses!.split(',') });
          proxyLeaf = await proxyLeafFor(ca);
        } catch (err) {
          caProblem = (err as Error).message;
          logger.error({ err: caProblem }, 'site_ca_unavailable');
        }
      }
```

with `proxyLeafFor(ca)` loading `<dataDir>/tls/proxy.crt|key` or issuing (`issueLeaf(ca, { cn: 'proxy.<site>.internal', dns: ['proxy.<site>.internal'], ips: addresses.filter((a) => ca.covers(a)), keyFormat: 'pkcs8' })`) when missing, not covering an address, or `renewalDue`; a daily timer re-checks and calls `httpsServer.setSecureContext({ cert, key })` after a renewal.
- After the HTTP listener: `if (running.server.tls.port && proxyLeaf) { httpsServer = https.createServer({ cert: proxyLeaf.certPem, key: proxyLeaf.keyPem }, app); await listen(httpsServer, running.server.tls.port, opts.host ?? '0.0.0.0'); }` and close it in `doStop()` next to the HTTP server.
- Mount `app.use(tlsApi({ ca: () => ca }))` right after `/health` and `/metrics` (before `/api`, `/control` and the admin UI's catch-all, which excludes paths starting `tls/`: change its RegExp to `/^\/(?!api\/|control\/|tls\/|health$|metrics$).*/`).
- `CameraCerts`: built in `start()` when `ca` exists:

```ts
        certs = new CameraCerts({
          dir: join(running.server.dataDir, 'tls'),
          ca: () => ca, site: () => running.tls.site, enabled: () => running.tls.cameraCerts,
          cameras: () => cams.list().map((w) => { const c = w.cam(); return { id: w.id, address: bareHost(splitHost(c.host).hostname), protocol: c.protocol, ...(c.tlsName ? { tlsName: c.tlsName } : {}) }; }),
          served: (id) => { const c = cameraConfig(running, id)!; const { hostname, port } = splitHost(c.host); return servedFingerprint(bareHost(hostname), port ?? 443); },
          push: (id, leaf) => { const w = cams.get(id)!; return pushCertificate({ served: () => { const { hostname, port } = splitHost(w.cam().host); return servedFingerprint(bareHost(hostname), port ?? 443); }, command: (cmd, p) => w.client.command(cmd, p), relogin: () => w.client.forgetToken(), logout: () => w.client.logout() }, leaf); },
          openEvent: (id) => openEvents(catalog, id).length > 0,
          localHour: (t) => new Date(t + localOffsetMinutes(t, cams.first().timeInfo()) * 60_000).getUTCHours(),
          onSiteCa: (id) => void cams.get(id)?.restart(),
          audit,
          onPush: (id, outcome) => metrics.onCertPush(id, outcome),
        });
        certs.start();
```

  (`certs.stop()` in `doStop()`.) Each worker's `tls` dep: `(id) => { const s = certs?.state(id); return ca && s?.mode === 'site-ca' && s.servername ? { ca: ca.certPem, servername: s.servername } : undefined; }`; in `src/cameras/worker.ts` `build()`, `new ReolinkClient({ …, tlsServername: t?.servername ?? c.tlsName, ...(t ? { tlsCa: t.ca } : {}) })` with `const t = c.tlsName ? undefined : this.d.tls?.(this.id);`.
- FTPS: `createClipsSide` gets `tls?: () => { cert: string; key: string } | undefined`; `ftpTls(cfg)` prefers it (`proxyLeaf`), then `certFile`/`keyFile`, then the self-signed one.
- `GET /control/tls` and the two actions in `src/api/control-api.ts` (`ControlDeps.tls: { view(): …; pushNow(id): Promise<PushResult>; rotate(): Promise<string> }`); `camera-cert-push` joins `CAMERA_ACTIONS`; `tls-ca-rotate` is a host action that requires `req.body?.confirm === 'rotate'` (`400 invalid` otherwise) and writes a `config-change` audit record "Site CA rotated: <old fingerprint> → <new>". `rotate()` in proxy: rename `ca.pem`/`ca.key` and every `cameras/*.crt|key` and `proxy.*` to `*.old-<time>`, `ca = await siteCa(…)`, new proxy leaf + `setSecureContext`, `await certs.tick()`.
- `openapi.yaml`: `/tls/ca.pem` (get, `security: []`), `/control/tls` (get), and mention `camera-cert-push`, `tls-ca-rotate` in `/control/actions/{name}` and the camera route; in `test/openapi.test.ts` the `registered()` filter gains `|^\w+ \/tls\/` so `/tls/ca.pem` is checked too.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/tls-api.test.ts test/openapi.test.ts test/control-api.test.ts test/ftp-server.test.ts && npm run lint:types && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/tls-api.ts src/proxy.ts src/cameras/worker.ts src/clips/side.ts src/api/control-api.ts openapi.yaml test/openapi.test.ts test/tls-api.test.ts
git commit -m "feat(tls): HTTPS with the site CA, /tls/ca.pem, cameras verified against the CA, FTPS with the proxy leaf"
```

---

### Task 9: `tls` in `/api/cameras`, the `certificates` health item, metrics

**Files:**
- Modify: `src/api/client-api.ts` (`tls` block), `src/health/summary.ts` (`certificates` item; `cameras[].cert`), `src/api/metrics.ts`, `src/proxy.ts`
- Test: `test/health-certificates.test.ts` (new), `test/client-api.test.ts` (the exact object gains `tls`)

**Interfaces:**
- Produces:
  - `GET /api/cameras` item `tls` (see **Interfaces for cams**); without a site CA: `{ mode: 'none' | 'public', servername: <tlsName> | null, fingerprint: null, notAfter: null, lastPush: null }`.
  - `HealthInput.certificates?: { proxy: { notAfter: number } | null; cameras: { id: string; state: CertState }[]; problems: string[] } | null`; a `certificates` item (after `archive`) only when `tls.site` is set; `CameraHealth.cert: CertState | null`.
  - Metrics: `camproxy_cert_not_after_seconds{cam}` (the proxy's own under `cam="proxy"`), `camproxy_cert_push_total{cam,outcome}`; `metrics.onCertPush(cam, outcome)`.
- Rule (Ruling P5-9): `problem` when the proxy leaf or any camera leaf in `site-ca` mode expires within 14 days, a camera's last push was `failed` or `refused`, or `problems` is not empty (an address outside the CA, a CA without its key).

- [ ] **Step 1: Write the failing test**

Create `test/health-certificates.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildHealth } from '../src/health/summary';
import { input, NOW } from './helpers/health-input';

const DAY = 86400_000;
const ok = { mode: 'site-ca' as const, servername: 'cam1.g.internal', fingerprint: 'SHA256:A', notAfter: NOW + 200 * DAY, lastPush: { at: NOW - DAY, outcome: 'pushed' as const }, problem: null };
const item = (h: ReturnType<typeof buildHealth>) => h.items.find((i) => i.id === 'certificates');

describe('the certificates item (spec §10.5)', () => {
  it('absent without a site CA (the Pi)', () => {
    expect(item(buildHealth(input()))).toBeUndefined();
  });
  it('fine: the earliest expiry', () => {
    expect(item(buildHealth(input({ certificates: { proxy: { notAfter: NOW + 300 * DAY }, cameras: [{ id: 'cam1', state: ok }], problems: [] } })))).toEqual({ id: 'certificates', label: 'Certificates', value: 200, text: 'valid 200 more days', problem: false });
  });
  it('a problem within 14 days, after a failed or refused push, or with a CA problem', () => {
    const soon = { ...ok, notAfter: NOW + 10 * DAY };
    expect(item(buildHealth(input({ certificates: { proxy: { notAfter: NOW + 300 * DAY }, cameras: [{ id: 'cam1', state: soon }], problems: [] } })))).toMatchObject({ value: 10, text: 'cam1 expires in 10 days', problem: true });
    const refused = { ...ok, mode: 'pinned' as const, lastPush: { at: NOW, outcome: 'refused' as const } };
    expect(item(buildHealth(input({ certificates: { proxy: null, cameras: [{ id: 'cam1', state: refused }], problems: [] } })))).toMatchObject({ text: 'cam1: push refused (pinned)', problem: true });
    expect(item(buildHealth(input({ certificates: { proxy: null, cameras: [], problems: ['ca.key is missing'] } })))).toMatchObject({ text: 'ca.key is missing', problem: true });
  });
  it("the camera block carries its certificate state", () => {
    const h = buildHealth(input({ certificates: { proxy: null, cameras: [{ id: 'cam1', state: ok }], problems: [] } }));
    expect(h.cameras[0].cert).toEqual(ok);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/health-certificates.test.ts`
Expected: FAIL — no `certificates` item.

- [ ] **Step 3: Implement**

`src/health/summary.ts`: `ItemId` gains `'certificates'`; `HealthInput` gains `certificates?` (above); `cameraHealth()` sets `cert` from `i.certificates?.cameras.find((c) => c.id === <this camera>)?.state ?? null`; after the archive item:

```ts
  const ce = i.certificates;
  if (ce) {
    const DAY = 86400_000;
    const days = (t: number) => Math.floor((t - i.now) / DAY);
    const bad = ce.cameras.find((c) => c.state.lastPush && (c.state.lastPush.outcome === 'failed' || c.state.lastPush.outcome === 'refused'));
    const expiries = [...(ce.proxy ? [{ who: 'the proxy', at: ce.proxy.notAfter }] : []), ...ce.cameras.filter((c) => c.state.mode === 'site-ca' && c.state.notAfter !== null).map((c) => ({ who: c.id, at: c.state.notAfter! }))].sort((a, b) => a.at - b.at);
    const first = expiries[0];
    const soon = first && days(first.at) < 14;
    const text = ce.problems[0] ?? (bad ? `${bad.id}: push ${bad.state.lastPush!.outcome}${bad.state.mode === 'pinned' ? ' (pinned)' : ''}` : soon ? `${first.who} expires in ${days(first.at)} days` : first ? `valid ${days(first.at)} more days` : 'no certificates yet');
    add('certificates', 'Certificates', first ? days(first.at) : null, text, ce.problems.length > 0 || !!bad || !!soon);
  }
```

`src/api/client-api.ts` `info(w)`: `tls: d.tls?.(w.id) ?? { mode: w.cam().protocol === 'https' && w.cam().tlsName ? 'public' : 'none', servername: w.cam().tlsName ?? null, fingerprint: null, notAfter: null, lastPush: null }` with a new dep `tls?: (id) => CertState-shaped view | undefined` (from `certs.state(id)` without `problem`). `src/api/metrics.ts`: the gauge reads a new source `certs: () => { cam: string; notAfter: number | null }[]` and the counter `cert_push_total`; `onCertPush`. `src/proxy.ts` passes `certificates: ca || caProblem ? { proxy: proxyLeaf ? { notAfter: proxyLeaf.notAfter } : null, cameras: cams.ids().map((id) => ({ id, state: certs!.state(id) })), problems: [...(caProblem ? [caProblem] : []), ...uncovered()] } : null` to `buildHealth`, where `uncovered()` lists `tls.proxyAddresses` entries `ca.covers()` refuses ("<address> is outside the site CA: rotate the CA (tls-ca-rotate)") — Review Focus 2.

Add to the test a case for Review Focus 2 (append to `test/health-certificates.test.ts`):

```ts
  it('address outside the CA: named, and a problem', () => {
    const h = buildHealth(input({ certificates: { proxy: { notAfter: NOW + 300 * DAY }, cameras: [], problems: ['192.168.1.231 is outside the site CA: rotate the CA (tls-ca-rotate)'] } }));
    expect(item(h)).toMatchObject({ text: '192.168.1.231 is outside the site CA: rotate the CA (tls-ca-rotate)', problem: true });
  });
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/health-certificates.test.ts test/health-summary.test.ts test/health-display-compat.test.ts test/client-api.test.ts && npm run lint:types && npm test`
Expected: all pass (the display fixtures still match: the item only exists with a site CA).

- [ ] **Step 5: Commit**

```bash
git add src/api/client-api.ts src/health/summary.ts src/api/metrics.ts src/proxy.ts test/health-certificates.test.ts test/client-api.test.ts
git commit -m "feat(tls): tls block in /api/cameras, certificates health item, certificate metrics"
```

---

### Task 10: The cameras' NTP server

**Files:**
- Create: `src/cameras/ntp.ts`
- Modify: `src/cameras/worker.ts` (on coming online), `src/api/control-api.ts` (`camera-ntp-set` camera action), `openapi.yaml` (the action list)
- Test: `test/camera-ntp.test.ts` (new)

**Interfaces:**
- Produces:

```ts
export type NtpOutcome = 'set' | 'already' | 'unsupported' | 'failed';
// GetNtp; when its server differs: SetNtp with the whole object (server, enable 1), GetNtp again; logout.
export async function ensureNtp(client: Pick<ReolinkClient, 'command' | 'logout'>, server: string): Promise<{ outcome: NtpOutcome; before?: unknown; after?: unknown; detail?: string }>;
```
- Worker: when `ntp.server` is set and the camera comes online, `ensureNtp` at most once per hour per camera (Ruling P5-7); an outcome other than `already` writes a `camera-ntp` audit record with the camera label.

- [ ] **Step 1: Write the failing test**

Create `test/camera-ntp.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReolinkClient } from '../src/camera/client';
import { ensureNtp } from '../src/cameras/ntp';
import { startSim } from './helpers/sim';

let sim: Awaited<ReturnType<typeof startSim>>;
let client: ReolinkClient;
beforeAll(async () => {
  sim = await startSim();
  client = new ReolinkClient({ id: 'cam3', host: sim.camera.host, protocol: 'http', user: 'proxy', password: sim.password });
});
afterAll(async () => {
  await sim.close();
});

describe("the cameras' NTP server (spec §14.2)", () => {
  it('sets the whole object once; then already', async () => {
    const r = await ensureNtp(client, '192.168.60.1');
    expect(r.outcome).toBe('set');
    expect((r.after as { server: string; enable: number })).toMatchObject({ server: '192.168.60.1', enable: 1 });
    expect(Object.keys(r.after as object).sort()).toEqual(Object.keys(r.before as object).sort()); // whole object, nothing dropped
    expect((await ensureNtp(client, '192.168.60.1')).outcome).toBe('already');
    expect(sim.sim.engine.counters.setCalls.filter((c: string) => c === 'SetNtp')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/camera-ntp.test.ts`
Expected: FAIL with `Failed to resolve import "../src/cameras/ntp"`.

- [ ] **Step 3: Implement**

Create `src/cameras/ntp.ts`:

```ts
import { CameraError, type ReolinkClient } from '../camera/client';

export type NtpOutcome = 'set' | 'already' | 'unsupported' | 'failed';

// The camera's NTP server → the host (spec 2026-10-05-multi-camera-host-design
// §14.2): the firmware may ignore DHCP option 42. A whole-object SetNtp,
// read back, then log out (CLAUDE.md: real-camera settings rules).
export async function ensureNtp(client: Pick<ReolinkClient, 'command' | 'logout'>, server: string): Promise<{ outcome: NtpOutcome; before?: unknown; after?: unknown; detail?: string }> {
  try {
    const before = (await client.command<{ Ntp?: Record<string, unknown> }>('GetNtp')).Ntp;
    if (!before) return { outcome: 'unsupported', detail: 'GetNtp gave no Ntp object' };
    if (before.server === server && Number(before.enable) === 1) return { outcome: 'already', before };
    await client.command('SetNtp', { Ntp: { ...before, enable: 1, server } });
    const after = (await client.command<{ Ntp?: Record<string, unknown> }>('GetNtp')).Ntp;
    if (after?.server !== server) return { outcome: 'failed', before, after, detail: 'the camera kept its NTP server' };
    return { outcome: 'set', before, after };
  } catch (err) {
    const code = err instanceof CameraError ? err.code : 'camera_error';
    return { outcome: /rspCode -9\b|not support/i.test((err as Error).message) ? 'unsupported' : 'failed', detail: `${code}: ${(err as Error).message}` };
  } finally {
    await client.logout().catch(() => undefined);
  }
}
```

`src/cameras/worker.ts`: in `build()`'s `status.on('change', …)` handler, when `s.online`: `void this.syncNtp()` with

```ts
  private ntpAt = 0;
  private async syncNtp(force = false): Promise<NtpOutcome | null> {
    const server = this.d.running().ntp.server;
    if (!server || (!force && Date.now() - this.ntpAt < 3600_000)) return null;
    this.ntpAt = Date.now();
    const r = await ensureNtp(this.client, server);
    if (r.outcome !== 'already') this.audit.write({ action: 'camera-ntp', category: ['configuration'], type: ['change'], outcome: r.outcome === 'set' ? 'success' : 'failure', user: 'system', message: `Camera NTP server ${r.outcome} (${server})${r.detail ? `: ${r.detail}` : ''}`, details: { server, outcome: r.outcome } });
    return r.outcome;
  }
```

(public `syncNtp(force)` for the action). `camera-ntp-set` joins `CAMERA_ACTIONS`; its case answers `200 { outcome }` from `c.ntp()` (add `ntp(): Promise<NtpOutcome | null>` to `CameraControl`, built as `() => w.syncNtp(true)`).

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/camera-ntp.test.ts test/control-camera-routes.test.ts test/openapi.test.ts && npm run lint:types && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/cameras/ntp.ts src/cameras/worker.ts src/api/control-api.ts src/api/camera-control.ts src/proxy.ts openapi.yaml test/camera-ntp.test.ts
git commit -m "feat(cameras): keep each camera's NTP server on the host (whole-object SetNtp)"
```

---

### Task 11: The Certificates card

**Files:**
- Create: `web/src/lib/tls.ts`, `web/src/components/CertificatesCard.svelte`
- Modify: `web/src/pages/Status.svelte` (the card when `/control/tls` has a site), `e2e/multi/start.ts` (`tls.site` on), `e2e/multi/cameras.spec.ts`
- Test: `test/tls-ui.test.ts` (new)

**Interfaces:**
- Produces (`web/src/lib/tls.ts`): `certLine(s: { mode; notAfter; lastPush }, now: number): string` ("site CA, 200 days left, pushed 3 h ago" / "pinned: the camera refused the import" / "public CA" / "HTTP: no certificate"); `fingerprintGroups(fp: string): string` (the hex in groups of four for reading aloud).

- [ ] **Step 1: Write the failing test**

Create `test/tls-ui.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { certLine, fingerprintGroups } from '../web/src/lib/tls';

const NOW = Date.UTC(2026, 9, 20, 12, 0);
const DAY = 86400_000;
describe('the Certificates card', () => {
  it('one line per camera', () => {
    expect(certLine({ mode: 'site-ca', notAfter: NOW + 200 * DAY, lastPush: { at: NOW - 3 * 3600_000, outcome: 'pushed' } }, NOW)).toBe('site CA, 200 days left, pushed 3 h ago');
    expect(certLine({ mode: 'pinned', notAfter: null, lastPush: { at: NOW, outcome: 'refused' } }, NOW)).toBe('pinned: the camera refused the import');
    expect(certLine({ mode: 'public', notAfter: null, lastPush: null }, NOW)).toBe('public CA');
    expect(certLine({ mode: 'none', notAfter: null, lastPush: null }, NOW)).toBe('HTTP: no certificate');
  });
  it('the fingerprint in groups of four', () => {
    expect(fingerprintGroups('SHA256:ABCDEF0123456789')).toBe('SHA256: ABCD EF01 2345 6789');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tls-ui.test.ts`
Expected: FAIL with `Failed to resolve import "../web/src/lib/tls"`.

- [ ] **Step 3: Implement**

```ts
// web/src/lib/tls.ts
import { agoText } from './format';

export interface CertView { mode: 'site-ca' | 'pinned' | 'public' | 'none'; notAfter: number | null; lastPush: { at: number; outcome: string } | null }

export function certLine(s: CertView, now: number): string {
  if (s.mode === 'none') return 'HTTP: no certificate';
  if (s.mode === 'public') return 'public CA';
  if (s.mode === 'pinned') return s.lastPush?.outcome === 'refused' ? 'pinned: the camera refused the import' : 'pinned';
  const days = s.notAfter === null ? null : Math.floor((s.notAfter - now) / 86400_000);
  return ['site CA', ...(days !== null ? [`${days} days left`] : []), ...(s.lastPush ? [`${s.lastPush.outcome} ${agoText(s.lastPush.at, now)}`] : [])].join(', ');
}

export const fingerprintGroups = (fp: string): string => `SHA256: ${fp.replace(/^SHA256:/, '').match(/.{1,4}/g)!.join(' ')}`;
```

`CertificatesCard.svelte` loads `GET /control/tls`: shows the site, the CA fingerprint (`fingerprintGroups`, with a Copy button copying the plain `SHA256:…` for cams' `caFingerprint`), a "Download the CA" link to `/tls/ca.pem` (for browsers: install it per docs), the proxy certificate's expiry, one row per camera with `certLine` and a "Push now" button (`POST` through `cameraPath(id, multi, 'actions/camera-cert-push')`, disabled for `none`/`public`), and the problems in red. `data-testid`s: `card-certificates`, `ca-fingerprint`, `cert-row-<id>`, `cert-push-<id>`. `Status.svelte` shows the card when `/control/tls`'s `site` is not null.

e2e: `e2e/multi/start.ts` sets `tls: { site: 'e2e', cameraSubnet: '127.0.0.0/8', proxyAddresses: '127.0.0.1' }` (the cameras stay on HTTP: mode `none`); append to `e2e/multi/cameras.spec.ts`:

```ts
test('the Certificates card: the CA fingerprint and its download', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByTestId('card-certificates')).toBeVisible();
  await expect(page.getByTestId('ca-fingerprint')).toContainText('SHA256:');
  expect((await request.get('/tls/ca.pem')).status()).toBe(200);
  await expect(page.getByTestId('cert-row-cam3')).toContainText('HTTP: no certificate');
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/tls-ui.test.ts && npm run check && npm run build && npm run test:e2e && npm run test:e2e:multi`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/tls.ts web/src/components/CertificatesCard.svelte web/src/pages/Status.svelte e2e/multi test/tls-ui.test.ts
git commit -m "feat(ui): the Certificates card"
```

---

### Task 12: End to end: two cam-sims over HTTPS, one refusing

**Files:**
- Modify: `test/helpers/multi.ts` (`https` option: cameras on `127.0.0.1:<https port>`, protocol `https`; per-sim `ignoreImport`)
- Test: `test/site-ca.test.ts` (new)

- [ ] **Step 1: Write the test**

`startMultiProxy(sims, { https: true, … })` writes `host: 127.0.0.1:<sim.ports.https>`, `protocol: 'https'` per camera; `startSims(n, { ignoreImport?: number[] })` passes `ignoreImport: true` to the sims at those indexes.

Create `test/site-ca.test.ts`:

```ts
import https from 'https';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { servedFingerprint } from '../src/tls/push';
import { ADMIN_TOKEN, auth, freePort, until } from './helpers/proxy';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';

let sims: Sim[];
let p: Awaited<ReturnType<typeof startMultiProxy>>;
let tlsPort = 0;
beforeAll(async () => {
  sims = await startSims(2, { ignoreImport: [1] });
  tlsPort = await freePort();
  p = await startMultiProxy(sims, { https: true, settings: { tls: { site: 't', cameraSubnet: '127.0.0.0/8', proxyAddresses: '127.0.0.1' }, server: { logLevel: 'silent', tls: { port: tlsPort } } } });
  await until(() => p.proxy.cameras.list().every((w) => w.status.state().online), 30_000);
  await p.proxy.certs!.tick();
}, 180_000);
afterAll(async () => {
  await p.proxy.stop();
  await Promise.all(sims.map((s) => s.close()));
});

describe('the site CA end to end (spec §15)', () => {
  it('cam3 serves its leaf; the proxy verifies it against the CA and still reaches it', async () => {
    const cams = (await request(p.base).get('/api/cameras').set(auth())).body;
    const c3 = cams.find((c: { id: string }) => c.id === 'cam3');
    expect(c3.tls).toMatchObject({ mode: 'site-ca', servername: 'cam3.t.internal', lastPush: { outcome: 'pushed' } });
    expect(await servedFingerprint('127.0.0.1', sims[0].ports.https)).toBe(c3.tls.fingerprint);
    await until(() => p.proxy.cameras.get('cam3')!.status.state().online, 30_000); // after the client switched to the CA
  }, 60_000);

  it('cam4 refused the import: pinned with its factory fingerprint (the fallback)', async () => {
    const c4 = (await request(p.base).get('/api/cameras').set(auth())).body.find((c: { id: string }) => c.id === 'cam4');
    expect(c4.tls).toMatchObject({ mode: 'pinned', fingerprint: await servedFingerprint('127.0.0.1', sims[1].ports.https), lastPush: { outcome: 'refused' } });
    const h = (await request(p.base).get('/api/local/health')).body;
    expect(h.items.find((i: { id: string }) => i.id === 'certificates')).toMatchObject({ problem: true, text: 'cam4: push refused (pinned)' });
  });

  it("the proxy's HTTPS verifies against /tls/ca.pem by proxy.t.internal", async () => {
    const ca = (await request(p.base).get('/tls/ca.pem')).text;
    const status = await new Promise<number>((resolve, reject) => https.get({ host: '127.0.0.1', port: tlsPort, path: '/api/cameras', servername: 'proxy.t.internal', ca, headers: auth() }, (r) => (r.resume(), resolve(r.statusCode ?? 0))).on('error', reject));
    expect(status).toBe(200);
  });

  it('Push now: the action on the camera route', async () => {
    const r = await request(p.base).post('/control/cameras/cam3/actions/camera-cert-push').set(auth(ADMIN_TOKEN));
    expect([r.status, r.body.outcome]).toEqual([200, 'current']);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/site-ca.test.ts`
Expected: PASS (`4 passed`). A failure points at Task 6 (push), 7 (state), 8 (wiring) or 9 (views).

- [ ] **Step 3: Whole suite**

Run: `npm run lint:types && npm test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add test/helpers/multi.ts test/site-ca.test.ts
git commit -m "test: the site CA end to end with two cam-sims (one refusing)"
```

---

### Task 13: Docs

**Files:**
- Modify: `README.md` (a **TLS: the site CA** section), `docs/multi-camera-host.md` (a section "## 13. TLS: the site CA"), `scripts/host/render.ts` and its test (the host's config.json gains `tls` and `server.tls.port`, `ntp.server`), `CHANGELOG.md`, `CLAUDE.md`

- [ ] **Step 1: The renderer writes the TLS settings** (append to `test/host-render.test.ts`):

```ts
  it('the proxy config turns the site CA on for the host', () => {
    const cfg = JSON.parse(renderHost(h())['srv/cam-proxy/data/config.json'].text);
    expect(cfg.tls).toEqual({ site: 'camhost1', cameraSubnet: '192.168.60.0/24', proxyAddresses: '<lan>,192.168.60.1' });
    expect(cfg.server.tls).toEqual({ port: 8443 });
    expect(cfg.ntp).toEqual({ server: '192.168.60.1' });
  });
```

— the LAN address isn't in host.json (DHCP): add `lan.address` to `HostDescription` (required; the address the router keeps for the PC) and use it instead of `<lan>` in both the renderer and this test (`192.168.1.230` in `host.example.json`). Implement in `proxyConfig()`: `tls: { site: h.hostname, cameraSubnet: cameraSubnet(h), proxyAddresses: [h.lan.address, h.cameraNet.address].join(',') }`, `server: { …, tls: { port: h.proxy.httpsPort } }`, `ntp: { server: h.cameraNet.address }`.

Run: `npx vitest run test/host-render.test.ts test/host-config.test.ts`
Expected: PASS.

- [ ] **Step 2: Write the docs**

- `README.md` **TLS: the site CA**: what `tls.site` does (spec §10.1 four points), the names (`<cam>.<site>.internal`, `proxy.<site>.internal`), `GET /tls/ca.pem` and the fingerprint cams pins, the fallback pin, the Certificates card, `tls-ca-rotate` (cams needs the new pin; it accepts a list), backups (`data/tls`), that the Pi keeps `tls.site` unset (Let's Encrypt through `cam1-cert-push`).
- `docs/multi-camera-host.md` §13: enabling (the rendered config already has it), checking each camera (`openssl s_client -connect 192.168.60.13:443 -servername cam3.<site>.internal -CAfile <(curl -s http://127.0.0.1:8480/tls/ca.pem)` → `Verify return code: 0`), installing the CA on Klaus's devices (macOS keychain "Always Trust", iOS profile + Certificate Trust Settings, Firefox's own store) and why the name constraints make that safe (spec §10.2, §10.6), the cameras' web pages over the route with a trusted certificate, and the cams side (handing the `SHA256:…` fingerprint to cams' generator input).
- `CHANGELOG.md` `## Unreleased`: "Site CA (`tls.site`): a name-constrained CA per host; camera certificates issued, pushed and renewed by the proxy; HTTPS on `server.tls.port`; `GET /tls/ca.pem`; the Certificates card; the `certificates` health item; `ntp.server` keeps the cameras' NTP on the host."
- `CLAUDE.md`: "`data/tls/ca.key` is the site CA's key: never print, copy into a repo, or log it; `tls-ca-rotate` invalidates every cams pin."

- [ ] **Step 3: Commit**

```bash
git add README.md docs/multi-camera-host.md scripts/host/render.ts scripts/host/host-config.ts deploy/host/host.example.json test/host-render.test.ts CHANGELOG.md CLAUDE.md
git commit -m "docs: the site CA; the host config turns it on"
```

---

### Task 14: On the device: the real cameras

Runs on the mini PC after the release with P5, with Klaus for the browser trust and the cams pin.

- [ ] **Step 1: Update the host** (`docker compose pull && docker compose up -d` in `/srv/cam-proxy`, after re-rendering `data/config.json` only if it has no `tls` yet — the file is kept by `prepare-host.sh`, so add the three settings of Task 13 by hand or through the Settings page).
Run: `curl -s http://127.0.0.1:8480/tls/ca.pem | openssl x509 -noout -subject -ext nameConstraints`
Expected: `subject=CN=cam-proxy site CA camhost1` and `Permitted: DNS:camhost1.internal, IP:192.168.60.0/255.255.255.0, IP:<lan>/255.255.255.255`.

- [ ] **Step 2: Every camera served its leaf** (within ~10 min of the start; the Certificates card):
Run per camera: `openssl s_client -connect 192.168.60.13:443 -servername cam3.camhost1.internal -CAfile <(curl -s http://127.0.0.1:8480/tls/ca.pem) </dev/null 2>/dev/null | grep 'Verify return code'`
Expected: `Verify return code: 0 (ok)` for each camera, or the camera shows `pinned` on the card (record which firmware refused).

- [ ] **Step 3: NTP**: `chronyc clients` lists every camera; the audit log has one `camera-ntp` `set` per camera (or `already`).

- [ ] **Step 4: HTTPS from the LAN**: from the Mac, `curl --cacert ca.pem --resolve proxy.camhost1.internal:8443:<lan> https://proxy.camhost1.internal:8443/health` answers `{"ok":true,…}`.

- [ ] **Step 5: Hand the pin to cams** (Klaus): the card's CA fingerprint goes into cams' generator input (the cams P5 plan); cams verifies the proxy and the cameras against it.

- [ ] **Step 6: The Pi is unchanged**: `curl -s http://192.168.1.220:8480/tls/ca.pem` → `{"error":"no_site_ca"}`; cam1 still serves its Let's Encrypt certificate.

- [ ] **Step 7: Record** the results in `docs/multi-camera-host.md` §12/§13 and the Obsidian note *Cameras/Reolink API Behaviour* (the import of a site-CA leaf on this firmware); commit `docs(host): site CA on the real cameras (results)`.

---

## After the plan (for the coordinator)

- Release when ready; the Pi gets the release too (no `tls.site`: nothing changes there).
- The cams P5 plan consumes **Interfaces for cams** above; any change to them needs both plans updated.
