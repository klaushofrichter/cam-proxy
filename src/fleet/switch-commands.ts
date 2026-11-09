import type { AuditLog } from '../audit/audit-log';
import { PoeSwitchError } from '../camera/poe-switch';
import type { SwitchRegistry } from '../camera/switch/registry';
import type { SwitchCycleArgs, SwitchForgetArgs, SwitchLocateArgs, SwitchPoeOnArgs, SwitchReadArgs, SwitchRefArgs, SwitchSurveyArgs } from './command-args';
import type { CommandBody } from './command-check';
import type { Done, Handler } from './commands';

// cams-admin's PoE switch commands (spec 2026-11-07-poe-switches-design):
// each calls registry.get(args.switch), which keeps the descriptor but never
// a password: a switch without a stored password (or one that was forgotten)
// answers password_unset, whatever the descriptor says. The proxy never acts
// on a switch without its own password. switch.forget only drops the switch;
// the registry's onForgotten writes its audit record.
export interface SwitchCommandDeps {
  registry: SwitchRegistry;
  audit: Pick<AuditLog, 'write'>;
}

// A PoeSwitchError as the command's failure code: "PoE may still be off" is poe_may_be_off.
const codeOf = (err: PoeSwitchError): string => (err.poeOff && err.turnedOn === false ? 'poe_may_be_off' : err.code);
// switch.cycle only: PoE was cut and is on again, but the cycle failed (e.g. its check afterwards) — the camera is
// rebooting (contract `cut_on_again`; cams-admin then answers a proxy's own request with poeCut: true).
const cycleCodeOf = (err: PoeSwitchError): string => (err.poeOff && err.turnedOn === true ? 'cut_on_again' : codeOf(err));

export function switchHandlers(d: SwitchCommandDeps): Record<string, Handler> {
  // Runs f; a switch error is a failed result with its code (anything else is the runner's internal error).
  const guard = async (f: () => Promise<Record<string, unknown>>, code: (err: PoeSwitchError) => string = codeOf): Promise<Done> => {
    try {
      return { status: 'ok', result: await f() };
    } catch (err) {
      if (err instanceof PoeSwitchError) return { status: 'failed', code: code(err) };
      throw err;
    }
  };
  const sw = (ref: SwitchRefArgs) => d.registry.get(ref);

  return {
    'switch.read': (a) => guard(async () => {
      const r = await sw((a as SwitchReadArgs).switch).readAll();
      return { ...r };
    }),
    'switch.locate': (a) => guard(async () => {
      const x = a as SwitchLocateArgs;
      return { ...(await sw(x.switch).locate(x.host)) };
    }),
    'switch.survey': (a) => guard(async () => {
      const x = a as SwitchSurveyArgs;
      return { ...(await sw(x.switch).survey(x.cameras)) };
    }),
    'switch.cycle': async (a, cmd: CommandBody) => {
      const x = a as SwitchCycleArgs;
      // force skips the check that the camera is on this port; without it a host is needed to check.
      const verifyHost = x.force ? null : x.host;
      const base = { action: 'switch-port-cycled', category: ['host'], type: ['change'], user: 'cams-admin', camera: x.camera };
      const where = { id: x.switch.id, host: x.switch.host, port: x.port };
      const by = { cmdId: cmd.cmdId, actor: cmd.actor, requestedBy: 'cams-admin' };
      // Not forced and no host to check: nothing is switched (never an unverified cycle by omission).
      const out: Done = !x.force && x.host === null ? { status: 'failed', code: 'not_verified' } : await guard(async () => {
        const r = await sw(x.switch).cycle(x.port, () => undefined, { verifyHost });
        return { verified: r.verified, offAt: r.offAt, onAt: r.onAt, watts: r.watts };
      }, cycleCodeOf);
      if (out.status === 'ok') {
        const r = out.result as { verified: boolean; watts: number };
        d.audit.write({ ...base, outcome: 'success', message: `PoE cycled by cams-admin (on behalf of ${cmd.actor}) at ${x.switch.host} port ${x.port}${x.force ? ' (forced, not verified)' : ' (verified)'}`, details: { switch: where, forced: x.force, verified: r.verified, watts: r.watts, ...by } });
      } else {
        d.audit.write({ ...base, outcome: 'failure', error: out.code, message: `PoE cycle by cams-admin (on behalf of ${cmd.actor}) at ${x.switch.host} port ${x.port} failed: ${out.code}`, details: { switch: where, forced: x.force, ...by } });
      }
      return out;
    },
    'switch.poeOn': async (a, cmd: CommandBody) => {
      const x = a as SwitchPoeOnArgs;
      const base = { action: 'switch-port-poe-on', category: ['host'], type: ['change'], user: 'cams-admin' };
      const where = { id: x.switch.id, host: x.switch.host, port: x.port };
      const by = { cmdId: cmd.cmdId, actor: cmd.actor, requestedBy: 'cams-admin' };
      let wasOn: boolean | undefined;
      let poeStillOff = false;
      const out = await guard(async () => {
        try {
          const r = await sw(x.switch).poeOn(x.port);
          wasOn = r.wasOn;
          return { port: r.port, poe: r.poe, watts: r.watts, link: r.link, tx: r.tx, rx: r.rx, wasOn: r.wasOn };
        } catch (err) {
          if (err instanceof PoeSwitchError && err.poeOff) poeStillOff = true;
          throw err;
        }
      });
      if (out.status === 'ok') {
        d.audit.write({ ...base, outcome: 'success', message: wasOn ? `PoE on ${x.switch.host} port ${x.port}: it was on already (cams-admin, on behalf of ${cmd.actor})` : `PoE turned on at ${x.switch.host} port ${x.port} by cams-admin (on behalf of ${cmd.actor})`, details: { switch: where, wasOn, ...by } });
      } else {
        d.audit.write({ ...base, outcome: 'failure', error: out.code, message: `PoE on ${x.switch.host} port ${x.port} by cams-admin (on behalf of ${cmd.actor}) failed: ${out.code}`, details: { switch: where, ...by, ...(poeStillOff ? { poeStillOff: true } : {}) } });
      }
      return out;
    },
    'switch.forget': (a): Done => ({ status: 'ok', result: { forgot: d.registry.forget((a as SwitchForgetArgs).switchId) } }),
  };
}
