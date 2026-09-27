import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { startSim } from './helpers/sim';
import { startProxy } from './helpers/proxy';

// "METHOD /path/{param}" for every operation in openapi.yaml.
function documented(): string[] {
  const out: string[] = [];
  let path = '';
  for (const line of readFileSync(join(__dirname, '..', 'openapi.yaml'), 'utf8').split('\n')) {
    const p = /^  (\/\S*):\s*$/.exec(line);
    if (p) path = p[1];
    const m = /^    (get|put|post|delete|patch):\s*$/.exec(line);
    if (m && path) out.push(`${m[1].toUpperCase()} ${path}`);
  }
  return out.sort();
}

// The routes Express has, with mounted routers resolved by probing.
function registered(app: any): string[] {
  const out: string[] = [];
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) out.push(`${m.toUpperCase()} ${prefix}${layer.route.path.replace(/:(\w+)/g, '{$1}')}`);
      } else if (layer.handle?.stack) {
        const mount = ['/api', '/control'].find((p) => layer.match(`${p}/x`)) ?? '';
        walk(layer.handle.stack, prefix + mount);
      }
    }
  };
  walk(app.router.stack, '');
  return [...new Set(out)].sort();
}

let cleanup: () => Promise<void>;
afterAll(() => cleanup());

describe('openapi.yaml', () => {
  it('documents exactly the registered routes', async () => {
    const sim = await startSim();
    const p = await startProxy(sim);
    cleanup = async () => (await p.proxy.stop(), await sim.close());
    expect(documented()).toEqual(registered(p.proxy.app));
  });
});
