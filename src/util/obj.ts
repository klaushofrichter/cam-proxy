// Narrowing helpers for unknown JSON (camera answers, request bodies, stored
// files). Pure.

export type Obj = Record<string, unknown>;

// A plain object (not null, not an array).
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// v when it is a plain object, otherwise {}.
export const objOr = (v: unknown): Obj => (isObj(v) ? v : {});

// The strings (numbers) of a list, anything else dropped; [] when v is no list.
export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
export const numbers = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []);

// Equal as JSON (key order counts).
export const jsonEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
