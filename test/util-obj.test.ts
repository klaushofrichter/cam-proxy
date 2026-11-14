import { describe, expect, it } from 'vitest';
import { isObj, jsonEqual, numbers, objOr, strings } from '../src/util/obj';

describe('util/obj', () => {
  it('isObj accepts plain objects only', () => {
    expect(isObj({})).toBe(true);
    expect(isObj({ a: 1 })).toBe(true);
    expect(isObj([])).toBe(false);
    expect(isObj(null)).toBe(false);
    expect(isObj('x')).toBe(false);
    expect(isObj(undefined)).toBe(false);
  });
  it('objOr returns the object or {}', () => {
    const o = { a: 1 };
    expect(objOr(o)).toBe(o);
    expect(objOr([1])).toEqual({});
    expect(objOr(null)).toEqual({});
  });
  it('strings and numbers keep only their kind', () => {
    expect(strings(['a', 1, null, 'b'])).toEqual(['a', 'b']);
    expect(strings('a')).toEqual([]);
    expect(numbers([1, '2', 3, NaN])).toEqual([1, 3, NaN]);
    expect(numbers(undefined)).toEqual([]);
  });
  it('jsonEqual compares as JSON', () => {
    expect(jsonEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
    expect(jsonEqual(undefined, undefined)).toBe(true);
  });
});
