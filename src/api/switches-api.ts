import express from 'express';
import type { AuditLog } from '../audit/audit-log';
import { PoeSwitchError } from '../camera/poe-switch';
import type { SwitchRegistry } from '../camera/switch/registry';
import { switchPasswordStore } from '../config/switch-passwords';
import { PASSWORD_RULE, validPassword } from '../onboarding/password-rule';
import { whoOf } from './onboarding-api';

// The PoE switches this proxy operates (spec 2026-11-07-poe-switches-design),
// mounted on /control behind requireAccess('admin'). The switch password is
// write-only: never in an answer, a log line or an audit record.
export function switchesApi(d: { registry: SwitchRegistry; dataDir: string; audit: AuditLog }): express.Router {
  const r = express.Router();
  const record = (who: ReturnType<typeof whoOf>, category: string) => ({ category: [category], type: ['change'], user: who.user, ...(who.ip ? { ip: who.ip } : {}), ...(who.userAgent ? { userAgent: who.userAgent } : {}) });

  r.get('/switches', (_req, res) => {
    res.json({
      switches: d.registry.known().map((ref) => {
        const sw = d.registry.find(ref.id)!.sw;
        return { ...ref, passwordSet: d.registry.passwordSet(ref.id), busy: sw.status().busy, poeMaybeOff: sw.portsMaybeOff() };
      }),
    });
  });

  r.put('/switches/:id/password', (req, res) => {
    const who = whoOf(req, res);
    const id = String(req.params.id);
    const password: unknown = req.body?.password;
    if (!validPassword(password)) return void res.status(400).json({ error: 'invalid', detail: PASSWORD_RULE });
    const e = d.registry.find(id);
    if (!e) return void res.status(404).json({ error: 'not_found' });
    const base = { ...record(who, 'configuration'), action: 'switch-password', message: '' };
    try {
      switchPasswordStore(d.dataDir).set(id, password);
    } catch {
      d.audit.write({ ...base, outcome: 'failure', error: 'not_saved', message: `PoE switch password for ${id} not saved`, details: { switch: { id, host: e.ref.host }, requestedBy: who.requestedBy } });
      return void res.status(500).json({ error: 'not_saved' });
    }
    d.audit.write({ ...base, outcome: 'success', message: `PoE switch password for ${id} (${e.ref.host}) saved`, details: { switch: { id, host: e.ref.host }, requestedBy: who.requestedBy } });
    res.json({ id, passwordSet: true });
  });

  r.post('/switches/:id/ports/:port/poe-on', async (req, res) => {
    const who = whoOf(req, res);
    const id = String(req.params.id);
    const e = d.registry.find(id);
    if (!e) return void res.status(404).json({ error: 'not_found' });
    const port = Number(req.params.port);
    if (!Number.isInteger(port) || port < 1 || port > e.ref.ports) return void res.status(400).json({ error: 'invalid', detail: `port: 1 to ${e.ref.ports}` });
    const base = { ...record(who, 'host'), action: 'switch-port-poe-on' };
    const sw = { id, host: e.ref.host, port };
    try {
      const out = await e.sw.poeOn(port);
      d.audit.write({ ...base, outcome: 'success', message: out.wasOn ? `PoE on ${e.ref.host} port ${port}: it was on already` : `PoE turned on at ${e.ref.host} port ${port}`, details: { switch: sw, wasOn: out.wasOn, requestedBy: who.requestedBy } });
      res.json(out);
    } catch (err) {
      if (!(err instanceof PoeSwitchError)) throw err;
      d.audit.write({ ...base, outcome: 'failure', error: err.code, message: `PoE on ${e.ref.host} port ${port} failed: ${err.message}`, details: { switch: sw, requestedBy: who.requestedBy, ...(err.poeOff ? { poeStillOff: true } : {}) } });
      res.locals.errorCode = err.code;
      res.status(err.code === 'switch_busy' || err.code === 'password_unset' ? 409 : 502).json({ error: err.code, detail: err.message, ...(err.poeOff ? { poeOff: true } : {}) });
    }
  });
  return r;
}
