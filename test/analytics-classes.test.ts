import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { iou, mapObject, summarize } from '../src/analytics/classes';
import type { Found } from '../src/analytics/providers';

const real = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'vision-cam1-2026-09-30.json'), 'utf8')) as Found[];
const box = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });

describe('mapObject', () => {
  it('maps by mid to the spec table, subtype = class name in lower case', () => {
    expect(mapObject({ mid: '/m/01g317', name: 'Person' })).toEqual({ category: 'person', subtype: 'person' });
    expect(mapObject({ mid: '/m/03bt1vf', name: 'Woman' })).toEqual({ category: 'person', subtype: 'woman' });
    expect(mapObject({ mid: '/m/0h2r6', name: 'Van' })).toEqual({ category: 'vehicle', subtype: 'van' });
    expect(mapObject({ mid: '/m/01prls', name: 'Land vehicle' })).toEqual({ category: 'vehicle', subtype: 'land vehicle' });
    expect(mapObject({ mid: '/m/0bt9lr', name: 'Dog' })).toEqual({ category: 'pet', subtype: 'dog' });
    expect(mapObject({ mid: '/m/0jbk', name: 'Animal' })).toEqual({ category: 'pet', subtype: 'animal' });
  });
  it('uses the mid over the name, and the name (any case) when there is no mid', () => {
    expect(mapObject({ mid: '/m/0bt9lr', name: 'Something else' })).toEqual({ category: 'pet', subtype: 'dog' });
    expect(mapObject({ name: 'person' })).toEqual({ category: 'person', subtype: 'person' });
    expect(mapObject({ name: 'CAR' })).toEqual({ category: 'vehicle', subtype: 'car' });
  });
  it('maps nothing outside the table', () => {
    for (const o of [{ mid: '/m/03ldnb', name: 'Ceiling fan' }, { mid: '/m/0199g', name: 'Bicycle' }, { mid: '/m/015p6', name: 'Bird' }, { mid: '/m/0dzct', name: 'Human face' }, { name: 'Baby' }, { name: 'SUV' }]) {
      expect(mapObject(o)).toBeNull();
    }
  });
});

describe('summarize', () => {
  it('reduces the real 15:26 answer to one person with the higher score, and lists the rest as unmapped', () => {
    const { summary, unmapped } = summarize(real);
    expect(summary).toEqual([{ category: 'person', subtype: 'person', score: 0.7380147, box: box(0.1640625, 0.625, 0.23339844, 0.9921875) }]);
    expect(unmapped).toEqual([
      { mid: '/m/03ldnb', name: 'Ceiling fan' },
      { mid: '/m/09j2d', name: 'Clothing' },
      { mid: '/m/02x984l', name: 'Mechanical fan' },
    ]);
  });
  it('merges same-category boxes that overlap by more than 90%, keeping the higher score and its subtype', () => {
    const { summary } = summarize([
      { mid: '/m/04yx4', name: 'Man', score: 0.6, box: box(0.1, 0.1, 0.5, 0.9) },
      { mid: '/m/01g317', name: 'Person', score: 0.8, box: box(0.1, 0.1, 0.51, 0.9) },
    ]);
    expect(summary).toEqual([{ category: 'person', subtype: 'person', score: 0.8, box: box(0.1, 0.1, 0.51, 0.9) }]);
  });
  it('keeps two persons apart when their boxes overlap less', () => {
    const { summary } = summarize([
      { mid: '/m/01g317', name: 'Person', score: 0.8, box: box(0.1, 0.1, 0.3, 0.9) },
      { mid: '/m/01g317', name: 'Person', score: 0.7, box: box(0.5, 0.1, 0.7, 0.9) },
    ]);
    expect(summary.map((s) => s.score)).toEqual([0.8, 0.7]);
  });
  // Review focus 3.
  it('keeps different categories on the same box apart', () => {
    const { summary } = summarize([
      { mid: '/m/01g317', name: 'Person', score: 0.7, box: box(0.1, 0.1, 0.5, 0.9) },
      { mid: '/m/0bt9lr', name: 'Dog', score: 0.6, box: box(0.1, 0.1, 0.5, 0.9) },
    ]);
    expect(summary.map((s) => s.category)).toEqual(['person', 'pet']);
  });
  it('orders by score and handles an empty answer', () => {
    const { summary } = summarize([
      { mid: '/m/0bt9lr', name: 'Dog', score: 0.5, box: box(0, 0, 0.2, 0.2) },
      { mid: '/m/0k4j', name: 'Car', score: 0.9, box: box(0.5, 0.5, 0.9, 0.9) },
    ]);
    expect(summary.map((s) => s.subtype)).toEqual(['car', 'dog']);
    expect(summarize([])).toEqual({ summary: [], unmapped: [] });
  });
  it('iou is 1 for identical boxes, 0 for disjoint and zero-area ones', () => {
    expect(iou(box(0, 0, 1, 1), box(0, 0, 1, 1))).toBe(1);
    expect(iou(box(0, 0, 0.1, 0.1), box(0.5, 0.5, 0.6, 0.6))).toBe(0);
    expect(iou(box(0, 0, 0, 0), box(0, 0, 0, 0))).toBe(0);
  });
});
