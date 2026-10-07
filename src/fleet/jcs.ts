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
