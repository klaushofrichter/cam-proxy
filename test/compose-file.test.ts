import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// The Pi's compose.yaml (pi-config spec §5, security review): the container
// can write config/.env, so nothing in compose.yaml may come from it.
const text = readFileSync(join(__dirname, '..', 'compose.yaml'), 'utf8');
const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

describe('compose.yaml', () => {
  it('has no ${…} substitution outside comments', () => {
    expect(code).not.toMatch(/\$\{|\$[A-Za-z_]/);
  });
  it('reads config/.env, mounts ./data and ./config only, and names the env file', () => {
    expect(code).toMatch(/^\s+env_file: config\/\.env$/m);
    expect(code).toMatch(/^\s+CAMPROXY_ENV_FILE: \/config\/\.env$/m);
    const volumes = [...code.matchAll(/^\s+- (\S+)$/gm)].map((m) => m[1]);
    expect(volumes).toEqual(['./data:/data', './config:/config']);
  });
});
