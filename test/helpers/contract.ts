import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// The vendored cams-admin contract (test/contract/cams-admin-v1, SOURCE holds
// the cams-admin commit): JSON Schema 2020-12, lenient and strict, fixtures and
// the signature vectors. cam-proxy's messages must pass the strict schemas.
export const CONTRACT = join(__dirname, '..', 'contract', 'cams-admin-v1');
const json = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));

function validators(dir: string): (name: string) => ValidateFunction {
  const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: true });
  const schemas = readdirSync(dir).filter((f) => f.endsWith('.schema.json'));
  for (const f of schemas) ajv.addSchema(json(join(dir, f)) as object);
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
}
export const vectors = json(join(CONTRACT, 'vectors.json')) as Vectors;

export interface Fixture { schema: string; message: unknown; $expect?: { runtime?: string; strict?: string } }
export const fixtures = (): { name: string; f: Fixture }[] =>
  readdirSync(join(CONTRACT, 'fixtures')).filter((n) => n.endsWith('.json')).map((n) => ({ name: n.replace(/\.json$/, ''), f: json(join(CONTRACT, 'fixtures', n)) as Fixture }));

// The first error, readable.
export const why = (v: ValidateFunction): string => (v.errors ?? []).slice(0, 3).map((e) => `${e.instancePath || '/'} ${e.message} ${JSON.stringify(e.params)}`).join('; ');
