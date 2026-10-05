import type { Box, Found } from './providers';

// Which of Google's objects count, and as what (spec
// 2026-09-30-analytics-in-cams-design, "The classes"). Vision's object classes
// match the Open Images boxable classes by id (docs/analytics-classes.md), so
// objects map by `mid`; the name is a fallback when an answer has no mid.
type Category = 'person' | 'vehicle' | 'pet';
export interface SummaryEntry { category: Category; subtype: string; score: number; box: Box }

const TABLE: { mid: string; name: string; category: Category }[] = [
  { mid: '/m/01g317', name: 'Person', category: 'person' },
  { mid: '/m/04yx4', name: 'Man', category: 'person' },
  { mid: '/m/03bt1vf', name: 'Woman', category: 'person' },
  { mid: '/m/01bl7v', name: 'Boy', category: 'person' },
  { mid: '/m/05r655', name: 'Girl', category: 'person' },
  { mid: '/m/0k4j', name: 'Car', category: 'vehicle' },
  { mid: '/m/07r04', name: 'Truck', category: 'vehicle' },
  { mid: '/m/0h2r6', name: 'Van', category: 'vehicle' },
  { mid: '/m/01bjv', name: 'Bus', category: 'vehicle' },
  { mid: '/m/0pg52', name: 'Taxi', category: 'vehicle' },
  { mid: '/m/012n7d', name: 'Ambulance', category: 'vehicle' },
  { mid: '/m/01lcw4', name: 'Limousine', category: 'vehicle' },
  { mid: '/m/04_sv', name: 'Motorcycle', category: 'vehicle' },
  { mid: '/m/0323sq', name: 'Golf cart', category: 'vehicle' },
  { mid: '/m/01prls', name: 'Land vehicle', category: 'vehicle' },
  { mid: '/m/07yv9', name: 'Vehicle', category: 'vehicle' },
  { mid: '/m/0bt9lr', name: 'Dog', category: 'pet' },
  { mid: '/m/01yrx', name: 'Cat', category: 'pet' },
  { mid: '/m/0jbk', name: 'Animal', category: 'pet' },
  { mid: '/m/04rky', name: 'Mammal', category: 'pet' },
  { mid: '/m/01lrl', name: 'Carnivore', category: 'pet' },
];
const BY_MID = new Map(TABLE.map((t) => [t.mid, t]));
const BY_NAME = new Map(TABLE.map((t) => [t.name.toLowerCase(), t]));
const MERGE_IOU = 0.9;

export function mapObject(o: { mid?: string; name: string }): { category: Category; subtype: string } | null {
  const t = (o.mid && BY_MID.get(o.mid)) || (!o.mid ? BY_NAME.get(o.name.trim().toLowerCase()) : undefined);
  return t ? { category: t.category, subtype: t.name.toLowerCase() } : null;
}

export function iou(a: Box, b: Box): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  const inter = w > 0 && h > 0 ? w * h : 0;
  const area = (x: Box) => Math.max(0, x.x1 - x.x0) * Math.max(0, x.y1 - x.y0);
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

// Persons, vehicles and pets only; same-category boxes overlapping by more
// than 90% merge (the higher score, with its subtype and box, wins); highest
// score first. Objects that don't map are returned for the unmapped count.
export function summarize(objects: Found[]): { summary: SummaryEntry[]; unmapped: { mid: string; name: string }[] } {
  const unmapped: { mid: string; name: string }[] = [];
  const mapped: SummaryEntry[] = [];
  for (const o of objects) {
    const m = mapObject(o);
    if (!m) unmapped.push({ mid: o.mid ?? '', name: o.name });
    else mapped.push({ category: m.category, subtype: m.subtype, score: o.score, box: o.box });
  }
  const summary: SummaryEntry[] = [];
  for (const e of [...mapped].sort((a, b) => b.score - a.score)) {
    if (!summary.some((s) => s.category === e.category && iou(s.box, e.box) > MERGE_IOU)) summary.push(e);
  }
  return { summary, unmapped };
}

// For audit records (still checks, automatic analyses): the categories found,
// and a short text such as "person 80%, vehicle 61%".
type Named = { category?: unknown; score?: unknown };
export const summaryCategories = (summary: unknown[]): string[] => [...new Set(summary.map((s) => (s as Named)?.category).filter((c): c is string => typeof c === 'string'))];
export const summaryText = (s: unknown[]): string =>
  s.length ? s.map((e) => `${String((e as Named).category)} ${Math.round(Number((e as Named).score) * 100)}%`).join(', ') : 'nothing relevant';
