import { writable } from 'svelte/store';
import { api } from './api';
import type { MoveItem } from './moves';

// The moves GET /control/moves lists (source side); empty on a proxy without them.
export const moves = writable<MoveItem[]>([]);
export async function loadMoves(): Promise<MoveItem[]> {
  try {
    const items = (await api<{ items: MoveItem[] }>('GET', '/control/moves')).items;
    moves.set(items);
    return items;
  } catch {
    return [];
  }
}
