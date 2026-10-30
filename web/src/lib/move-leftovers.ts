// What cameras that moved away left on this proxy that it can't remove
// itself (GET /control/status moveLeftovers, plan D), and what to do about each.
export interface MoveLeftover { camera: string; moveId: string; items: string[] }

export function leftoverAdvice(cam: string, item: string): string {
  if (item === 'config.json entry') return `Delete cameras.${cam} from config.json, then restart the proxy.`;
  const m = /^env (\S+)$/.exec(item);
  if (!m) return item;
  const name = m[1];
  if (name.endsWith('_FILE')) return `Remove ${name} and its secret from the compose file, then recreate the container (docker compose up -d).`;
  return `Remove ${name} from the proxy's environment (compose file or .env), then recreate the container (docker compose up -d). If this proxy already removed it from its .env (see the audit log), recreating is enough.`;
}
