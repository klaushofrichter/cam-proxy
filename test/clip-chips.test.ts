import { describe, expect, it } from 'vitest';
import { clipChips } from '../web/src/lib/chips';

// Klaus, 2026-09-30: a clip that covers several events of one kind shows
// that kind once, with a count ("motion ×3"); AI kinds first.
describe('clipChips', () => {
  const kinds = { 1: 'motion', 2: 'motion', 3: 'person', 4: 'motion', 5: 'vehicle' };
  it('lists each kind once with its count, AI kinds first', () => {
    expect(clipChips([1, 2, 3, 4, 5], kinds)).toEqual(['person', 'vehicle', 'motion ×3']);
  });
  it('shows a single event without a count', () => {
    expect(clipChips([1], kinds)).toEqual(['motion']);
  });
  it('names events it has no kind for "event"', () => {
    expect(clipChips([9, 9, 1], kinds)).toEqual(['motion', 'event ×2']);
  });
  it('is empty without events', () => {
    expect(clipChips([], kinds)).toEqual([]);
  });
});
