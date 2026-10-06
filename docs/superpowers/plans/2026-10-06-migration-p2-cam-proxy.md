# cam-proxy: migration phase 2 (commands and tokens) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cam-proxy accepts signed, allow-listed, idempotent, audited commands from cams-admin over its existing outbound channel, and its first command, `tokens.apply`, installs cams-admin-managed client and admin token **hashes** next to the local `CAMPROXY_TOKENS`, with a local allow-list, a compiled deny list, a pause button and an environment kill switch that cams-admin can't undo.

**Architecture:** Everything new is in `src/fleet/` (canonical JSON, the command check, the journal, the command policy, the managed token store, the runner) plus small changes to auth (`src/api/auth.ts`, sessions, login links), the cams-admin card's control routes and the CLI. The wire format is cams-admin's `contract/v1` (additive: `command`, `result`, `event`; see "The P2 contract" below), vendored into `test/contract/cams-admin-v1/` and tested byte for byte. **No new runtime dependency** (Node 26 crypto, hand-written validators; `ajv` stays a dev dependency for the contract tests).

**Tech Stack:** TypeScript, Express 5, vitest, Svelte 5, Playwright (existing). Node ≥ 26.

**Spec:** cams-admin `docs/superpowers/specs/2026-10-06-cams-admin-migration-design.md` (cited **M §n**), sections §5, §7, §10, §13.1, §14, §15 (P2a, P2b), on the phase-1 contract of `docs/superpowers/specs/2026-10-06-cams-admin-phase1-design.md` (**P1 §n**; §8.4 "Signed commands"). Read both from cams-admin `main`. The companion plan is cams-admin `docs/superpowers/plans/2026-10-06-migration-p2-cams-admin.md`; the section "The P2 contract" is **identical** in both plans.

## Klaus's decisions (2026-10-06, recorded as decisions, not defaults)

Klaus pre-approved spec, plan, implementation and deployment, and answered M §16 with the spec's recommendations ("I follow the recommendations"):

1. **Held trust changes (M §9.7, Q1):** cams holds changed connection data (proxy URL, CA pins, TLS names, camera host) until an account admin confirms. *(P4; nothing in this plan.)*
2. **Stale cache (M §9.4, Q2):** cams uses its cached configuration however old it is. *(P4; nothing in this plan.)*
3. **Disruptive remote actions (M §8.6, Q3):** camera reboot, power-cycle, proxy restart and FTP/NTP/cert setup may be allowed for remote use **per proxy, off by default**. *(P3 implements them; this plan only makes their allow-list entries known names, so a P3-ready `config.json` loads, and allows none by default.)*

## Rulings made in this plan (where the spec is silent or unclear)

- **R2-1 Command policy lives outside `overrides.json`.** `camsAdmin.allowCommands` and `camsAdmin.commandsPaused` are read from `config.json` (deploy-time base) and from `data/admin/policy.json` (written only by the Status card and the CLI). M §7.5/§7.7 put them in `overrides.json`, which is the file P3's `config.set` writes; keeping them out means no remote write path can reach them even through a deny-list bug. They are not generic settings: `PUT /control/config` refuses them (`not_a_setting`).
- **R2-2 `tokens.apply.admin` is an allow-list entry, not a wire command.** One `tokens.apply` carries the full managed set. A set that **contains** an `admin` entry needs both `tokens.apply` and `tokens.apply.admin` in the allow-list (else the whole command is refused `not_allowed`, M §10.2); a set that only removes admin entries needs `tokens.apply` (narrowing is always allowed).
- **R2-3 Widening is local-only.** Adding allow-list entries, resuming after a pause, and unblocking a managed token need **local** admin rights: the `CAMPROXY_ADMIN_TOKEN` itself, or a UI session that was signed in with it (token form, or a login link minted with it). A managed admin token, and a session from a login link it minted, can only **narrow** (pause, remove entries, block a token). Reason: cams holds the managed admin token and can mint UI sign-in links with it; without this, a compromised cams-admin that issues itself an admin token could widen its own allow-list (M §13.1 names the risk; M2 says the local token is the break-glass).
- **R2-4 `exp` is checked on cams-admin's clock as this connection measured it.** The proxy keeps `offset = challenge.serverTime − localNowAtChallenge` (the challenge is signed) and checks `exp` against `Date.now() + offset` with ±120 s slack. The Pi has no RTC; P1 §8.4's "the proxy's clock" would refuse every command on a Pi whose clock is off. Replay protection still rests on `connId` + the seen-id set + `exp`.
- **R2-5 The environment kill switch fails closed.** `CAMPROXY_ADMIN_COMMANDS`: unset or `on` = commands possible; `off` **or any other value** = off (logged once as `admin_commands_env_off`). Read from the process environment **and** the env file (`CAMPROXY_ENV_FILE`); either one saying anything but `on` wins. Commands are then refused with `paused`, and the heartbeat says `enabled: false`.
- **R2-6 Local token block list.** The card/CLI can block a managed token id; the store keeps the id in `blocked`, `tokens.apply` never re-adds it, and the heartbeat reports it. The emergency stop for a bad managed token without waiting for cams-admin.
- **R2-7 Managed tokens outlive the channel.** The token store is read whenever `data/admin/tokens.json` exists, whatever `camsAdmin.url`/`enabled` say: unenrolling or a cams-admin outage never breaks cams. Blocking (R2-6) is the local way to drop them.
- **R2-8 Refusals (nacks) are not journaled.** cams-admin never re-sends a refused `cmdId`; a retry after fixing the cause is a new command. A replayed refused envelope is still stopped by `connId`, the seen-id set and `exp`.
- **R2-9 Fixture classes.** `refused-*` contract fixtures are valid by the strict schema and refused at run time by the receiver named in `$expect.receiver` (`proxy` here) with the code in `$expect.runtime`, under the `$context` given in the fixture.

## Global Constraints

- **Commands are OFF unless allowed locally.** Default `camsAdmin.allowCommands: []`, `commandsPaused: false`, env switch unset. With an empty allow-list every command is refused `not_allowed`; nothing new runs on the Pi or the cluster proxy after the release until someone allows a command on that proxy.
- **The Pi stays as it is:** no `camsAdmin.url` → no socket, no timer, and no `data/admin/` file written by this phase (`test/pi-compat.test.ts`). The client token path is unchanged when `data/admin/tokens.json` is absent.
- **`CAMPROXY_TOKENS` keeps working** at every step (managed tokens are added beside it). `CAMPROXY_ADMIN_TOKEN` stays required, local, never managed (M2).
- **Never logged, printed, audited, served, or sent:** tokens, token hashes beyond an 8-hex prefix (`sha256:1a2b3c4d…`), enrollment codes, private keys, `data/admin/*.json` contents. Audit records name a managed token by `id` and `label`.
- **Files in `data/admin/`** (`key.json`, `tokens.json`, `commands.json`, `policy.json`): mode 600, folder 700, written atomically (random temp name, fsync, rename), refused when group/world readable or owned by another uid (the key file's rule). Add the three new names to CLAUDE.md's never-print list.
- **Check order for a command is normative** (see "The P2 contract", *Check order*). A test pins it per step.
- **Limits (M §7.8):** 30 commands/min and 300/day in total; `tokens.apply` 6/hour; nack results at most 60/min (the rest dropped and counted). Never keyed on an address.
- **Journal:** the last 1000 `cmdId`s (and every one younger than 7 days, hard cap 2500) with their final result; written before the `done` result is sent.
- **Contract:** `test/contract/cams-admin-v1/` equals cams-admin `main`'s `contract/v1` (SOURCE excluded), checked by `scripts/contract-drift.sh` in PR checks.
- **`configRevision`** = `sha256:` + hex SHA-256 of `jcs(overrides)` (the overrides object as loaded, `{}` when the file is absent).
- **Config schema version** (`CONFIG_SCHEMA`) goes from 1 to 2 (`camsAdmin.commandsPaused` known; `allowCommands` accepts entries).
- Network exposure: none new. Cluster manifests are kube-setup's (no change needed, see "kube-setup").
- Real camera: untouched by this phase (no command reaches a camera in P2).

## Review Focus

1. **A command that arrives while the proxy's clock is far off (the Pi without RTC)** must still be accepted when fresh, and a captured command must still be refused on another connection. Task 5 (offset from the signed challenge; tests with a clock 3 years off and a replay on a second connection).
2. **A managed admin token used to widen the proxy's own allow-list** (directly, or through a login link and a UI session) must be refused, while pausing with it works. Task 4.
3. **cams-admin restored from an older backup** sends `tokens.apply` with a lower revision: the proxy answers `stale` with its own revision and keeps its set (no revoked token comes back). Task 3.
4. **A token rotation while cams is busy:** requests with the old token keep succeeding until `retireAt`, the new one works as soon as `done` is sent; zero 401s in a request loop. Task 9.
5. **A flood of hostile commands** (bad signatures, replays, wrong target, oversize args, unknown names) never slows stills/events/FTP/client API, never writes the journal or token store, and produces bounded audit records. Task 9.

---

## The P2 contract (identical in both plans; binding)

The envelope stays **v1**; the subprotocol stays `cams-admin.v1` (M §7.1). All additions are in cams-admin `contract/v1/` (lenient and strict schemas, fixtures, `vectors.json`), generated by `contract/build.ts` / `contract/make.ts` / `scripts/contract/make-vectors.ts`.

**Canonical JSON (RFC 8785, JCS)** — the same function in both repos (`server/crypto/jcs.ts`, `src/fleet/jcs.ts`):

```ts
// RFC 8785 for what the protocol carries: null, booleans, finite numbers,
// strings, arrays, plain objects. Keys sorted by UTF-16 code units (the
// default sort), strings and numbers as JSON.stringify writes them (ES2019+,
// which RFC 8785 adopts). Anything else (undefined, NaN, Infinity, functions,
// class instances, holes, depth > 32) throws.
export function jcs(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error('jcs: nested too deep');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('jcs: not a finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${Array.from(value, (v) => jcs(v, depth + 1)).join(',')}]`;
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error('jcs: not a plain object');
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${jcs(o[k], depth + 1)}`).join(',')}}`;
  }
  throw new Error(`jcs: cannot canonicalise ${typeof value}`);
}
```

**Signatures:** `sig = base64(Ed25519(UTF-8(jcs(envelope without sig))))`. cams-admin's key signs `command`; the proxy's key signs `result` and `event`. The receiver canonicalises **the parsed message as received** (unknown fields included) minus `sig`.

**`command`** (server → proxy; `sig` required; no `re`). Body:

| field | rule |
|---|---|
| `proxyId` | `^prx_[0-9A-HJKMNP-TV-Z]{20}$` |
| `connId` | `^con_[0-9A-HJKMNP-TV-Z]{20}$` |
| `cmdId` | `^cmd_[0-9A-HJKMNP-TV-Z]{20}$`, the idempotency key |
| `exp` | integer ms, `1 ≤ exp − ts ≤ 60000` |
| `actor` | string ≤ 200 (a sysadmin email, or `system`) |
| `command` | lenient `^[a-z][a-z.]{0,31}$`; strict enum `tokens.apply`, `config.get`, `config.set`, `config.unset`, `config.rollback`, `camera.action`, `camera.name.set`, `proxy.restart` |
| `args` | object with integer `v`; `jcs(args)` ≤ 16384 bytes |

**`result`** (proxy → server; `sig` required; `re` required = the command envelope's `id`). Body `{proxyId, connId, cmdId, phase, status?, code?, retryAfterS?, duplicate?, result?}`: `phase` `received` | `done`; `status` (required when `done`) `ok` | `failed` | `conflict` | `refused`; `code` string ≤ 64; `retryAfterS` integer ≥ 0; `duplicate` boolean; `result` object, `jcs(result)` ≤ 65536 bytes.

**`event`** (proxy → server; `sig` required; no `re`). Body `{proxyId, connId, kind: "command.done", cmdId, phase: "done", status, code?, duplicate?, result?}`: a `done` that could not be sent on its own connection, sent after the next `welcome` (`connId` = the new connection's).

**Nack codes** (`phase: done, status: refused`): `bad_signature`, `wrong_target`, `expired`, `replayed`, `not_allowed`, `paused`, `rate_limited` (with `retryAfterS`), `invalid_args`, `unsupported_version`, `busy`. A command whose body has no readable `cmdId` gets `error {code: "bad_message"}` with `re`, never a result.

**Check order on the proxy** (normative; each step's refusal wins over later ones):

1. `body.cmdId` matches the pattern, else `error bad_message`.
2. `sig` verifies against one of the pinned server keys, else `bad_signature` (a missing `sig` too).
3. `body.proxyId` is this proxy's and `body.connId` this connection's, else `wrong_target`.
4. The envelope `id` was not seen on this connection (then it is recorded), else `replayed`.
5. `exp` is an integer, `1 ≤ exp − ts ≤ 60000`, and `exp + 120000 ≥ serverNow`, where `serverNow = Date.now() + offset` (R2-4), else `expired`.
6. The journal has `cmdId`: answer its stored `done` with `duplicate: true` (or `received` with `duplicate: true` while it runs). Nothing runs.
7. Env kill switch off, or paused → `paused`.
8. `command` is implemented by this version and in the allow-list → else `not_allowed`.
9. Rate limits → `rate_limited` + `retryAfterS`.
10. `args.v` is 1 → else `unsupported_version`; `args` passes the command's strict validator → else `invalid_args`.
11. Allow entries the args need (`tokens.apply.admin` for a set with an `admin` entry) → else `not_allowed`.
12. Another command is running → `busy`.

Then `result {phase: received}` (within 2 s), the handler, the journal write, `result {phase: done}`.

**`hello.capabilities`:** a P2 proxy sends `["status", "commands"]`. cams-admin never sends a command to a proxy without `commands`.

**Heartbeat `proxy` block, three optional fields** (optional in lenient **and** strict, so P1 heartbeats stay valid):

```json
"commands": { "enabled": true, "paused": false, "pauseReason": null, "allow": ["tokens.apply"], "seenWindow": 1000 },
"tokens": { "revision": 7, "client": 1, "admin": 1, "blocked": [] },
"configRevision": "sha256:<64 hex>"
```

`commands.enabled` is false when the env switch is off; `allow` lists the allow entries this version implements **and** that are allowed (≤ 32 entries of ≤ 64 chars), whether paused or not; `pauseReason` ≤ 200 or null; `tokens` counts the managed tokens accepted now, `blocked` the locally blocked ids (≤ 64).

**Allow-list entries** (`camsAdmin.allowCommands`): `tokens.apply`, `tokens.apply.admin`, `config.get`, `config.set`, `config.unset`, `config.rollback`, `camera.name.set`, `proxy.restart`, and `camera.action:<a>` for `a` in `camera-test`, `onvif-resubscribe`, `camera-ftp-test`, `poe-switch-read`, `inventory`, `inventory-cancel`, `retention-run`, `restart`, `camera-reboot`, `camera-powercycle`, `camera-ftp-setup`, `camera-ftp-off`, `camera-ntp-set`, `camera-cert-push`. Anything else is a load error. P2 implements `tokens.apply` (and the `tokens.apply.admin` entry).

**`tokens.apply` args v1:**

```json
{ "v": 1, "revision": 8,
  "tokens": [ { "id": "tok_…", "kind": "client", "hash": "sha256:<64 lower hex>", "label": "cams cluster", "retireAt": null } ] }
```

`revision` integer ≥ 1; `tokens` ≤ 64 entries; `id` `^tok_[0-9A-HJKMNP-TV-Z]{20}$`, unique; `kind` `client` | `admin`; `hash` `^sha256:[0-9a-f]{64}$`, unique; `label` 1–64 characters without control characters; `retireAt` integer ms or null. Declarative: the full managed set. **Result:** `{revision, applied, stale, client, admin, blocked}` (the proxy's revision after the command; whether it applied; whether it was stale; the counts accepted now; the ids it dropped as locally blocked). `failed` codes: `shadows_local_token` (a hash equals the digest of the local admin, a local client, or the audit token), `store_error`.

**Tokens:** 32 random bytes, base64url without padding (43 characters). `hash = "sha256:" + hex(SHA-256(UTF-8(token)))`. The proxy hashes the presented bearer and compares to every managed hash with `timingSafeEqual`.

**Fixtures** (`contract/v1/fixtures/`, made by `make.ts`; `$context` = `{now, proxyId, connId, serverKeys, allow, paused, seen}`):

| fixture | strict | runtime (receiver) |
|---|---|---|
| `valid-command-tokens-apply`, `valid-result-received`, `valid-result-done-ok`, `valid-result-refused-paused`, `valid-event-command-done`, `valid-heartbeat-p2` | valid | accepted |
| `refused-command-bad-signature` (signed by the `other` key) | valid | `bad_signature` (proxy) |
| `refused-command-wrong-proxy`, `refused-command-wrong-conn` | valid | `wrong_target` (proxy) |
| `refused-command-replayed` (`$context.seen` holds its id) | valid | `replayed` (proxy) |
| `refused-command-expired` (`exp + 120000 < now`), `refused-command-exp-too-far` (`exp − ts = 60001`) | valid | `expired` (proxy) |
| `refused-command-paused` (`$context.paused: true`) | valid | `paused` (proxy) |
| `refused-command-not-allowed` (`config.get`, allow `["tokens.apply"]`) | valid | `not_allowed` (proxy) |
| `refused-command-args-v2` | valid | `unsupported_version` (proxy) |
| `refused-tokens-apply-bad-hash` (upper-case hex) | valid* | `invalid_args` (proxy) |
| `refused-tokens-apply-admin-not-allowed` (an `admin` entry, allow `["tokens.apply"]`) | valid | `not_allowed` (proxy) |
| `invalid-command-unsigned` | invalid | `bad_signature` (proxy) |
| `invalid-command-unknown-name` (`frobnicate`, signed) | invalid | `not_allowed` (proxy) |
| `invalid-type-command` (changed: schema `command`, body `{}`) | invalid | `unsupported_type` (server: a proxy sent a command) |
| `drift-result-new-field` | invalid | accepted (server) |

\* the `command` schema checks only that `args` is an object; the args are checked by `commands/tokens.apply.args.schema.json` (strict refuses the fixture's args).

`vectors.json` gains `jcs` (input → canonical text, including key order by UTF-16 units, `-0`, `1e21`, escapes, nested arrays) and `envelopes` (`{kind, key, envelope, text, sig}` for one command, one result, one event). Ed25519 is deterministic: each side reproduces the other's signatures byte for byte.

---

## File map

| file | responsibility |
|---|---|
| `src/fleet/jcs.ts` (new) | `jcs()` as in the contract |
| `src/fleet/protocol.ts` | + `signEnvelope`, `verifyEnvelope`, `unsigned` |
| `src/fleet/private-file.ts` (new) | `readPrivateJson`, `writePrivateJson` (the key file's mode/owner/atomic rules, shared) |
| `src/fleet/keyfile.ts` | uses `private-file.ts` (no behaviour change) |
| `src/fleet/policy.ts` (new) | the closed lists: `ALLOW_ENTRIES`, `IMPLEMENTED`, `NEVER_REMOTE_ACTIONS`, `DENIED_PATH_PREFIXES`, `isDeniedPath`, `validateAllowList`; `CommandPolicy` (effective policy from config.json + policy.json + env) |
| `src/fleet/token-store.ts` (new) | managed token hashes: load, `apply`, `match`, `block`/`unblock`, counts |
| `src/fleet/command-args.ts` (new) | hand-written strict validators per command (`tokens.apply` v1) |
| `src/fleet/journal.ts` (new) | `data/admin/commands.json`: lookup, record, prune, recent |
| `src/fleet/command-check.ts` (new) | the pure check (contract steps 1–11) and `CommandLimits` |
| `src/fleet/commands.ts` (new) | `CommandRunner`: check → received → handler → journal → done; undelivered `done` as events; audit |
| `src/fleet/client.ts` | connId/offset kept, `command` routed to the runner, capabilities, `sendSigned` |
| `src/fleet/heartbeat.ts` | `commands`, `tokens`, `configRevision` in the proxy block |
| `src/fleet/service.ts` | passes runner deps to the client |
| `src/config/env.ts` | `adminCommands` in the env layer (R2-5) |
| `src/config/load.ts` | `takeCommandPolicy` replaces `takeAllowCommands`; `configRevision` |
| `src/config/schema.ts` | `CONFIG_SCHEMA = 2`; comment update |
| `src/config/secrets.ts` | `CAMPROXY_TOKENS` optional when told so (Task 10) |
| `src/api/auth.ts` | access order with managed tokens; `origin` and `tokenLabel` in `AccessInfo`; `requireLocalAdmin` |
| `src/api/session.ts`, `src/api/login-links.ts`, `src/api/control-api.ts` | session origin; links carry the minting origin; `actorOf` for audit `user` |
| `src/api/cams-admin-api.ts` | `/control/admin/commands*`, `/control/admin/tokens*` |
| `src/fleet/cli.ts`, `src/cli.ts` | `admin-commands`, `admin-tokens` |
| `src/audit/actions.ts` | `admin-command`, `admin-policy`, `admin-token` |
| `web/src/lib/cams-admin.ts`, `web/src/components/CamsAdminCard.svelte` | allowed commands, pause, recent commands, managed tokens |
| `src/proxy.ts` | wiring |
| tests | listed per task |

---

### Task 1: Vendor the P2 contract; JCS and envelope signatures

**Files:**
- Create: `src/fleet/jcs.ts`, `test/fleet-jcs.test.ts`
- Modify: `src/fleet/protocol.ts`, `test/helpers/contract.ts`, `test/fleet-contract.test.ts`, `test/contract/cams-admin-v1/**` (copied from cams-admin `main` after its contract PR, Task 2 of the cams-admin plan, is merged), `test/contract/cams-admin-v1/SOURCE`

**Interfaces:**
- Consumes: cams-admin `contract/v1` (P2).
- Produces: `jcs(value: unknown): string`; `unsigned(m: Envelope): Omit<Envelope, 'sig'>`; `signEnvelope(privateKeyB64: string, m: Omit<Envelope, 'sig'>): string`; `verifyEnvelope(publicKeysB64: string[], m: Envelope): boolean`; test helper `Fixture` gains `$context?: FixtureContext` and `$expect.receiver?: 'proxy' | 'server'`; `Vectors` gains `jcs: {input: unknown; text: string}[]` and `envelopes: {kind: 'command' | 'result' | 'event'; key: 'proxy' | 'server' | 'other'; envelope: Record<string, unknown>; text: string; sig: string}[]`.

- [ ] **Step 1: Vendor.** Copy cams-admin `main`'s `contract/v1/` over `test/contract/cams-admin-v1/` (keep the folder name), write `SOURCE` as `klaushofrichter/cams-admin <full sha> (contract/v1, main)`. Run `scripts/contract-drift.sh`; expected: `contract/v1 matches cams-admin origin/main`.

- [ ] **Step 2: Failing tests.** `test/fleet-jcs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { jcs } from '../src/fleet/jcs';
import { signEnvelope, unsigned, verifyEnvelope } from '../src/fleet/protocol';
import { vectors } from './helpers/contract';

describe('JCS (RFC 8785)', () => {
  it('reproduces every contract vector', () => {
    for (const v of vectors.jcs) expect(jcs(v.input)).toBe(v.text);
  });
  it('sorts keys by UTF-16 code units, not by code point (RFC 8785 §3.2.3)', () => {
    const input = { '€': 'Euro', '\r': 'CR', 'דּ': 'Hebrew', '1': 'One', '😀': 'Smiley', '\u0080': 'Control', 'ö': 'Latin' };
    expect(Object.keys(JSON.parse(jcs(input)))).toEqual(['\r', '1', '\u0080', 'ö', '€', '😀', 'דּ']);
  });
  it('writes numbers as ES does: -0 → 0, 1e21, 0.1', () => {
    expect(jcs([-0, 1e21, 0.1, 100])).toBe('[0,1e+21,0.1,100]');
  });
  it('refuses what JSON cannot say', () => {
    for (const bad of [undefined, NaN, Infinity, () => 1, new Date(0), { a: undefined }, [1, , 2]]) expect(() => jcs(bad), String(bad)).toThrow();
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(() => jcs(deep)).toThrow(/too deep/);
  });
});

describe('signed envelopes', () => {
  it('every envelope vector: canonical text and signature, byte for byte', () => {
    for (const e of vectors.envelopes) {
      expect(jcs(e.envelope)).toBe(e.text);
      const key = vectors.keys[e.key];
      expect(signEnvelope(key.privateKey, e.envelope as never)).toBe(e.sig);
      expect(verifyEnvelope([key.publicKey], { ...(e.envelope as never), sig: e.sig })).toBe(true);
      expect(verifyEnvelope([vectors.keys.other.publicKey], { ...(e.envelope as never), sig: e.sig })).toBe(false);
    }
  });
  it('an added unknown field breaks the signature (it is covered)', () => {
    const e = vectors.envelopes.find((x) => x.kind === 'command')!;
    const m = { ...(e.envelope as Record<string, unknown>), sig: e.sig, extra: 1 };
    expect(verifyEnvelope([vectors.keys.server.publicKey], m as never)).toBe(false);
    expect(unsigned({ ...(e.envelope as never), sig: e.sig })).toEqual(e.envelope);
  });
  it('a message JCS cannot canonicalise never verifies (no throw)', () => {
    expect(verifyEnvelope([vectors.keys.server.publicKey], { v: 1, type: 'command', id: 'x', seq: 1, ts: 1, body: { n: Infinity }, sig: 'A'.repeat(86) + '==' } as never)).toBe(false);
  });
});
```

(`Object.keys` of a parsed object keeps insertion order for non-integer keys; `'1'` is an integer key and would move first anyway, which is also its JCS place. The same case is in `vectors.jcs` as `rfc8785-sorting`, checked byte for byte by the first test.)

In `test/fleet-contract.test.ts`, change the fixture-class test so `refused-*` fixtures must be **strict-valid** (they are refused only at run time):

```ts
  it('the vendored fixtures agree with the strict schemas (the copy is whole)', () => {
    for (const { name, f } of fixtures()) {
      const v = strict(f.schema);
      const ok = v(f.message);
      if (name.startsWith('valid-') || name.startsWith('refused-')) expect(ok, `${name}: ${why(v)}`).toBe(true);
      else expect(ok, name).toBe(false);
    }
  });
```

- [ ] **Step 2b: Run.** `npx vitest run test/fleet-jcs.test.ts test/fleet-contract.test.ts`. Expected: FAIL (`src/fleet/jcs` missing).

- [ ] **Step 3: Implement.** `src/fleet/jcs.ts` = the contract's `jcs` verbatim. In `src/fleet/protocol.ts`:

```ts
import { jcs } from './jcs';

export const unsigned = (m: Envelope): Omit<Envelope, 'sig'> => {
  const { sig: _sig, ...rest } = m;
  return rest;
};
// The envelope's signature (contract: Ed25519 over jcs(envelope without sig)).
export const signEnvelope = (privateKeyB64: string, m: Omit<Envelope, 'sig'>): string => sign(privateKeyB64, jcs(m));
// False for anything that is not a valid signature by one of the keys over
// this exact message (unknown fields included); never throws.
export function verifyEnvelope(publicKeysB64: string[], m: Envelope): boolean {
  let text: string;
  try {
    text = jcs(unsigned(m));
  } catch {
    return false;
  }
  return publicKeysB64.some((k) => verify(k, text, m.sig));
}
```

Extend `test/helpers/contract.ts` types (`Vectors.jcs` with `name`, `Vectors.envelopes`, `Fixture.$context`, `$expect.receiver`).

- [ ] **Step 4: Run** the two files, then `npm test -- fleet`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/fleet/jcs.ts src/fleet/protocol.ts test/fleet-jcs.test.ts test/fleet-contract.test.ts test/helpers/contract.ts test/contract/cams-admin-v1
git commit -m "feat(fleet): vendor the P2 contract; JCS and signed envelopes"
```

---

### Task 2: Private files, the command policy and the kill switch

**Files:**
- Create: `src/fleet/private-file.ts`, `src/fleet/policy.ts`, `test/fleet-policy.test.ts`
- Modify: `src/fleet/keyfile.ts`, `src/config/env.ts`, `src/config/load.ts`, `src/config/schema.ts`, `config.schema.json` (`npm run schema`), `test/fleet-config.test.ts`, `test/fleet-keyfile.test.ts`

**Interfaces:**
- Produces:
  - `readPrivateJson(path: string, o?: {stat?; uid?}): unknown` (throws `PrivateFileUnsafe`, `PrivateFileInvalid`, or the fs error); `writePrivateJson(path: string, value: unknown): void`.
  - `ALLOW_ENTRIES: readonly string[]` (the contract's list), `IMPLEMENTED: ReadonlySet<string>` = `{'tokens.apply', 'tokens.apply.admin'}`, `NEVER_REMOTE_ACTIONS` (M §8.6 list), `DENIED_PATH_PREFIXES` (M §8.2 right column), `isDeniedPath(path: string): boolean`, `validateAllowList(list: unknown, where: string): string[]` (throws `ConfigError`).
  - `interface PolicyFile { v: 1; allow?: string[]; paused?: boolean; pauseReason?: string | null; changedAt: number; changedBy: 'local' | 'managed' }`.
  - `class CommandPolicy { constructor(d: { base: () => { allow: string[]; paused: boolean }; file: string; env: () => EnvLayer; log }); effective(): { enabled: boolean; paused: boolean; pauseReason: string | null; allow: string[]; envName: string | null }; setAllow(list: string[], by: 'local' | 'managed'): void; pause(reason: string | null, by): void; resume(by: 'local'): void }` — `setAllow` with `by: 'managed'` throws `WideningRefused` when it adds an entry (R2-3).
  - `EnvLayer.adminCommands?: { value: 'on' | 'off'; name: string; raw: string }`.
  - `Loaded.commandPolicyBase: { allow: string[]; paused: boolean }` (from config.json).

- [ ] **Step 1: Failing tests** (`test/fleet-policy.test.ts`):

```ts
import { mkdtempSync, statSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ALLOW_ENTRIES, CommandPolicy, DENIED_PATH_PREFIXES, isDeniedPath, NEVER_REMOTE_ACTIONS, validateAllowList, WideningRefused } from '../src/fleet/policy';
import { readEnvLayer } from '../src/config/env';
import { settingPaths } from '../src/config/load';
import { DEFAULTS } from '../src/config/defaults';

const dir = () => mkdtempSync(join(tmpdir(), 'policy-'));
const quiet = { info() {}, warn() {}, debug() {} };
const make = (d: string, base = { allow: [] as string[], paused: false }, env: NodeJS.ProcessEnv = {}) =>
  new CommandPolicy({ base: () => base, file: join(d, 'admin', 'policy.json'), env: () => readEnvLayer(env), log: quiet });

describe('the closed lists', () => {
  it('allow entries: known names only; never-remote actions and unknown names are refused', () => {
    expect(validateAllowList(['tokens.apply', 'camera.action:camera-reboot'], 'x')).toEqual(['tokens.apply', 'camera.action:camera-reboot']);
    for (const bad of [['frobnicate'], ['camera.action:find-camera'], ['camera.action:camera-trust-clear'], 'tokens.apply', [1], Array(33).fill('tokens.apply')]) expect(() => validateAllowList(bad, 'x'), JSON.stringify(bad)).toThrow();
    for (const a of NEVER_REMOTE_ACTIONS) expect(ALLOW_ENTRIES).not.toContain(`camera.action:${a}`);
  });
  it('the deny list covers camsAdmin.*, every address, port, file path and trust setting (M5)', () => {
    for (const p of ['camsAdmin.url', 'camsAdmin.keyFile', 'server.port', 'tls.site', 'go2rtc.url', 'ftp.port', 'ftp.certFile', 'ntp.server', 'poeSwitch.host', 'composition.font', 'cameras.cam1.host', 'cameras.cam1.user', 'cameras.cam1.tlsName', 'cameras.cam1.poeSwitch.port']) expect(isDeniedPath(p), p).toBe(true);
    for (const p of ['stills.intervalS', 'retention.days', 'cameras.cam1.name']) expect(isDeniedPath(p), p).toBe(false);
    // Every real setting under a denied prefix is denied (no prefix typo hides one).
    for (const p of settingPaths(DEFAULTS)) if (DENIED_PATH_PREFIXES.some((x) => p === x || p.startsWith(`${x}.`))) expect(isDeniedPath(p), p).toBe(true);
  });
});

describe('CommandPolicy', () => {
  it('defaults: enabled, not paused, nothing allowed; no file written by reading', () => {
    const d = dir();
    expect(make(d).effective()).toEqual({ enabled: true, paused: false, pauseReason: null, allow: [], envName: null });
    expect(() => statSync(join(d, 'admin'))).toThrow();
  });
  it('policy.json wins over config.json for allow; paused if either says so', () => {
    const d = dir();
    const p = make(d, { allow: ['tokens.apply'], paused: true });
    expect(p.effective()).toMatchObject({ allow: ['tokens.apply'], paused: true });
    p.setAllow(['tokens.apply', 'tokens.apply.admin'], 'local');
    expect(p.effective().allow).toEqual(['tokens.apply', 'tokens.apply.admin']);
    expect(statSync(join(d, 'admin', 'policy.json')).mode & 0o777).toBe(0o600);
  });
  it('managed rights only narrow (R2-3)', () => {
    const p = make(dir());
    p.setAllow(['tokens.apply', 'tokens.apply.admin'], 'local');
    expect(() => p.setAllow(['tokens.apply', 'tokens.apply.admin', 'config.get'], 'managed')).toThrow(WideningRefused);
    p.setAllow(['tokens.apply'], 'managed');
    p.pause('incident', 'managed');
    expect(p.effective()).toMatchObject({ paused: true, pauseReason: 'incident', allow: ['tokens.apply'] });
    expect(() => p.resume('managed' as 'local')).toThrow(WideningRefused);
  });
  it('the env kill switch fails closed and beats every file (R2-5)', () => {
    for (const [env, enabled] of [[{}, true], [{ CAMPROXY_ADMIN_COMMANDS: 'on' }, true], [{ CAMPROXY_ADMIN_COMMANDS: 'off' }, false], [{ CAMPROXY_ADMIN_COMMANDS: 'OFF ' }, false], [{ CAMPROXY_ADMIN_COMMANDS: 'yes' }, false]] as const) {
      expect(make(dir(), { allow: ['tokens.apply'], paused: false }, env as NodeJS.ProcessEnv).effective().enabled, JSON.stringify(env)).toBe(enabled);
    }
    const d = dir();
    const envFile = join(d, '.env');
    writeFileSync(envFile, 'CAMPROXY_ADMIN_COMMANDS=off\n', { mode: 0o600 });
    expect(make(d, { allow: [], paused: false }, { CAMPROXY_ENV_FILE: envFile, CAMPROXY_ADMIN_COMMANDS: 'on' }).effective().enabled).toBe(false);
  });
  it('a policy.json readable by others is not used: paused, with the reason', () => {
    const d = dir();
    const p = make(d);
    p.setAllow(['tokens.apply'], 'local');
    chmodSync(join(d, 'admin', 'policy.json'), 0o644);
    expect(p.effective()).toMatchObject({ paused: true, allow: [], pauseReason: expect.stringMatching(/policy\.json.*others/) });
  });
});
```

Add to `test/fleet-config.test.ts`: `config.json` with `camsAdmin.allowCommands: ['tokens.apply']` loads (it was a load error in P1); `['camera.action:find-camera']` is a load error naming the entry; `camsAdmin.commandsPaused: true` loads; `PUT /control/config {camsAdmin:{allowCommands:['tokens.apply']}}` answers 400 `not_a_setting` and leaves `overrides.json` unchanged; `overrides.json` containing `camsAdmin.allowCommands` is a load error (`camsAdmin.allowCommands: only in config.json or data/admin/policy.json`).

- [ ] **Step 2: Run.** `npx vitest run test/fleet-policy.test.ts test/fleet-config.test.ts` → FAIL.

- [ ] **Step 3: Implement.**

`src/fleet/private-file.ts`: move `writeKeyFile`'s body (folder 700, random temp, fsync, rename, cleanup) into `writePrivateJson(path, value)` (JSON + `\n`), and the mode/uid checks of `readKeyFile` into `readPrivateJson`; `keyfile.ts` calls them (its own `check()` stays). `PrivateFileUnsafe`/`PrivateFileInvalid` are the parents of `KeyFileUnsafe`/`KeyFileInvalid` (`class KeyFileUnsafe extends PrivateFileUnsafe {}`), so the existing key-file tests keep passing unchanged.

`src/fleet/policy.ts`:

```ts
import { ConfigError } from '../config/load-error';
import type { EnvLayer } from '../config/env';
import { PrivateFileInvalid, PrivateFileUnsafe, readPrivateJson, writePrivateJson } from './private-file';

// M §8.6: camera actions cams-admin may ask for (each its own allow entry),
// and the ones it never may: they change trust, delete data, or need
// someone at the hardware. Compiled in: no setting widens them.
export const REMOTE_ACTIONS = ['camera-test', 'onvif-resubscribe', 'camera-ftp-test', 'poe-switch-read', 'inventory', 'inventory-cancel', 'retention-run', 'restart', 'camera-reboot', 'camera-powercycle', 'camera-ftp-setup', 'camera-ftp-off', 'camera-ntp-set', 'camera-cert-push'] as const;
export const NEVER_REMOTE_ACTIONS = ['find-camera', 'camera-address', 'camera-trust-clear', 'tls-ca-rotate', 'tls-ca-drop-previous', 'archive-clear', 'inventory-repair', 'camera-poe-on'] as const;
export const ALLOW_ENTRIES: readonly string[] = ['tokens.apply', 'tokens.apply.admin', 'config.get', 'config.set', 'config.unset', 'config.rollback', 'camera.name.set', 'proxy.restart', ...REMOTE_ACTIONS.map((a) => `camera.action:${a}`)];
// What this version runs (P2). The heartbeat reports allow ∩ IMPLEMENTED.
export const IMPLEMENTED: ReadonlySet<string> = new Set(['tokens.apply', 'tokens.apply.admin']);
// M §8.2 right column (M5): never settable by cams-admin. P3's config.set
// checks every path against isDeniedPath before anything else; the per-camera
// entries apply under cameras.<id>.
export const DENIED_PATH_PREFIXES = ['camsAdmin', 'server', 'go2rtc', 'ftp.port', 'ftp.passive', 'ftp.tls', 'ftp.publicHost', 'ftp.certFile', 'ftp.keyFile', 'tls', 'composition.font', 'ntp.server', 'poeSwitch'] as const;
const DENIED_CAMERA_KEYS = ['host', 'protocol', 'tlsName', 'user', 'onvifPort', 'rtspPort', 'baichuanPort', 'poeSwitch', 'ftp.user', 'webUiUrl'] as const;
const under = (p: string, x: string) => p === x || p.startsWith(`${x}.`);

export function isDeniedPath(path: string): boolean {
  if (DENIED_PATH_PREFIXES.some((x) => under(path, x))) return true;
  const m = /^cameras\.[^.]+\.(.+)$/.exec(path);
  return !!m && DENIED_CAMERA_KEYS.some((k) => under(m[1], k));
}

export function validateAllowList(list: unknown, where: string): string[] {
  if (!Array.isArray(list) || list.length > 32) throw new ConfigError(`${where}: a list of at most 32 command names`);
  for (const e of list) if (typeof e !== 'string' || !ALLOW_ENTRIES.includes(e)) throw new ConfigError(`${where}: ${typeof e === 'string' ? e.slice(0, 64) : typeof e} is not a command cams-admin may be allowed`);
  return [...new Set(list as string[])];
}

export class WideningRefused extends Error {}

export interface PolicyFile { v: 1; allow?: string[]; paused?: boolean; pauseReason?: string | null; changedAt: number; changedBy: 'local' | 'managed' }
export interface EffectivePolicy { enabled: boolean; paused: boolean; pauseReason: string | null; allow: string[]; envName: string | null }

export class CommandPolicy {
  constructor(private readonly d: { base: () => { allow: string[]; paused: boolean }; file: string; env: () => EnvLayer; log: { warn(o: object, m: string): void } }) {}

  private read(): PolicyFile | { unusable: string } | null {
    try {
      const f = readPrivateJson(this.d.file) as PolicyFile;
      if (f?.v !== 1) return { unusable: `${this.d.file} is not version 1` };
      if (f.allow !== undefined) validateAllowList(f.allow, 'policy.json allow');
      return f;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (err instanceof PrivateFileUnsafe || err instanceof PrivateFileInvalid || err instanceof ConfigError) return { unusable: (err as Error).message };
      throw err;
    }
  }

  effective(): EffectivePolicy {
    const env = this.d.env().adminCommands;
    const enabled = !env || env.value === 'on';
    const f = this.read();
    // An unusable policy file pauses everything until someone fixes it (fail closed).
    if (f && 'unusable' in f) return { enabled, paused: true, pauseReason: f.unusable.slice(0, 200), allow: [], envName: enabled ? null : env!.name };
    const base = this.d.base();
    return {
      enabled,
      paused: base.paused || !!f?.paused,
      pauseReason: f?.paused ? (f.pauseReason ?? null) : base.paused ? 'config.json: camsAdmin.commandsPaused' : null,
      allow: f?.allow ?? base.allow,
      envName: enabled ? null : env!.name,
    };
  }

  private write(patch: Partial<PolicyFile>, by: 'local' | 'managed'): void {
    const cur = this.read();
    const prev = cur && !('unusable' in cur) ? cur : { v: 1 as const, changedAt: 0, changedBy: by };
    writePrivateJson(this.d.file, { ...prev, ...patch, v: 1, changedAt: Date.now(), changedBy: by });
  }

  setAllow(list: string[], by: 'local' | 'managed'): void {
    const next = validateAllowList(list, 'allowed commands');
    const now = this.effective().allow;
    if (by !== 'local' && next.some((e) => !now.includes(e))) throw new WideningRefused('adding an allowed command needs the local admin token');
    this.write({ allow: next }, by);
  }

  pause(reason: string | null, by: 'local' | 'managed'): void {
    this.write({ paused: true, pauseReason: reason ? reason.replace(/[\u0000-\u001f]/g, ' ').slice(0, 200) : null }, by);
  }

  resume(by: 'local'): void {
    if (by !== 'local') throw new WideningRefused('resuming commands needs the local admin token');
    this.write({ paused: false, pauseReason: null }, by);
  }
}
```

`src/config/env.ts`: add

```ts
export const ADMIN_COMMANDS_NAMES = ['CAMPROXY_ADMIN_COMMANDS'] as const;
// R2-5: unset or "on" = commands possible; anything else = off. The file's
// value and the process environment's are both read: either one not "on" wins.
```

and in `readEnvLayer`, read the value from the file text and from `env` separately (not `pick`, which stops at the first): `const vals = [fileValue, env.CAMPROXY_ADMIN_COMMANDS].filter((v) => v !== undefined && v !== '')`; when `vals.length`, set `layer.adminCommands = { value: vals.every((v) => v.trim().toLowerCase() === 'on') ? 'on' : 'off', name: 'CAMPROXY_ADMIN_COMMANDS', raw: vals.find((v) => v.trim().toLowerCase() !== 'on')?.slice(0, 16) ?? 'on' }`.

`src/config/load.ts`: replace `takeAllowCommands` by `takeCommandPolicy(o, where: 'config.json' | 'overrides.json'): { allow: string[]; paused: boolean }`: from `config.json` it validates and removes `camsAdmin.allowCommands` (via `validateAllowList`) and `camsAdmin.commandsPaused` (boolean, else `ConfigError`); from `overrides.json` either key is a `ConfigError` (`camsAdmin.allowCommands: only in config.json or data/admin/policy.json`). `applyOverrides`: a patch with either key throws `ConfigError('camsAdmin.allowCommands: not_a_setting …')`, mapped by the existing `invalid()` to 400; set the error text to start with `not_a_setting:` and make `invalid()` answer `{error: 'not_a_setting'}` for it. Store `commandPolicyBase` in `Loaded`. Add `export const configRevision = (l: Loaded): string => 'sha256:' + createHash('sha256').update(jcs(l.overrides)).digest('hex');`. `schema.ts`: `CONFIG_SCHEMA = 2`, update the `camsAdmin` comment; `npm run schema`.

- [ ] **Step 4: Run** `npx vitest run test/fleet-policy.test.ts test/fleet-config.test.ts test/fleet-keyfile.test.ts test/config-*.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/fleet/private-file.ts src/fleet/policy.ts src/fleet/keyfile.ts src/config/env.ts src/config/load.ts src/config/schema.ts config.schema.json test/fleet-policy.test.ts test/fleet-config.test.ts
git commit -m "feat(fleet): command policy (allow-list, pause, env kill switch) and the compiled deny list"
```

---

### Task 3: The managed token store

**Files:**
- Create: `src/fleet/token-store.ts`, `src/fleet/command-args.ts`, `test/fleet-token-store.test.ts`

**Interfaces:**
- Consumes: `readPrivateJson`/`writePrivateJson` (Task 2).
- Produces:
  - `interface ManagedToken { id: string; kind: 'client' | 'admin'; hash: string; label: string; retireAt: number | null }`
  - `interface TokensApplyArgs { v: 1; revision: number; tokens: ManagedToken[] }`
  - `validateTokensApply(args: unknown): { ok: true; args: TokensApplyArgs } | { ok: false; code: 'unsupported_version' | 'invalid_args'; detail: string }` (in `command-args.ts`; `ARGS_VALIDATORS: Record<string, (a: unknown) => …>`)
  - `class TokenStore { constructor(d: { file: string; now?: () => number; localDigests: () => Buffer[] }); revision(): number; apply(a: TokensApplyArgs): TokensApplyResult; match(bearer: string): { id: string; kind: 'client' | 'admin'; label: string } | null; block(id: string): void; unblock(id: string): void; list(): { id; kind; label; retireAt; blocked: boolean; hashPrefix: string }[]; counts(): { revision: number; client: number; admin: number; blocked: string[] } }`
  - `interface TokensApplyResult { revision: number; applied: boolean; stale: boolean; client: number; admin: number; blocked: string[] }`; `class ShadowsLocalToken extends Error`.

- [ ] **Step 1: Failing tests** (`test/fleet-token-store.test.ts`):

```ts
import { createHash, randomBytes } from 'crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ShadowsLocalToken, TokenStore } from '../src/fleet/token-store';
import { validateTokensApply } from '../src/fleet/command-args';

const tok = () => randomBytes(32).toString('base64url');
const hashOf = (t: string) => `sha256:${createHash('sha256').update(t).digest('hex')}`;
const id = (n: number) => `tok_${String(n).padStart(20, '0')}`;
const LOCAL_ADMIN = 'local-admin-token-'.padEnd(40, 'x');
const store = (now = () => 1_000) => {
  const d = mkdtempSync(join(tmpdir(), 'tokens-'));
  const file = join(d, 'admin', 'tokens.json');
  return { file, s: new TokenStore({ file, now, localDigests: () => [createHash('sha256').update(LOCAL_ADMIN).digest()] }) };
};

describe('tokens.apply args', () => {
  it('accepts the contract fixture shape; refuses every malformed entry', () => {
    const good = { v: 1, revision: 1, tokens: [{ id: id(1), kind: 'client', hash: hashOf(tok()), label: 'cams cluster', retireAt: null }] };
    expect(validateTokensApply(good).ok).toBe(true);
    expect(validateTokensApply({ ...good, v: 2 })).toMatchObject({ ok: false, code: 'unsupported_version' });
    const bad = [
      { ...good, revision: 0 }, { ...good, tokens: 'x' }, { ...good, extra: 1 },
      { ...good, tokens: [{ ...good.tokens[0], hash: good.tokens[0].hash.toUpperCase() }] },
      { ...good, tokens: [{ ...good.tokens[0], kind: 'audit' }] },
      { ...good, tokens: [{ ...good.tokens[0], label: '' }] }, { ...good, tokens: [{ ...good.tokens[0], label: 'a\nb' }] },
      { ...good, tokens: [good.tokens[0], { ...good.tokens[0], hash: hashOf(tok()) }] }, // duplicate id
      { ...good, tokens: [good.tokens[0], { ...good.tokens[0], id: id(2) }] }, // duplicate hash
      { ...good, tokens: Array.from({ length: 65 }, (_, i) => ({ ...good.tokens[0], id: id(i), hash: hashOf(tok()) })) },
    ];
    for (const b of bad) expect(validateTokensApply(b), JSON.stringify(b).slice(0, 120)).toMatchObject({ ok: false, code: 'invalid_args' });
  });
});

describe('TokenStore', () => {
  it('applies a newer revision, matches by hash, survives a restart; file 600', () => {
    const { s, file } = store();
    const t = tok();
    const r = s.apply({ v: 1, revision: 3, tokens: [{ id: id(1), kind: 'client', hash: hashOf(t), label: 'cams cluster', retireAt: null }] });
    expect(r).toEqual({ revision: 3, applied: true, stale: false, client: 1, admin: 0, blocked: [] });
    expect(s.match(t)).toEqual({ id: id(1), kind: 'client', label: 'cams cluster' });
    expect(s.match(tok())).toBeNull();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain(t);
    const again = new TokenStore({ file, now: () => 1_000, localDigests: () => [] });
    expect(again.match(t)?.id).toBe(id(1));
  });
  it('an older or equal revision is stale: nothing changes (a replay or a restored cams-admin)', () => {
    const { s } = store();
    const t = tok();
    s.apply({ v: 1, revision: 5, tokens: [] });
    expect(s.apply({ v: 1, revision: 5, tokens: [{ id: id(1), kind: 'client', hash: hashOf(t), label: 'x', retireAt: null }] })).toMatchObject({ revision: 5, applied: false, stale: true });
    expect(s.apply({ v: 1, revision: 4, tokens: [] })).toMatchObject({ stale: true });
    expect(s.match(t)).toBeNull();
  });
  it('a retiring token stops matching at retireAt', () => {
    let now = 1_000;
    const { s } = store(() => now);
    const t = tok();
    s.apply({ v: 1, revision: 1, tokens: [{ id: id(1), kind: 'client', hash: hashOf(t), label: 'x', retireAt: 2_000 }] });
    expect(s.match(t)).not.toBeNull();
    now = 2_000;
    expect(s.match(t)).toBeNull();
    expect(s.counts()).toMatchObject({ client: 0 });
  });
  it('refuses a set that shadows a local token; applies nothing', () => {
    const { s } = store();
    expect(() => s.apply({ v: 1, revision: 1, tokens: [{ id: id(1), kind: 'admin', hash: hashOf(LOCAL_ADMIN), label: 'x', retireAt: null }] })).toThrow(ShadowsLocalToken);
    expect(s.revision()).toBe(0);
  });
  it('a locally blocked id never comes back through tokens.apply (R2-6)', () => {
    const { s } = store();
    const t = tok();
    s.apply({ v: 1, revision: 1, tokens: [{ id: id(1), kind: 'admin', hash: hashOf(t), label: 'cams', retireAt: null }] });
    s.block(id(1));
    expect(s.match(t)).toBeNull();
    expect(s.apply({ v: 1, revision: 2, tokens: [{ id: id(1), kind: 'admin', hash: hashOf(t), label: 'cams', retireAt: null }] })).toMatchObject({ applied: true, admin: 0, blocked: [id(1)] });
    expect(s.match(t)).toBeNull();
    s.unblock(id(1));
    expect(s.match(t)).toBeNull(); // unblocking doesn't resurrect: the next tokens.apply decides
  });
  it('a corrupt or unsafe tokens.json: no managed token matches, the error is visible', () => {
    const { s, file } = store();
    s.apply({ v: 1, revision: 1, tokens: [] });
    writeFileSync(file, '{', { mode: 0o600 });
    const fresh = new TokenStore({ file, now: () => 1_000, localDigests: () => [] });
    expect(fresh.match(tok())).toBeNull();
    expect(fresh.problem()).toMatch(/tokens\.json/);
  });
  it('list() never shows a hash beyond 8 hex', () => {
    const { s } = store();
    const t = tok();
    s.apply({ v: 1, revision: 1, tokens: [{ id: id(1), kind: 'client', hash: hashOf(t), label: 'x', retireAt: null }] });
    expect(JSON.stringify(s.list())).not.toContain(hashOf(t).slice(7, 7 + 9));
    expect(s.list()[0].hashPrefix).toBe(hashOf(t).slice(0, 15));
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/fleet-token-store.test.ts` → FAIL.

- [ ] **Step 3: Implement** `src/fleet/command-args.ts`:

```ts
// Strict validators for command args (contract commands/<name>.args.schema.json,
// strict variant). Hand-written: no schema library at run time. A test runs
// them against the vendored strict schemas on the fixtures.
import type { ManagedToken, TokensApplyArgs } from './token-store';

export type ArgsVerdict<T> = { ok: true; args: T } | { ok: false; code: 'unsupported_version' | 'invalid_args'; detail: string };
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const only = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
const TOK_ID = /^tok_[0-9A-HJKMNP-TV-Z]{20}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const LABEL = /^[^\u0000-\u001f\u007f]{1,64}$/u;

export function validateTokensApply(a: unknown): ArgsVerdict<TokensApplyArgs> {
  if (!isObj(a)) return { ok: false, code: 'invalid_args', detail: 'args: not an object' };
  if (a.v !== 1) return Number.isInteger(a.v) ? { ok: false, code: 'unsupported_version', detail: `args.v ${String(a.v)}` } : { ok: false, code: 'invalid_args', detail: 'args.v' };
  if (!only(a, ['v', 'revision', 'tokens'])) return { ok: false, code: 'invalid_args', detail: 'args: unknown field' };
  if (!Number.isSafeInteger(a.revision) || (a.revision as number) < 1) return { ok: false, code: 'invalid_args', detail: 'revision' };
  if (!Array.isArray(a.tokens) || a.tokens.length > 64) return { ok: false, code: 'invalid_args', detail: 'tokens' };
  const ids = new Set<string>();
  const hashes = new Set<string>();
  const out: ManagedToken[] = [];
  for (const [i, t] of a.tokens.entries()) {
    const bad = (f: string): ArgsVerdict<TokensApplyArgs> => ({ ok: false, code: 'invalid_args', detail: `tokens[${i}].${f}` });
    if (!isObj(t) || !only(t, ['id', 'kind', 'hash', 'label', 'retireAt'])) return bad('*');
    if (typeof t.id !== 'string' || !TOK_ID.test(t.id) || ids.has(t.id)) return bad('id');
    if (t.kind !== 'client' && t.kind !== 'admin') return bad('kind');
    if (typeof t.hash !== 'string' || !HASH.test(t.hash) || hashes.has(t.hash)) return bad('hash');
    if (typeof t.label !== 'string' || !LABEL.test(t.label)) return bad('label');
    if (t.retireAt !== null && !(Number.isSafeInteger(t.retireAt) && (t.retireAt as number) >= 0)) return bad('retireAt');
    ids.add(t.id);
    hashes.add(t.hash);
    out.push({ id: t.id, kind: t.kind, hash: t.hash, label: t.label, retireAt: t.retireAt as number | null });
  }
  return { ok: true, args: { v: 1, revision: a.revision as number, tokens: out } };
}

export const ARGS_VALIDATORS: Record<string, (a: unknown) => ArgsVerdict<unknown>> = { 'tokens.apply': validateTokensApply };
```

`src/fleet/token-store.ts`:

```ts
import { createHash, timingSafeEqual } from 'crypto';
import { PrivateFileInvalid, PrivateFileUnsafe, readPrivateJson, writePrivateJson } from './private-file';

// The managed token hashes (M §10.2): data/admin/tokens.json, mode 600,
// atomic. Written by tokens.apply and the local block list only; read
// whenever the file exists (R2-7). Never holds a token, never logs a hash.
export interface ManagedToken { id: string; kind: 'client' | 'admin'; hash: string; label: string; retireAt: number | null }
export interface TokensApplyArgs { v: 1; revision: number; tokens: ManagedToken[] }
export interface TokensApplyResult { revision: number; applied: boolean; stale: boolean; client: number; admin: number; blocked: string[] }
interface FileShape { v: 1; revision: number; tokens: ManagedToken[]; blocked: string[] }
export class ShadowsLocalToken extends Error {}

const EMPTY: FileShape = { v: 1, revision: 0, tokens: [], blocked: [] };

export class TokenStore {
  private state: FileShape = EMPTY;
  private digests: { t: ManagedToken; d: Buffer }[] = [];
  private err: string | null = null;
  private readonly now: () => number;

  constructor(private readonly d: { file: string; now?: () => number; localDigests: () => Buffer[] }) {
    this.now = d.now ?? Date.now;
    this.load();
  }

  private load(): void {
    try {
      const f = readPrivateJson(this.d.file) as FileShape;
      if (f?.v !== 1 || !Number.isSafeInteger(f.revision) || !Array.isArray(f.tokens) || !Array.isArray(f.blocked)) throw new PrivateFileInvalid(`${this.d.file} is not version 1`);
      this.set(f);
      this.err = null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return this.set(EMPTY);
      // Unusable: no managed token matches (fail closed); local tokens are unaffected.
      this.set(EMPTY);
      this.err = e instanceof PrivateFileUnsafe || e instanceof PrivateFileInvalid ? e.message : `${this.d.file}: unreadable`;
    }
  }

  private set(f: FileShape): void {
    this.state = f;
    this.digests = f.tokens.filter((t) => !f.blocked.includes(t.id)).map((t) => ({ t, d: Buffer.from(t.hash.slice(7), 'hex') }));
  }

  problem(): string | null { return this.err; }
  revision(): number { return this.state.revision; }

  private live(t: ManagedToken): boolean { return t.retireAt === null || this.now() < t.retireAt; }

  // Constant time over every entry: the loop never stops early.
  match(bearer: string): { id: string; kind: 'client' | 'admin'; label: string } | null {
    const g = createHash('sha256').update(bearer).digest();
    let hit: ManagedToken | null = null;
    for (const { t, d } of this.digests) if (timingSafeEqual(g, d) && this.live(t)) hit = t;
    return hit ? { id: hit.id, kind: hit.kind, label: hit.label } : null;
  }

  counts(): { revision: number; client: number; admin: number; blocked: string[] } {
    const live = this.digests.map((x) => x.t).filter((t) => this.live(t));
    return { revision: this.state.revision, client: live.filter((t) => t.kind === 'client').length, admin: live.filter((t) => t.kind === 'admin').length, blocked: [...this.state.blocked] };
  }

  apply(a: TokensApplyArgs): TokensApplyResult {
    if (a.revision <= this.state.revision) return { revision: this.state.revision, applied: false, stale: true, ...this.countsOnly() };
    const local = this.d.localDigests();
    for (const t of a.tokens) {
      const d = Buffer.from(t.hash.slice(7), 'hex');
      if (local.some((l) => timingSafeEqual(l, d))) throw new ShadowsLocalToken(`token ${t.id} has the hash of a local token`);
    }
    const blocked = a.tokens.filter((t) => this.state.blocked.includes(t.id)).map((t) => t.id);
    const next: FileShape = { v: 1, revision: a.revision, tokens: a.tokens, blocked: this.state.blocked.filter((b) => a.tokens.some((t) => t.id === b) || this.state.tokens.some((t) => t.id === b)).slice(-64) };
    writePrivateJson(this.d.file, next);
    this.set(next);
    this.err = null;
    return { revision: a.revision, applied: true, stale: false, ...this.countsOnly(), blocked };
  }

  private countsOnly(): { client: number; admin: number } {
    const c = this.counts();
    return { client: c.client, admin: c.admin };
  }

  block(id: string): void {
    if (this.state.blocked.includes(id)) return;
    const next = { ...this.state, blocked: [...this.state.blocked, id].slice(-64) };
    writePrivateJson(this.d.file, next);
    this.set(next);
  }

  unblock(id: string): void {
    const next = { ...this.state, blocked: this.state.blocked.filter((b) => b !== id), tokens: this.state.tokens.filter((t) => t.id !== id) };
    writePrivateJson(this.d.file, next);
    this.set(next);
  }

  list(): { id: string; kind: 'client' | 'admin'; label: string; retireAt: number | null; blocked: boolean; live: boolean; hashPrefix: string }[] {
    return this.state.tokens.map((t) => ({ id: t.id, kind: t.kind, label: t.label, retireAt: t.retireAt, blocked: this.state.blocked.includes(t.id), live: this.live(t), hashPrefix: t.hash.slice(0, 15) }));
  }
}
```

(`unblock` drops the entry too, so the test's "unblocking doesn't resurrect" holds: the next `tokens.apply` with a higher revision brings it back if cams-admin still lists it.)

- [ ] **Step 4: Run** → PASS. Add a contract test in `test/fleet-token-store.test.ts` that every `tokens.apply` args object in the vendored fixtures gets the same verdict from `validateTokensApply` as from the strict `commands/tokens.apply.args` schema (`strict('commands/tokens.apply.args')`). Run again → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/fleet/token-store.ts src/fleet/command-args.ts test/fleet-token-store.test.ts
git commit -m "feat(fleet): managed token store (hashes only, revisions, local block list)"
```

---

### Task 4: Auth with managed tokens; local-only widening (R2-3)

**Files:**
- Modify: `src/api/auth.ts`, `src/api/session.ts`, `src/api/login-links.ts`, `src/api/control-api.ts` (session routes, `login-links`, `who`/`actorOf`), `src/proxy.ts` (AccessDeps: `managed`), `src/api/cams-admin-api.ts`
- Test: `test/auth-managed.test.ts`, existing `test/auth*.test.ts`, `test/login-link*.test.ts`

**Interfaces:**
- Consumes: `TokenStore.match` (Task 3).
- Produces:
  - `AccessInfo` gains `origin: 'local' | 'managed' | null` and `tokenId?: string`, `tokenLabel?: string`; `TokenKind` gains `'managed-client' | 'managed-admin'`.
  - `AccessDeps.managed?: (bearer: string) => { id: string; kind: 'client' | 'admin'; label: string } | null`.
  - `requireLocalAdmin(): RequestHandler` (403 `local_admin_only` unless `res.locals.access.origin === 'local'`).
  - `actorOf(a: AccessInfo): string` → `'admin'` (local), `` `token:${label}` `` (managed admin), `'cams-admin'` is set by the runner, not here.
  - Sessions: `createSessionSigner(...).issue(origin: 'local' | 'managed'): string`; `verify(v): { origin: 'local' | 'managed' } | null` (was boolean; update every caller: `sessionValid` returns the origin or null).
  - Login links: `issue(origin)`, `consume(code): 'local' | 'managed' | null`.

- [ ] **Step 1: Failing tests** (`test/auth-managed.test.ts`), with `startProxy` from `test/helpers/proxy.ts` and a token store seeded through the control route added in Task 7 — for this task seed it directly: write `data/admin/tokens.json` with `writePrivateJson` before `startProxy`:

```ts
it('access order: local admin, managed admin, local client, managed client, audit', async () => {
  // managed client token reads the client API; managed admin reaches /control
  expect((await auth(request(p.app).get('/api/cameras'), MANAGED_CLIENT)).status).toBe(200);
  expect((await auth(request(p.app).get('/control/status'), MANAGED_CLIENT)).status).toBe(403);
  expect((await auth(request(p.app).get('/control/status'), MANAGED_ADMIN)).status).toBe(200);
  expect((await auth(request(p.app).get('/api/cameras'), p.clientToken)).status).toBe(200); // CAMPROXY_TOKENS unchanged
});
it('a managed admin token can narrow but not widen (R2-3)', async () => {
  await auth(request(p.app).put('/control/admin/commands').send({ allow: ['tokens.apply'] }), p.adminToken).expect(200);
  await auth(request(p.app).put('/control/admin/commands').send({ allow: ['tokens.apply', 'tokens.apply.admin'] }), MANAGED_ADMIN).expect(403, { error: 'local_admin_only' });
  await auth(request(p.app).post('/control/admin/commands/pause').send({ reason: 'test' }), MANAGED_ADMIN).expect(200);
  await auth(request(p.app).post('/control/admin/commands/resume'), MANAGED_ADMIN).expect(403);
  await auth(request(p.app).post('/control/admin/commands/resume'), p.adminToken).expect(200);
});
it('a UI session from a login link minted with a managed admin token is managed too', async () => {
  const link = (await auth(request(p.app).post('/control/login-links'), MANAGED_ADMIN).expect(201)).body.code;
  const res = await request(p.app).get(`/control/login-link?code=${link}`).expect(302);
  const cookie = res.headers['set-cookie'][0].split(';')[0];
  await request(p.app).put('/control/admin/commands').set('Cookie', cookie).set('x-camproxy-ui', '1').send({ allow: ['tokens.apply', 'config.get'] }).expect(403);
  const local = (await auth(request(p.app).post('/control/login-links'), p.adminToken).expect(201)).body.code;
  const res2 = await request(p.app).get(`/control/login-link?code=${local}`).expect(302);
  await request(p.app).put('/control/admin/commands').set('Cookie', res2.headers['set-cookie'][0].split(';')[0]).set('x-camproxy-ui', '1').send({ allow: ['tokens.apply', 'config.get'] }).expect(200);
});
it('audit names the managed token by label, never the hash', async () => {
  await auth(request(p.app).post('/control/login-links'), MANAGED_ADMIN).expect(201);
  const rec = (await auth(request(p.app).get('/control/audit?action=login-link-issued'), p.adminToken)).body.items[0];
  expect(rec.user ?? rec.cam_proxy?.user).toBe('token:cams cluster');
  expect(JSON.stringify(rec)).not.toMatch(/[0-9a-f]{16}/);
});
it('a retired managed token is refused like an unknown one (401 wrong-token)', async () => { /* store with retireAt in the past */ });
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** `accessOf`:

```ts
function accessOf(req: Request, d: AccessDeps): AccessInfo {
  const t = bearerOf(req);
  if (t !== undefined) {
    if (tokenMatches(t, [d.adminToken()])) return { access: 'admin', viaCookie: false, tokenKind: 'admin', origin: 'local' };
    const m = d.managed?.(t) ?? null;
    if (m?.kind === 'admin') return { access: 'admin', viaCookie: false, tokenKind: 'managed-admin', origin: 'managed', tokenId: m.id, tokenLabel: m.label };
    if (tokenMatches(t, d.tokens())) return { access: 'client', viaCookie: false, tokenKind: 'client', origin: 'local' };
    if (m?.kind === 'client') return { access: 'client', viaCookie: false, tokenKind: 'managed-client', origin: 'managed', tokenId: m.id, tokenLabel: m.label };
    const a = d.auditToken();
    if (a && tokenMatches(t, [a])) return { access: 'audit', viaCookie: false, tokenKind: 'audit', origin: 'local' };
    return { access: null, viaCookie: false, tokenKind: 'invalid', origin: null };
  }
  const s = d.sessionValid(readCookie(req.get('cookie'), SESSION_COOKIE));
  if (s) return { access: 'admin', viaCookie: true, tokenKind: 'session', origin: s.origin };
  return { access: null, viaCookie: false, tokenKind: 'none', origin: null };
}

export function requireLocalAdmin(): RequestHandler {
  return (_req, res, next) => ((res.locals.access as AccessInfo | undefined)?.origin === 'local' ? next() : void res.status(403).json({ error: 'local_admin_only' }));
}
export const actorOf = (a: AccessInfo | undefined): string => (a?.origin === 'managed' && a.tokenLabel ? `token:${a.tokenLabel}` : 'admin');
```

Note the order differs from M §10.2 in one place on purpose: the managed **admin** lookup runs before local client tokens (as the spec says) but the managed lookup is done once (`m`) and reused, so a bearer is hashed for managed tokens once per request.

Sessions: payload `v2.<expires>.<l|m>`; `verify` returns `{origin}` or null; `startSession(req, res, origin)`. Token-form login → `local`. `login-link` route → `links.consume(code)` gives the origin the link was minted with. `POST /control/login-links` → `d.links.issue(res.locals.access.origin === 'local' ? 'local' : 'managed')`, audit `user: actorOf(res.locals.access)`. In `control-api.ts`, replace each literal `user: 'admin'` in admin routes with `user: actorOf(res.locals.access)` (17 places; `grep -n "user: 'admin'" src/api/*.ts` must then print only the session routes' own success record, which uses the session origin). `src/proxy.ts`: `managed: (b) => tokenStore.match(b)` where `tokenStore = new TokenStore({ file: join(dataDir, 'admin', 'tokens.json'), localDigests: () => [loaded.secrets.adminToken, ...loaded.secrets.tokens, ...(loaded.secrets.auditToken ? [loaded.secrets.auditToken] : [])].map((x) => createHash('sha256').update(x).digest()) })`. The TokenStore constructor reads the file only if it exists (pi-compat: nothing created).

- [ ] **Step 4: Run** `npx vitest run test/auth-managed.test.ts test/auth*.test.ts test/control*.test.ts test/login*.test.ts test/pi-compat.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/api/auth.ts src/api/session.ts src/api/login-links.ts src/api/control-api.ts src/api/cams-admin-api.ts src/proxy.ts test/auth-managed.test.ts
git commit -m "feat(auth): managed tokens beside CAMPROXY_TOKENS; only local admin rights widen command policy"
```

(The `/control/admin/commands*` routes used by the test land in Task 7; until then mark those two tests `it.todo` and switch them on in Task 7. Everything else in this task runs now.)

---

### Task 5: The command check, limits and the journal

**Files:**
- Create: `src/fleet/command-check.ts`, `src/fleet/journal.ts`, `test/fleet-command-check.test.ts`, `test/fleet-journal.test.ts`

**Interfaces:**
- Consumes: `verifyEnvelope` (Task 1), `IMPLEMENTED` (Task 2), `ARGS_VALIDATORS` (Task 3).
- Produces:
  - `type Nack = 'bad_signature' | 'wrong_target' | 'expired' | 'replayed' | 'not_allowed' | 'paused' | 'rate_limited' | 'invalid_args' | 'unsupported_version' | 'busy'`
  - `interface CommandBody { proxyId: string; connId: string; cmdId: string; exp: number; actor: string; command: string; args: Record<string, unknown> }`
  - `interface CheckContext { proxyId: string; connId: string; serverKeys: string[]; serverNow: number; seen: SeenIds; policy: { enabled: boolean; paused: boolean; allow: string[] }; journal: (cmdId: string) => JournalEntry | 'running' | undefined; limits: CommandLimits; implemented: ReadonlySet<string> }`
  - `type Decision = { kind: 'bad_message' } | { kind: 'nack'; cmdId: string; code: Nack; retryAfterS?: number } | { kind: 'duplicate'; cmdId: string; entry: JournalEntry | 'running' } | { kind: 'run'; cmd: CommandBody; args: unknown }`
  - `checkCommand(m: Envelope, ctx: CheckContext): Decision` (steps 1–11; `busy` is the runner's).
  - `class SeenIds { constructor(ttlMs = 300_000, cap = 4096); has(id, now): boolean; add(id, now): void }`
  - `class CommandLimits { constructor(now: () => number); take(command: string): { ok: true } | { ok: false; retryAfterS: number } }` (30/min + 300/day total; `tokens.apply` 6/h).
  - `interface JournalEntry { cmdId: string; command: string; actor: string; at: number; status: 'ok' | 'failed' | 'conflict'; code?: string; result?: Record<string, unknown>; changed?: string[] }`
  - `class Journal { constructor(file: string, now?: () => number); get(cmdId): JournalEntry | undefined; record(e: JournalEntry): void; recent(n: number): JournalEntry[] }`

- [ ] **Step 1: Failing tests.** `test/fleet-command-check.test.ts` runs **every** vendored command fixture through `checkCommand` with its `$context` and asserts the runtime code; then the step order and the clock:

```ts
import { describe, expect, it } from 'vitest';
import { checkCommand, CommandLimits, SeenIds, type CheckContext } from '../src/fleet/command-check';
import { IMPLEMENTED } from '../src/fleet/policy';
import { signEnvelope } from '../src/fleet/protocol';
import { fixtures, vectors } from './helpers/contract';

const ctxOf = (c: NonNullable<ReturnType<typeof fixtures>[number]['f']['$context']>, extra: Partial<CheckContext> = {}): CheckContext => {
  const seen = new SeenIds();
  for (const id of c.seen ?? []) seen.add(id, c.now);
  return { proxyId: c.proxyId, connId: c.connId, serverKeys: c.serverKeys, serverNow: c.now, seen, policy: { enabled: true, paused: !!c.paused, allow: c.allow ?? [] }, journal: () => undefined, limits: new CommandLimits(() => c.now), implemented: IMPLEMENTED, ...extra };
};

describe('every contract fixture for the proxy', () => {
  const cmds = fixtures().filter(({ f }) => f.schema === 'command');
  it('there are command fixtures (the vendored copy is P2)', () => expect(cmds.length).toBeGreaterThanOrEqual(14));
  for (const { name, f } of cmds) {
    it(name, () => {
      const d = checkCommand(f.message as never, ctxOf(f.$context!));
      if (name.startsWith('valid-')) expect(d.kind).toBe('run');
      else if (f.$expect?.receiver === 'proxy') expect(d.kind === 'nack' ? d.code : d.kind, name).toBe(f.$expect.runtime);
    });
  }
});

describe('the check order', () => {
  const base = fixtures().find((x) => x.name === 'valid-command-tokens-apply')!;
  const c = base.f.$context!;
  const m = base.f.message as Record<string, any>;
  const resign = (patch: (x: Record<string, any>) => void, key = vectors.keys.server.privateKey) => {
    const x = structuredClone(m);
    delete x.sig;
    patch(x);
    return { ...x, sig: signEnvelope(key, x as never) };
  };
  it('a bad signature wins over a wrong target and an expired exp', () => {
    const x = resign((e) => { e.body.proxyId = 'prx_ZZZZZZZZZZZZZZZZZZZZ'; e.body.exp = 1; }, vectors.keys.other.privateKey);
    expect(checkCommand(x as never, ctxOf(c))).toMatchObject({ kind: 'nack', code: 'bad_signature' });
  });
  it('replay on the same connection; the same envelope on another connection is wrong_target', () => {
    const ctx = ctxOf(c, { policy: { enabled: true, paused: false, allow: ['tokens.apply'] } });
    expect(checkCommand(m as never, ctx).kind).toBe('run');
    expect(checkCommand(m as never, ctx)).toMatchObject({ code: 'replayed' });
    expect(checkCommand(m as never, ctxOf(c, { connId: 'con_ZZZZZZZZZZZZZZZZZZZZ', policy: { enabled: true, paused: false, allow: ['tokens.apply'] } }))).toMatchObject({ code: 'wrong_target' });
  });
  it('a journaled cmdId is a duplicate even when paused (nothing runs)', () => {
    const entry = { cmdId: m.body.cmdId, command: 'tokens.apply', actor: 'a', at: 1, status: 'ok' as const, result: { revision: 1 } };
    expect(checkCommand(m as never, ctxOf(c, { journal: () => entry, policy: { enabled: true, paused: true, allow: [] } }))).toMatchObject({ kind: 'duplicate', entry });
  });
  it('env off beats the allow-list; not allowed beats rate limits; rate limits beat bad args', () => {
    expect(checkCommand(m as never, ctxOf(c, { policy: { enabled: false, paused: false, allow: ['tokens.apply'] } }))).toMatchObject({ code: 'paused' });
    const limits = new CommandLimits(() => c.now);
    for (let i = 0; i < 6; i++) limits.take('tokens.apply');
    expect(checkCommand(m as never, ctxOf(c, { limits, policy: { enabled: true, paused: false, allow: [] } }))).toMatchObject({ code: 'not_allowed' });
    expect(checkCommand(m as never, ctxOf(c, { limits, policy: { enabled: true, paused: false, allow: ['tokens.apply'] } }))).toMatchObject({ code: 'rate_limited', retryAfterS: expect.any(Number) });
  });
  it('exp is judged on the server clock from the challenge (R2-4): a proxy clock 3 years off still accepts a fresh command', () => {
    // serverNow is what the runner computes as Date.now() + offset; the proxy's own clock never enters.
    expect(checkCommand(m as never, ctxOf(c, { serverNow: c.now + 179_000, policy: { enabled: true, paused: false, allow: ['tokens.apply'] } })).kind).toBe('run');
    expect(checkCommand(m as never, ctxOf(c, { serverNow: c.now + 181_000, policy: { enabled: true, paused: false, allow: ['tokens.apply'] } }))).toMatchObject({ code: 'expired' });
  });
  it('a body without a readable cmdId is bad_message (no result)', () => {
    expect(checkCommand({ ...m, body: { ...m.body, cmdId: 7 } } as never, ctxOf(c))).toEqual({ kind: 'bad_message' });
  });
  it('limits: 30/min, 300/day, tokens.apply 6/h', () => {
    let now = 0;
    const l = new CommandLimits(() => now);
    for (let i = 0; i < 6; i++) expect(l.take('tokens.apply').ok).toBe(true);
    expect(l.take('tokens.apply')).toMatchObject({ ok: false });
    for (let i = 0; i < 24; i++) expect(l.take('config.get').ok).toBe(true);
    expect(l.take('config.get')).toMatchObject({ ok: false });
    now += 60_000;
    expect(l.take('config.get').ok).toBe(true);
  });
});
```

`test/fleet-journal.test.ts`: `record` then `get`; file mode 600; survives a reload; keeps the newest 1000 plus anything younger than 7 days, never more than 2500; an unsafe or corrupt file → `get` returns undefined and `record` rewrites a fresh one (logged `admin_journal_reset`, the old file renamed `commands.json.bad-<ts>`).

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `src/fleet/command-check.ts`:

```ts
import type { Envelope } from './protocol';
import { verifyEnvelope } from './protocol';
import { ARGS_VALIDATORS } from './command-args';
import type { JournalEntry } from './journal';

export type Nack = 'bad_signature' | 'wrong_target' | 'expired' | 'replayed' | 'not_allowed' | 'paused' | 'rate_limited' | 'invalid_args' | 'unsupported_version' | 'busy';
export interface CommandBody { proxyId: string; connId: string; cmdId: string; exp: number; actor: string; command: string; args: Record<string, unknown> }
export type Decision =
  | { kind: 'bad_message' }
  | { kind: 'nack'; cmdId: string; code: Nack; retryAfterS?: number }
  | { kind: 'duplicate'; cmdId: string; entry: JournalEntry | 'running' }
  | { kind: 'run'; cmd: CommandBody; args: unknown };

const CMD_ID = /^cmd_[0-9A-HJKMNP-TV-Z]{20}$/;
const SLACK_MS = 120_000;
const MAX_LIFETIME_MS = 60_000;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export class SeenIds {
  private m = new Map<string, number>();
  constructor(private readonly ttlMs = 300_000, private readonly cap = 4096) {}
  has(id: string, now: number): boolean { this.prune(now); return this.m.has(id); }
  add(id: string, now: number): void {
    this.prune(now);
    this.m.set(id, now);
    while (this.m.size > this.cap) this.m.delete(this.m.keys().next().value as string);
  }
  private prune(now: number): void { for (const [k, t] of this.m) { if (now - t < this.ttlMs) break; this.m.delete(k); } }
}

class Window { constructor(readonly ms: number, readonly cap: number, public start = 0, public n = 0) {} }
export class CommandLimits {
  private total = [new Window(60_000, 30), new Window(86_400_000, 300)];
  private per: Record<string, Window[]> = { 'tokens.apply': [new Window(3_600_000, 6)] };
  constructor(private readonly now: () => number) {}
  take(command: string): { ok: true } | { ok: false; retryAfterS: number } {
    const t = this.now();
    const ws = [...this.total, ...(this.per[command] ?? [])];
    for (const w of ws) if (t - w.start >= w.ms) { w.start = t; w.n = 0; }
    const full = ws.find((w) => w.n >= w.cap);
    if (full) return { ok: false, retryAfterS: Math.max(1, Math.ceil((full.start + full.ms - t) / 1000)) };
    for (const w of ws) w.n++;
    return { ok: true };
  }
}

export interface CheckContext {
  proxyId: string; connId: string; serverKeys: string[]; serverNow: number; seen: SeenIds;
  policy: { enabled: boolean; paused: boolean; allow: string[] };
  journal: (cmdId: string) => JournalEntry | 'running' | undefined;
  limits: CommandLimits; implemented: ReadonlySet<string>;
}

// The contract's check order, steps 1-11 (the runner adds 12, busy).
export function checkCommand(m: Envelope, c: CheckContext): Decision {
  const b = m.body as Record<string, unknown>;
  if (typeof b.cmdId !== 'string' || !CMD_ID.test(b.cmdId)) return { kind: 'bad_message' };
  const cmdId = b.cmdId;
  const nack = (code: Nack, retryAfterS?: number): Decision => ({ kind: 'nack', cmdId, code, ...(retryAfterS !== undefined ? { retryAfterS } : {}) });
  if (typeof m.sig !== 'string' || !verifyEnvelope(c.serverKeys, m)) return nack('bad_signature');
  if (b.proxyId !== c.proxyId || b.connId !== c.connId) return nack('wrong_target');
  if (c.seen.has(m.id, c.serverNow)) return nack('replayed');
  c.seen.add(m.id, c.serverNow);
  const exp = b.exp;
  if (!Number.isSafeInteger(exp) || (exp as number) - m.ts < 1 || (exp as number) - m.ts > MAX_LIFETIME_MS || (exp as number) + SLACK_MS < c.serverNow) return nack('expired');
  const j = c.journal(cmdId);
  if (j) return { kind: 'duplicate', cmdId, entry: j };
  if (!c.policy.enabled || c.policy.paused) return nack('paused');
  const command = typeof b.command === 'string' ? b.command : '';
  if (!c.implemented.has(command) || !c.policy.allow.includes(command)) return nack('not_allowed');
  const t = c.limits.take(command);
  if (!t.ok) return nack('rate_limited', t.retryAfterS);
  const v = ARGS_VALIDATORS[command]?.(b.args);
  if (!v || !v.ok) return nack(v && !v.ok ? v.code : 'invalid_args');
  if (command === 'tokens.apply' && (v.args as { tokens: { kind: string }[] }).tokens.some((x) => x.kind === 'admin') && !c.policy.allow.includes('tokens.apply.admin')) return nack('not_allowed');
  if (typeof b.actor !== 'string' || !isObj(b.args)) return nack('invalid_args');
  return { kind: 'run', cmd: { proxyId: c.proxyId, connId: c.connId, cmdId, exp: exp as number, actor: (b.actor as string).slice(0, 200), command, args: b.args as Record<string, unknown> }, args: v.args };
}
```

(The step-8 check happens before the per-command limit is charged, so an unallowed flood never consumes the budget of allowed commands; a refused `rate_limited` still counted the attempt — that is the point of the limit.)

`src/fleet/journal.ts` with `readPrivateJson`/`writePrivateJson` (`{v: 1, entries: JournalEntry[]}`), pruning on `record`: keep `entries` sorted by `at`; drop from the oldest while `(count > 1000 && now − at > 7 days) || count > 2500`.

- [ ] **Step 4: Run** `npx vitest run test/fleet-command-check.test.ts test/fleet-journal.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/fleet/command-check.ts src/fleet/journal.ts test/fleet-command-check.test.ts test/fleet-journal.test.ts
git commit -m "feat(fleet): the command check (contract order), limits and the command journal"
```

---

### Task 6: The runner, the client wiring, `tokens.apply`, heartbeat fields, `admin-command` audit

**Files:**
- Create: `src/fleet/commands.ts`, `test/fleet-commands.test.ts`
- Modify: `src/fleet/client.ts`, `src/fleet/heartbeat.ts`, `src/fleet/service.ts`, `src/audit/actions.ts`, `docs/audit-log.md`, `src/proxy.ts`, `test/helpers/fake-admin.ts` (sends signed commands, records results/events), `test/fleet-heartbeat.test.ts`, `test/audit-actions.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  - `class CommandRunner { constructor(d: RunnerDeps); onCommand(m: Envelope, conn: ConnCtx, send: SignedSend): void; afterWelcome(conn: ConnCtx, send: SignedSend): void; recent(n): JournalEntry[]; status(): { enabled; paused; pauseReason; allow: string[]; seenWindow: 1000 } }`
  - `interface ConnCtx { connId: string; offsetMs: number; seen: SeenIds }`; `type SignedSend = (type: 'result' | 'event', body: Record<string, unknown>, re?: string) => boolean` (false when the socket is gone).
  - `interface RunnerDeps { proxyId: () => string; serverKeys: () => string[]; policy: CommandPolicy; journal: Journal; tokens: TokenStore; audit: Pick<AuditLog, 'write'>; log: ClientLog; now?: () => number }`
  - Client: `ClientDeps.commands?: CommandRunner`; hello `capabilities: deps.commands ? ['status', 'commands'] : ['status']`; the client signs `result`/`event` with `signEnvelope(key.privateKey, …)`.
  - `HeartbeatProxyInfo` gains `commands?: {…}`, `tokens?: {…}`, `configRevision?: string | null` (as in the contract).
  - Audit actions: `admin-command` (one per final outcome, nacks throttled), `admin-policy` (allow-list/pause changes, Task 7), `admin-token` (block/unblock, Task 7).

- [ ] **Step 1: Failing tests** (`test/fleet-commands.test.ts`), using `FakeAdmin` (extended: `sendCommand(command, args, o?: {connId?, proxyId?, exp?, key?, actor?, cmdId?}): {id, cmdId}` signs with the vectors server key over JCS; `results()` / `events()` lists; `verifyFromProxy(m)` checks the proxy signature with the enrolled key) and a real proxy from `startProxy` enrolled against it:

```ts
it('tokens.apply end to end: received then done ok, both signed by the proxy key, the token works at once', async () => {
  await allow(['tokens.apply']);               // PUT /control/admin/commands with the local admin token (Task 7 route; until then policy.setAllow via p.camsAdmin)
  const t = newToken();
  const { cmdId } = fake.sendCommand('tokens.apply', { v: 1, revision: 1, tokens: [{ id: TOK1, kind: 'client', hash: hashOf(t), label: 'cams test', retireAt: null }] });
  const rs = await until(() => fake.results(cmdId).length === 2 && fake.results(cmdId));
  expect(rs.map((r) => r.msg.body.phase)).toEqual(['received', 'done']);
  for (const r of rs) expect(fake.verifyFromProxy(r.msg)).toBe(true);
  expect(rs[1].msg.body).toMatchObject({ status: 'ok', result: { revision: 1, applied: true, client: 1 } });
  await auth(request(p.app).get('/api/cameras'), t).expect(200);
});
it('the same cmdId again (a retry on a later connection): duplicate, nothing runs twice', async () => {
  fake.dropConnections();                      // the proxy reconnects
  await until(() => fake.open() === 1);
  fake.sendCommand('tokens.apply', ARGS_REV1, { cmdId });
  const d = await until(() => fake.results(cmdId).find((r) => r.msg.body.duplicate));
  expect(d.msg.body).toMatchObject({ phase: 'done', status: 'ok', duplicate: true });
  expect(auditOf('admin-command').filter((r) => r.details.cmdId === cmdId)).toHaveLength(1);
});
it('every refusal is a signed result with the code; nothing is journaled or applied', async () => {
  for (const [patch, code] of [[{ key: OTHER }, 'bad_signature'], [{ connId: OLD_CONN }, 'wrong_target'], [{ exp: 'past' }, 'expired']] as const) {
    const { cmdId } = fake.sendCommand('tokens.apply', ARGS_REV9, patch);
    const r = await until(() => fake.results(cmdId)[0]);
    expect(r.msg.body).toMatchObject({ phase: 'done', status: 'refused', code });
    expect(fake.verifyFromProxy(r.msg)).toBe(true);
  }
  expect(tokenStoreRevision()).toBe(1);
  expect(journalHas(...)).toBe(false);
});
it('pause on the card refuses with paused; the heartbeat says so; cams-admin cannot resume', async () => { /* pause → command → refused paused; next heartbeat proxy.commands.paused true */ });
it('CAMPROXY_ADMIN_COMMANDS=off: enabled false in the heartbeat, every command paused', async () => { /* separate proxy started with the env var */ });
it('a done that could not be sent goes out as an event after the next welcome', async () => {
  fake.closeAfterReceived = true;              // FakeAdmin closes the socket right after a received result
  const { cmdId } = fake.sendCommand('tokens.apply', ARGS_REV2);
  const ev = await until(() => fake.events().find((e) => e.msg.body.cmdId === cmdId));
  expect(ev.msg.body).toMatchObject({ kind: 'command.done', status: 'ok' });
  expect(fake.verifyFromProxy(ev.msg)).toBe(true);
});
it('busy: a second command while one runs', async () => { /* the runner's handler blocked by a test hook → second gets busy */ });
it('result and event messages pass the strict contract schemas; the heartbeat with commands/tokens/configRevision too', async () => {
  for (const r of fake.received.filter((x) => ['result', 'event', 'heartbeat'].includes(x.msg.type))) expect(strict(r.msg.type)(r.msg), why(strict(r.msg.type))).toBe(true);
});
it('secret marker guard: no token, hash, key or password in any result, event, heartbeat or audit record', async () => { /* every secret env set to a marker; scan fake.received and the audit file */ });
it('a nack flood writes at most one admin-command failure record per code per 10 min, the rest counted', async () => {});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `src/fleet/commands.ts`:

```ts
import type { AuditLog } from '../audit/audit-log';
import { RefusalThrottle } from '../audit/throttle';
import type { ClientLog } from './client';
import { checkCommand, CommandLimits, type CommandBody, type Nack, type SeenIds } from './command-check';
import type { Journal, JournalEntry } from './journal';
import { IMPLEMENTED, type CommandPolicy } from './policy';
import type { Envelope } from './protocol';
import { ShadowsLocalToken, type TokenStore, type TokensApplyArgs } from './token-store';

export interface ConnCtx { connId: string; offsetMs: number; seen: SeenIds }
export type SignedSend = (type: 'result' | 'event', body: Record<string, unknown>, re?: string) => boolean;
type Done = { status: 'ok' | 'failed' | 'conflict'; code?: string; result?: Record<string, unknown>; changed?: string[] };

export interface RunnerDeps { proxyId: () => string; serverKeys: () => string[]; policy: CommandPolicy; journal: Journal; tokens: TokenStore; audit: Pick<AuditLog, 'write'>; log: ClientLog; now?: () => number }

export class CommandRunner {
  private running: string | null = null;
  private readonly limits: CommandLimits;
  private readonly nackAudit = new RefusalThrottle();
  private nacksThisMinute = { start: 0, n: 0, dropped: 0 };
  private undelivered = new Map<string, Record<string, unknown>>();
  private readonly now: () => number;

  constructor(private readonly d: RunnerDeps) {
    this.now = d.now ?? Date.now;
    this.limits = new CommandLimits(this.now);
  }

  status() {
    const p = this.d.policy.effective();
    return { enabled: p.enabled, paused: p.paused, pauseReason: p.pauseReason, allow: p.allow.filter((a) => IMPLEMENTED.has(a)), seenWindow: 1000 };
  }

  recent(n: number): JournalEntry[] { return this.d.journal.recent(n); }

  // 'bad_message': the client answers `error bad_message` itself (no result without a cmdId).
  onCommand(m: Envelope, conn: ConnCtx, send: SignedSend): 'bad_message' | void {
    const p = this.d.policy.effective();
    const decision = checkCommand(m, {
      proxyId: this.d.proxyId(), connId: conn.connId, serverKeys: this.d.serverKeys(), serverNow: this.now() + conn.offsetMs, seen: conn.seen,
      policy: { enabled: p.enabled, paused: p.paused, allow: p.allow },
      journal: (id) => (this.running === id ? 'running' : this.d.journal.get(id)),
      limits: this.limits, implemented: IMPLEMENTED,
    });
    const base = { proxyId: this.d.proxyId(), connId: conn.connId };
    switch (decision.kind) {
      case 'bad_message':
        return 'bad_message';
      case 'nack':
        return this.nack(m, decision.cmdId, decision.code, decision.retryAfterS, base, send);
      case 'duplicate':
        if (decision.entry === 'running') return void send('result', { ...base, cmdId: decision.cmdId, phase: 'received', duplicate: true }, m.id);
        return void send('result', { ...base, cmdId: decision.cmdId, phase: 'done', status: decision.entry.status, ...(decision.entry.code ? { code: decision.entry.code } : {}), duplicate: true, ...(decision.entry.result ? { result: decision.entry.result } : {}) }, m.id);
      case 'run':
        if (this.running) return this.nack(m, decision.cmd.cmdId, 'busy', undefined, base, send);
        return this.run(m, decision.cmd, decision.args, base, send);
    }
  }
  // ...run(), nack(), afterWelcome() below
}
```

`run`:

```ts
  private run(m: Envelope, cmd: CommandBody, args: unknown, base: { proxyId: string; connId: string }, send: SignedSend): void {
    this.running = cmd.cmdId;
    send('result', { ...base, cmdId: cmd.cmdId, phase: 'received' }, m.id);
    let done: Done;
    try {
      done = this.handle(cmd, args);
    } catch (err) {
      done = { status: 'failed', code: 'internal', result: { message: String((err as Error).message).slice(0, 200) } };
    } finally {
      this.running = null;
    }
    const entry: JournalEntry = { cmdId: cmd.cmdId, command: cmd.command, actor: cmd.actor, at: this.now(), status: done.status, ...(done.code ? { code: done.code } : {}), ...(done.result ? { result: done.result } : {}), ...(done.changed ? { changed: done.changed } : {}) };
    try {
      this.d.journal.record(entry);
    } catch (err) {
      this.d.log.warn({ err: String((err as Error).message).slice(0, 200) }, 'admin_journal_error');
    }
    this.audit(cmd, done);
    const body = { ...base, cmdId: cmd.cmdId, phase: 'done', status: done.status, ...(done.code ? { code: done.code } : {}), ...(done.result ? { result: done.result } : {}) };
    if (!send('result', body, m.id)) this.undelivered.set(cmd.cmdId, body);
  }

  private handle(cmd: CommandBody, args: unknown): Done {
    if (cmd.command === 'tokens.apply') {
      try {
        const r = this.d.tokens.apply(args as TokensApplyArgs);
        return { status: 'ok', result: { ...r }, changed: r.applied ? ['tokens'] : [] };
      } catch (err) {
        if (err instanceof ShadowsLocalToken) return { status: 'failed', code: 'shadows_local_token' };
        return { status: 'failed', code: 'store_error' };
      }
    }
    return { status: 'failed', code: 'not_implemented' }; // unreachable: checkCommand allows only IMPLEMENTED
  }

  // After the next welcome: every done that never went out, as a signed event.
  afterWelcome(conn: ConnCtx, send: SignedSend): void {
    for (const [cmdId, body] of this.undelivered) {
      if (send('event', { ...body, kind: 'command.done', proxyId: this.d.proxyId(), connId: conn.connId })) this.undelivered.delete(cmdId);
    }
  }
```

(`event` body = the `done` result body with `kind` and the new `connId`; `phase: 'done'` stays.)

`nack`: at most 60 nack results per minute (`nacksThisMinute`; beyond that, drop and count, logged `admin_nack_dropped` at debug once per minute with the count); audit through `nackAudit.take('cams-admin', code)` → one `admin-command` failure record per code per 10 min (`details: {cmdId, command (≤ 32 chars of what was sent), outcome: code, suppressed}`).

`audit(cmd, done)`:

```ts
  private audit(cmd: CommandBody, done: Done): void {
    const ok = done.status === 'ok';
    this.d.audit.write({
      action: 'admin-command', category: ['configuration'], type: ['change'], outcome: ok ? 'success' : 'failure', user: 'cams-admin',
      message: `cams-admin (on behalf of ${cmd.actor}) ran ${cmd.command}: ${done.status}${done.code ? ` (${done.code})` : ''}`,
      ...(done.code ? { error: done.code } : {}),
      details: { cmdId: cmd.cmdId, command: cmd.command, actor: cmd.actor, outcome: done.status, ...(done.code ? { code: done.code } : {}), changed: done.changed ?? [],
        ...(cmd.command === 'tokens.apply' && done.result ? { tokens: { revision: done.result.revision, client: done.result.client, admin: done.result.admin, ids: (cmd.args.tokens as { id: string; kind: string; label: string }[]).map((t) => ({ id: t.id, kind: t.kind, label: t.label })) } } : {}) },
    });
  }
```

(Ids, kinds and labels only; never `hash`.)

`src/fleet/client.ts` changes:
- keep `this.connId` and `this.offsetMs = serverTime − this.now()` from the verified challenge; reset both in `connect()`; a `SeenIds` per connection.
- capabilities `this.d.commands ? ['status', 'commands'] : ['status']`.
- `case 'command':` → if `!this.d.commands`, keep today's `unsupported_type` answer; else `const r = this.d.commands.onCommand(m, {connId, offsetMs, seen}, (type, body, re) => this.sendSigned(ws, type, body, re))`; when `r === 'bad_message'`, `trySend(ws, 'error', {code: 'bad_message', message: 'command without a cmdId'}, {re: m.id})`. Commands count against `MAX_UNSUPPORTED` only when refused before the signature check (step 1–2), so a hostile server can't keep a connection busy with junk forever: more than 20 such per connection → close 4400 (existing path).
- `sendSigned(ws, type, body, re?)`: `const m = buildEnvelope(type, ++this.seqOut, body, { now: this.now(), re }); m.sig = signEnvelope(this.key.privateKey, m); ws.send(JSON.stringify(m)); return true` (returns false when `readyState !== OPEN` or `bufferedAmount > maxBufferedBytes`).
- after `welcome`: `this.d.commands?.afterWelcome(...)` after the first heartbeat is sent.
- `case 'result'`/`'event'` from the server stay `unsupported_type` (a server never sends them).

`src/fleet/heartbeat.ts`: `info()` passes through `commands` (allow clamped to 32 × 64 chars, pauseReason to 200), `tokens` (blocked ≤ 64) and `configRevision` when present. `service.ts`: `CamsAdminDeps.commands?: () => CommandRunner | null`, passed to each new `AdminClient`. `proxy.ts`: build `CommandPolicy`, `Journal` (`data/admin/commands.json`), `TokenStore` (Task 4), `CommandRunner` (`audit`, `serverKeys: () => camsAdmin key file's serverKeys`, `proxyId: () => key.proxyId`), and add to `proxyInfo()`: `commands: runner.status(), tokens: tokenStore.counts(), configRevision: configRevision(loaded)` — only when `running.camsAdmin.url` is set (pi-compat: the P1 heartbeat shape otherwise).

`src/audit/actions.ts`: add `'admin-command', 'admin-policy', 'admin-token'` after `'admin-unenroll'`; document all three in `docs/audit-log.md` (fields as above).

- [ ] **Step 4: Run** `npx vitest run test/fleet-commands.test.ts test/fleet-client.test.ts test/fleet-heartbeat.test.ts test/audit-actions.test.ts test/pi-compat.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/fleet/commands.ts src/fleet/client.ts src/fleet/heartbeat.ts src/fleet/service.ts src/audit/actions.ts docs/audit-log.md src/proxy.ts test/helpers/fake-admin.ts test/fleet-commands.test.ts test/fleet-heartbeat.test.ts
git commit -m "feat(fleet): run allow-listed commands from cams-admin; tokens.apply; admin-command audit"
```

---

### Task 7: Control routes and the CLI (allow-list, pause, tokens)

**Files:**
- Modify: `src/api/cams-admin-api.ts`, `src/fleet/cli.ts`, `src/cli.ts`, `docs/openapi.yaml` (or the repo's OpenAPI file: `git ls-files | grep -i openapi`)
- Test: `test/fleet-control.test.ts`, `test/fleet-cli.test.ts`

**Interfaces:**
- Consumes: `CommandPolicy`, `TokenStore`, `CommandRunner.recent`, `requireLocalAdmin`, `actorOf`.
- Produces routes (all behind `requireAccess('admin')`):
  - `GET /control/admin/commands` → `{ enabled, paused, pauseReason, envName, allow, implemented: string[], known: {entry, text}[], recent: JournalEntry[] (20) }`
  - `PUT /control/admin/commands` `{allow: string[]}` → 200 view; 400 `invalid` (unknown entry); 403 `local_admin_only` when it adds an entry and the caller is managed
  - `POST /control/admin/commands/pause` `{reason?: string}` → 200 (any admin)
  - `POST /control/admin/commands/resume` → `requireLocalAdmin`, 200
  - `GET /control/admin/tokens` → `{revision, problem, items: TokenStore.list()}`
  - `POST /control/admin/tokens/:id/block` → 200 (any admin); `POST /control/admin/tokens/:id/unblock` → `requireLocalAdmin`
  - CLI: `cam-proxy admin-commands [status | allow <entry…> | deny <entry…> | pause [reason] | resume]`, `cam-proxy admin-tokens [list | block <id> | unblock <id>]`. With the proxy running they call the routes above with `CAMPROXY_ADMIN_TOKEN` (local); stopped, they write `policy.json` / `tokens.json` directly (`by: 'local'`), as `admin-enroll` does.
- `known[].text` — one sentence per entry saying what it can change, e.g. `tokens.apply`: "cams-admin may add, rotate and revoke managed **client** tokens for cams (CAMPROXY_TOKENS keeps working)"; `tokens.apply.admin`: "… managed **admin** tokens (sign-in links, camera rename); your local admin token is never affected"; P3 entries: "(not in this version)".

- [ ] **Step 1: Failing tests:** every route's status codes above; `deny` and `pause` work with a managed admin token, `allow` (adding) and `resume` and `unblock` don't; each change writes one `admin-policy` / `admin-token` audit record with `user: actorOf(...)` and `details: {before, after}` (entry names, token ids — never hashes); the CLI with the proxy stopped writes `policy.json` mode 600; with the proxy running it goes through the route (the fake server in `test/fleet-cli.test.ts` records the request, Authorization header present, never printed).
- [ ] **Step 2: Run** → FAIL. Switch on the two `it.todo`s of Task 4.
- [ ] **Step 3: Implement.** In `cams-admin-api.ts`:

```ts
  r.get('/admin/commands', (_req, res) => void res.json(commandsView()));
  r.put('/admin/commands', (req, res) => {
    const a = res.locals.access as AccessInfo;
    const before = d.policy.effective().allow;
    try {
      d.policy.setAllow((req.body ?? {}).allow, a.origin === 'local' ? 'local' : 'managed');
    } catch (err) {
      if (err instanceof WideningRefused) return void res.status(403).json({ error: 'local_admin_only', message: err.message });
      if (err instanceof ConfigError) return void res.status(400).json({ error: 'invalid', detail: err.message });
      throw err;
    }
    d.audit.write({ action: 'admin-policy', category: ['configuration'], type: ['change'], outcome: 'success', user: actorOf(a), ...who(req), message: `Allowed cams-admin commands: ${d.policy.effective().allow.join(', ') || 'none'}`, details: { before, after: d.policy.effective().allow } });
    res.json(commandsView());
  });
  r.post('/admin/commands/pause', (req, res) => { /* d.policy.pause(String(req.body?.reason ?? '') || null, origin); audit admin-policy 'Commands paused' */ });
  r.post('/admin/commands/resume', requireLocalAdmin(), (req, res) => { /* d.policy.resume('local'); audit */ });
```

`commandsView()` = `{ ...d.policy.effective(), implemented: [...IMPLEMENTED], known: ALLOW_ENTRIES.map((entry) => ({ entry, text: ENTRY_TEXT[entry] })), recent: d.runner.recent(20) }`; `ENTRY_TEXT` lives in `policy.ts` next to the list (a test checks every entry has a text).

- [ ] **Step 4: Run** `npx vitest run test/fleet-control.test.ts test/fleet-cli.test.ts test/auth-managed.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/api/cams-admin-api.ts src/fleet/cli.ts src/cli.ts src/fleet/policy.ts test/fleet-control.test.ts test/fleet-cli.test.ts test/auth-managed.test.ts docs/openapi.yaml
git commit -m "feat(fleet): allow-list, pause and token block routes and CLI (widening needs the local admin token)"
```

---

### Task 8: The Status card

**Files:**
- Modify: `web/src/lib/cams-admin.ts`, `web/src/components/CamsAdminCard.svelte`
- Test: `test/cams-admin-ui.test.ts` (Playwright, existing file), `web/src/lib/cams-admin.test.ts` if the repo has web unit tests (else the Playwright file only)

**Interfaces:**
- Consumes: Task 7 routes.
- Produces: in the card, under the existing block:
  - **"Commands from cams-admin"**: a banner when `enabled` is false (`Off: CAMPROXY_ADMIN_COMMANDS is set to off in the environment. cams-admin can't change this.`) or when paused (`Paused: <reason>`) with **Pause** (reason field) / **Resume**; the checkbox list of `known` entries with their sentence, only `implemented` ones enabled (others "not in this version"), **Save**; a 403 `local_admin_only` shows "Adding a command needs the proxy's own admin token: sign in with it (not through cams)."
  - **"Recent commands"**: time, actor, command, outcome; "Audit log" link (`/audit?action=admin-command`).
  - **"Managed tokens"**: id, kind, label, state (`live` / `retires <ago>` / `blocked`), hash prefix (8 hex), **Block** / **Unblock**; `problem` shown in red when the token file is unusable.
- Data-testids: `cams-admin-commands`, `cams-admin-allow-<entry>`, `cams-admin-pause`, `cams-admin-resume`, `cams-admin-commands-banner`, `cams-admin-recent`, `cams-admin-tokens`, `cams-admin-token-block-<id>`.

- [ ] **Step 1: Failing Playwright test** in `test/cams-admin-ui.test.ts`: sign in with the admin token → the card shows "Commands from cams-admin" with every box unchecked; tick `tokens.apply`, Save → reload → still ticked; Pause with reason "maintenance" → banner `Paused: maintenance`; Resume → banner gone; a proxy started with `CAMPROXY_ADMIN_COMMANDS=off` shows the env banner and disables Resume; a seeded `tokens.json` lists one token, Block → state `blocked`.
- [ ] **Step 2: Run** `npx playwright test test/cams-admin-ui.test.ts` → FAIL.
- [ ] **Step 3: Implement** (types in `web/src/lib/cams-admin.ts`: `CommandsView`, `TokensView`; fetch both on card load and after each action; no polling beyond the card's existing refresh).
- [ ] **Step 4: Run** → PASS; `npm run check`.
- [ ] **Step 5: Commit**

```bash
git add web/src/lib/cams-admin.ts web/src/components/CamsAdminCard.svelte test/cams-admin-ui.test.ts
git commit -m "feat(ui): allowed commands, pause, recent commands and managed tokens on the cams-admin card"
```

---

### Task 9: Hostile cams-admin, rotation without downtime, Pi compatibility

**Files:**
- Modify: `test/fleet-isolation.test.ts`, `test/helpers/fake-admin.ts` (modes), `test/pi-compat.test.ts`
- Create: `test/fleet-rotation.test.ts`

**Interfaces:** consumes everything above; produces tests only.

- [ ] **Step 1: Failing tests.**
  - `fake-admin.ts` gains modes `command-flood` (500 commands/s with valid signatures for a command not allowed), `forged` (commands signed with `other`), `replay` (re-sends each command it sent 1 s later on the same connection, and again after reconnecting), `oversize` (args of 200 KiB), `junk-commands` (commands with bodies missing every field). `fleet-isolation.test.ts` runs its existing "the proxy carries on" assertions (events, FTP clips, stills, client API, event-loop lag p99 < 100 ms) for each new mode, **plus**: `tokens.json` and `commands.json` unchanged (mtime and content), `admin-command` audit records ≤ 1 per code per 10 min, the connection closed by the proxy for `junk-commands` after 20 (`MAX_UNSUPPORTED`).
  - `test/fleet-rotation.test.ts`: a proxy with `tokens.apply` allowed and a managed client token `T1` (rev 1); a loop sends `GET /api/cameras` every 20 ms, alternating `CAMPROXY_TOKENS[0]` and the "current cams token" (starts as `T1`); cams-admin side (`fake.sendCommand`) applies rev 2 = `{T1 retireAt now+3 s, T2}`; when `done` arrives the loop switches its current token to `T2`; at now+3 s `T1` must be refused; the test asserts **zero** non-200 answers for requests made with the current token and with `CAMPROXY_TOKENS`, and that `T1` gets 401 after `retireAt`. Then a replay of rev 1 → `stale: true`, `T1` still refused, `T2` still works.
  - `test/pi-compat.test.ts`: the Pi config (no `camsAdmin.url`) → no `data/admin/` after start, a client request with an unknown bearer costs one SHA-256 for the managed lookup and returns 401 as before; the heartbeat has no `commands`/`tokens`/`configRevision` fields and the hello no `commands` capability unless `camsAdmin.url` is set.
- [ ] **Step 2: Run** → FAIL (new modes missing).
- [ ] **Step 3: Implement** the fake-admin modes (test code only; the proxy code should already pass — any failure here is a bug in Tasks 5–6 to fix in place, with a regression test in that task's file).
- [ ] **Step 4: Run** `npx vitest run test/fleet-isolation.test.ts test/fleet-rotation.test.ts test/pi-compat.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add test/fleet-isolation.test.ts test/helpers/fake-admin.ts test/fleet-rotation.test.ts test/pi-compat.test.ts
git commit -m "test(fleet): hostile commands, token rotation without downtime, Pi unchanged"
```

---

### Task 10: `CAMPROXY_TOKENS` optional once a managed client token is active (M §10.2)

**Files:**
- Modify: `src/config/secrets.ts`, `src/config/load.ts`, `src/proxy.ts`
- Test: `test/secrets-managed.test.ts`

**Interfaces:**
- Produces: `loadSecrets(env, ftpEnabled, cameraIds, o?: { tokensOptional?: boolean })` — when `tokensOptional` and `CAMPROXY_TOKENS` is unset, `tokens: []`; `loadConfig(env, { cwd?, tokensOptional? })`. `proxy.ts` start: reads `TokenStore.counts().client` from `<dataDir>/admin/tokens.json` **before** the full load (dataDir from a first `loadConfig(env, {tokensOptional: true})`); if `tokens.length === 0 && counts.client === 0` → the same `CAMPROXY_TOKENS: required` error as today. The CLI keeps the strict default.

- [ ] **Step 1: Failing tests:** no `CAMPROXY_TOKENS` and no store → start fails with `CAMPROXY_TOKENS: required`; no `CAMPROXY_TOKENS` and a store with one live client token → starts, the managed token works, `/api/*` without a token 401; a store with only a retired or blocked client token → fails; `CAMPROXY_ADMIN_TOKEN` still required in every case.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/config/secrets.ts src/config/load.ts src/proxy.ts test/secrets-managed.test.ts
git commit -m "feat(config): CAMPROXY_TOKENS optional while a managed client token is live"
```

---

### Task 11: Docs, CHANGELOG, final checks

**Files:**
- Modify: `docs/cams-admin.md` (new sections: Commands, Allowed commands, Pause and the kill switch, Managed tokens, Local block, Recovery: "cams-admin compromised" runbook = set `CAMPROXY_ADMIN_COMMANDS=off` in the env file and restart, block every managed token, rotate `CAMPROXY_ADMIN_TOKEN` if a UI session may have leaked), `README.md` (one line under cams-admin), `CHANGELOG.md` (`## Unreleased`), `CLAUDE.md` (the `data/admin/` rule names `tokens.json`, `commands.json`, `policy.json`; "commands are off unless allowed locally"), `deploy/cluster/REQUEST.md` (a line: "P2 needs no cluster change; commands ride the existing in-cluster channel")
- Test: whole suite

- [ ] **Step 1:** Write the docs. In `docs/cams-admin.md`, include the check-order table, the nack codes, the allow entries with their sentences, the three files in `data/admin/` and their modes, and the cut-over steps 1–2 from M §11.4 for this proxy (allow `tokens.apply` + `tokens.apply.admin` on the card with the local admin token; cams-admin issues; Klaus/kube-setup put the token into cams; rollback = remove it from cams, `CAMPROXY_TOKENS` never stopped working).
- [ ] **Step 2:** `npm test && npm run build && npm run lint:types && npm run check && scripts/contract-drift.sh && npm run test:e2e && npm run test:e2e:multi && npm audit --audit-level=high`. Expected: all green.
- [ ] **Step 3: Commit**

```bash
git add docs/cams-admin.md README.md CHANGELOG.md CLAUDE.md deploy/cluster/REQUEST.md
git commit -m "docs: cams-admin commands, managed tokens, kill switch"
```

---

## Release and rollout order (both repos)

Each step is its own PR to `main` (checks must pass; merge only then), and every step leaves the Pi and the cluster proxy working.

1. **cams-admin PR A — contract** (cams-admin plan Tasks 1–3). Merge to `main`. From this moment cam-proxy's `contract-drift` check fails on cam-proxy PRs until step 2: do step 2 right after (same day).
2. **cam-proxy PR A — vendor** (this plan, Task 1). Test-only plus `jcs.ts`/`protocol.ts` helpers; no behaviour change. Merge; no release needed.
3. **cams-admin PR B — commands and tokens** (cams-admin plan Tasks 4–9 and 11). Release cams-admin. Safe: P1 proxies don't announce `commands`, so cams-admin sends nothing and shows "commands: not supported by this proxy version".
4. **cam-proxy PR B — commands and tokens** (this plan, Tasks 2–11). Release cam-proxy: the cluster proxy updates through the release workflow; the **Pi** is updated by the release owner (pull + `docker compose up -d`; not by the implementing session if it is told not to touch the Pi). With empty allow-lists both proxies report "commands: none allowed" → **P2a done** (M §15).
5. **cams-admin PR C — two-proxy local stack check** (cams-admin plan Task 10), against cam-proxy `main` from step 4. Run on the Mac.
6. **Cut-over steps 1–2** (M §11.4), separately, with Klaus: allow `tokens.apply` (+ `tokens.apply.admin`) on the cluster proxy's card using its local admin token; issue tokens in cams-admin; Klaus / kube-setup put them into cams's `cams-cameras` Secret; check cams; then the Pi. Rollback at any point: remove the managed token from cams (the `CAMPROXY_TOKENS` value is still valid), or pause on the card. **P2b done** when both cams instances use managed tokens and the rollback was proven once.

## kube-setup

**No change for this phase's code.** The cluster proxy's commands and results ride the existing outbound WebSocket to `cams-admin.cams-admin.svc.cluster.local:8080` (P1 NetworkPolicy). No new port, host, egress, env variable or volume (`data/admin/` is on the existing PVC). At cut-over step 1 only, a **data update** of the cams Secret `cams-cameras` (the new managed tokens in cams's `cameras.json`) is requested through the kube-setup session; the request text lives in cams-admin `docs/kube-setup-request-p2.md`.

## Self-review

- **Spec coverage:** M §7.1 (capability, heartbeat fields, contract) Tasks 1, 6; §7.2 checks Task 5; §7.3 journal/idempotency Tasks 5–6; §7.4 ack/nack, event after reconnect Task 6; §7.5 allow-list local-only Tasks 2, 4, 7, 8 (R2-1, R2-3); §7.6 closed list Task 2; §7.7 pause/env/empty list Tasks 2, 6, 7, 8; §7.8 limits Task 5; §7.9 audit Tasks 6, 7; §10.2 token store, auth order, guards, `CAMPROXY_TOKENS` optional Tasks 3, 4, 10; §13.1 threats Task 9; §14.1 cam-proxy tests Tasks 2–9; §14.2 contract Tasks 1, 5. P3 interfaces delivered: `isDeniedPath`, `DENIED_PATH_PREFIXES`, `REMOTE_ACTIONS`, `ARGS_VALIDATORS`, `configRevision`, the runner's `handle` switch.
- **Placeholder scan:** the only deferred items are the two `it.todo`s of Task 4, switched on in Task 7 by name.
- **Type consistency:** `TokenStore.apply/match/counts/list`, `CommandPolicy.effective/setAllow/pause/resume`, `checkCommand`/`Decision`, `CommandRunner.onCommand/afterWelcome/status/recent` are used with the same names in Tasks 4–8.
