import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// The vendored cams-admin contract (test/contract/cams-admin-v1, SOURCE holds
// the cams-admin commit): JSON Schema 2020-12, lenient and strict, fixtures and
// the signature vectors. cam-proxy's messages must pass the strict schemas.
export const CONTRACT = join(__dirname, '..', 'contract', 'cams-admin-v1');
const json = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));

// Schemas in the folder and in its commands/ subfolder (P2: command args and
// results, named 'commands/tokens.apply.args'); other subfolders are skipped.
function validators(dir: string): (name: string) => ValidateFunction {
  const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: true });
  const schemaFiles = (d: string) => readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.schema.json')).map((e) => join(d, e.name));
  const sub = join(dir, 'commands');
  const schemas = [...schemaFiles(dir), ...(existsSync(sub) ? schemaFiles(sub) : [])];
  for (const f of schemas) ajv.addSchema(json(f) as object);
  return (name: string) => {
    const s = json(join(dir, `${name}.schema.json`)) as { $id: string };
    return ajv.getSchema(s.$id)!;
  };
}

export const strict = validators(join(CONTRACT, 'strict'));
export const lenient = validators(CONTRACT);

export interface Vectors {
  keys: Record<'proxy' | 'server' | 'other', { seedHex: string; privateKey: string; publicKey: string; fingerprint: string }>;
  signatures: { kind: 'enroll' | 'challenge' | 'hello'; key: 'proxy' | 'server' | 'other'; args: (string | number)[]; text: string; sig: string }[];
  // P2: canonical JSON (RFC 8785) and signed envelopes.
  jcs: { name: string; input: unknown; text: string }[];
  envelopes: { kind: 'command' | 'result' | 'event'; key: 'proxy' | 'server' | 'other'; envelope: Record<string, unknown>; text: string; sig: string }[];
}
export const vectors = json(join(CONTRACT, 'vectors.json')) as Vectors;

// $context (P2 command fixtures): what the receiver knows when it judges the message.
// P3: `journal`, the command journal's entries the journal budget counts.
export interface FixtureContext { now: number; proxyId: string; connId: string; serverKeys: string[]; allow?: string[]; paused?: boolean; seen?: string[]; enabled?: boolean; tokens?: { id: string; kind: 'client' | 'admin'; hash: string; label: string; retireAt: number | null }[]; journal?: { cmdId: string; command: string; at: number; action?: string }[] }
export interface Fixture { schema: string; message: unknown; $context?: FixtureContext; $expect?: { runtime?: string; strict?: string; receiver?: 'proxy' | 'server' } }
export const fixtures = (): { name: string; f: Fixture }[] =>
  readdirSync(join(CONTRACT, 'fixtures')).filter((n) => n.endsWith('.json')).map((n) => ({ name: n.replace(/\.json$/, ''), f: json(join(CONTRACT, 'fixtures', n)) as Fixture }));

// The first error, readable.
export const why = (v: ValidateFunction): string => (v.errors ?? []).slice(0, 3).map((e) => `${e.instancePath || '/'} ${e.message} ${JSON.stringify(e.params)}`).join('; ');

// A command fixture this version can't run yet (the cross-repo rule of the
// P3 contract): skipped and listed, never passed silently. A test asserts
// that nothing is pending once P3 is implemented.
export const pending = (f: Fixture, implemented: ReadonlySet<string>): boolean => {
  const b = (f.message as { body?: { command?: unknown } })?.body;
  return f.schema === 'command' && typeof b?.command === 'string' && !implemented.has(b.command);
};
