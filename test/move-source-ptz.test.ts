// PTZ positions in a move's plan, on a source alone (plan D Task 4, spec
// 2026-10-30-ptz-capabilities-design §7): the source adds `ptz` when the
// target's answer lists it among the kinds it takes.
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { openCatalog } from '../src/catalog/db';
import { deleteCameraPositions, insertPosition } from '../src/catalog/ptz-positions';
import type { Done } from '../src/fleet/commands';
import { MoveJournal } from '../src/moves/journal';
import { MoveSource, withPositions, type Asker, type SourceDeps } from '../src/moves/source';
import { MOVE_KINDS, type MoveAnswer, type MoveBounds, type MovePlan, type MoveSummary, type Space } from '../src/moves/types';

const TARGET = 'prx_1123456789ABCDEFGHJK';
const M = 'mv_6123456789ABCDEFGHJK';
const RQ = 'rq_0123456789ABCDEFGHJK';
const ADMIN: Asker = { actor: { origin: 'local', label: 'admin' }, user: 'admin' };
const fits: Space = { needed: 10, available: 1000, fits: true, perKind: { clips: 10 }, retentionProposal: null };
const five = ['stills', 'clips', 'events', 'checks', 'archive'] as const;
const summary = Object.fromEntries(five.map((k) => [k, { files: k === 'clips' ? 1 : 0, bytes: k === 'clips' ? 5 : 0, rows: 0, oldest: null, newest: null }])) as unknown as MoveSummary;
const panel: MovePlan = { transfer: true, kinds: ['clips'], space: 'all', targetSettings: null, budgetS: 600, estimateS: 540 };
const T = Date.UTC(2026, 9, 30, 8);

function unit(o: { positions?: number; bounds?: MoveBounds | null } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'camproxy-srcptz-'));
  const catalog = openCatalog(join(dataDir, 'catalog.db'));
  for (let i = 0; i < (o.positions ?? 2); i++) insertPosition(catalog, { id: `pos_000000000000000${i}`, cam: 'cam3', name: `P${i}`, sort_order: i, home: i === 0 ? 1 : 0, slot: i, preset_name: `p${i}`, created_at: T, updated_at: T });
  const j = new MoveJournal(join(dataDir, 'moves'));
  const events: Record<string, any>[] = [];
  const writes: Record<string, any>[] = [];
  const s = new MoveSource({
    journal: j, running: () => ({ tls: { site: 't' }, cameras: {}, cameraOrder: [] }), siteReady: () => true, sendAllowed: () => true,
    emit: (e: unknown) => events.push(e as Record<string, any>), audit: { write: (r: unknown) => writes.push(r as Record<string, any>) },
    proxyId: () => 'prx_0123456789ABCDEFGHJK', inventory: { catalog, dataDir }, certs: () => undefined,
  } as unknown as SourceDeps);
  j.save({ v: 1, id: M, role: 'source', camera: 'cam3', phase: 'opened', plan: null, peer: { proxyId: TARGET, name: '', ip: '192.0.2.20' }, requestId: RQ, bounds: o.bounds ?? null, summary, chunks: {}, bytesDone: 0, startedAt: 1 });
  const answerIt = (a: object) => s.handlers()['move.answer']({ v: 1, moveId: M, requestId: RQ, target: { proxyId: TARGET, name: 'Mini PC' }, accept: true, space: fits, estimateS: 540, ...a }, undefined as never) as Done;
  const approves = () => events.filter((e) => e.kind === 'move.approve');
  return { s, j, events, writes, answerIt, approves, catalog };
}

describe('withPositions', () => {
  const plan: MovePlan = { ...panel };
  it('none, carried, not_taken', () => {
    expect(withPositions(plan, { accept: true, kinds: [...MOVE_KINDS] }, 0)).toEqual({ plan, positions: 'none' });
    expect(withPositions(plan, { accept: true, kinds: [...MOVE_KINDS] }, 3)).toEqual({ plan: { ...plan, kinds: ['clips', 'ptz'] }, positions: 'carried' });
    expect(withPositions(plan, { accept: true } as MoveAnswer, 3)).toEqual({ plan, positions: 'not_taken' });
    expect(withPositions(plan, { accept: true, kinds: ['clips'] }, 3)).toEqual({ plan, positions: 'not_taken' });
  });
});

describe('the source and the ptz kind', () => {
  it('an answer with ptz: the approved plan adds ptz, the move.approve event carries it', () => {
    const u = unit();
    expect(u.answerIt({ kinds: [...MOVE_KINDS] }).status).toBe('ok');
    expect(u.j.load(M)!.answer!.kinds).toEqual([...MOVE_KINDS]);
    expect(u.s.list()[0].positions).toEqual({ count: 2, travel: 'carried' });
    expect(u.s.approve(M, panel, ADMIN).status).toBe(202);
    expect(u.approves()).toEqual([{ kind: 'move.approve', moveId: M, plan: { ...panel, kinds: ['clips', 'ptz'] } }]);
    expect(u.j.load(M)!.plan!.kinds).toEqual(['clips', 'ptz']);
    const w = u.writes.find((x) => x.action === 'move-approve')!;
    expect(w.message).toContain('positions: 2 go with the camera');
    expect(w.details.positions).toBe('carried');
    expect(u.s.list()[0].positions).toEqual({ count: 2, travel: 'carried' });
  });

  it('an answer without kinds: no ptz in the plan, the move-approve record says not_taken', () => {
    const u = unit();
    u.answerIt({});
    expect(u.s.approve(M, panel, ADMIN).status).toBe(202);
    expect(u.approves()[0].plan.kinds).toEqual(['clips']);
    const w = u.writes.find((x) => x.action === 'move-approve')!;
    expect(w.message).toContain('positions stay behind: the target does not take them (2)');
    expect(w.details.positions).toBe('not_taken');
    expect(u.s.list()[0].positions).toEqual({ count: 2, travel: 'not_taken' });
  });

  it("no rows -> plan unchanged, positions 'none'", () => {
    const u = unit({ positions: 0 });
    u.answerIt({ kinds: [...MOVE_KINDS] });
    expect(u.s.approve(M, panel, ADMIN).status).toBe(202);
    expect(u.approves()[0].plan).toEqual(panel);
    const w = u.writes.find((x) => x.action === 'move-approve')!;
    expect(w.message).not.toContain('positions');
    expect(w.details.positions).toBe('none');
  });

  it('approving the same panel plan twice re-sends the event (not already_approved)', () => {
    const u = unit();
    u.answerIt({ kinds: [...MOVE_KINDS] });
    expect(u.s.approve(M, panel, ADMIN).status).toBe(202);
    expect(u.s.approve(M, panel, ADMIN).status).toBe(202);
    expect(u.approves()).toHaveLength(2);
    expect(u.approves()[1].plan.kinds).toEqual(['clips', 'ptz']);
    expect(u.s.approve(M, { ...panel, budgetS: 900 }, ADMIN).status).toBe(409);
  });

  it('the same panel plan again after the positions went: re-sent as approved, not already_approved (final review 4)', () => {
    const u = unit();
    u.answerIt({ kinds: [...MOVE_KINDS] });
    expect(u.s.approve(M, panel, ADMIN).status).toBe(202);
    deleteCameraPositions(u.catalog, 'cam3');
    expect(u.s.approve(M, panel, ADMIN).status).toBe(202);
    expect(u.approves().map((e) => e.plan.kinds)).toEqual([['clips', 'ptz'], ['clips', 'ptz']]);
  });

  it('transfer false with positions: plan kinds [ptz], the manifest lists only the ptz chunk', () => {
    const u = unit();
    u.answerIt({ kinds: [...MOVE_KINDS] });
    const none: MovePlan = { ...panel, transfer: false, kinds: [] };
    expect(u.s.approve(M, none, ADMIN).status).toBe(202);
    const plan = u.approves()[0].plan as MovePlan;
    expect(plan.kinds).toEqual(['ptz']);
    const key = generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const d = u.s.handlers()['move.go']({ v: 1, moveId: M, plan, targetPublicKey: key, expectedLeaf: `SHA256:${'A'.repeat(64)}` }, undefined as never) as Done;
    expect(d.status).toBe('ok');
    expect(u.j.load(M)!.manifest!.map((c) => c.id)).toEqual(['ptz:2026-10-30']);
  });

  it('a panel plan naming ptz is refused (plan.kinds)', () => {
    const u = unit();
    u.answerIt({ kinds: [...MOVE_KINDS] });
    expect(u.s.approve(M, { ...panel, kinds: ['clips', 'ptz'] }, ADMIN)).toEqual({ status: 400, body: { error: 'invalid', detail: 'plan.kinds' } });
  });

  it('auto-approval adds ptz the same way', () => {
    const u = unit({ bounds: { transfer: true, kinds: [...five], space: 'fit', maxBudgetS: 3600 } });
    u.answerIt({ kinds: [...MOVE_KINDS] });
    expect(u.approves()).toHaveLength(1);
    expect(u.approves()[0].plan.kinds).toEqual(['clips', 'ptz']);
    expect(u.writes.find((x) => x.action === 'move-approve')!.details).toMatchObject({ label: 'cams-admin auto-approval', positions: 'carried' });
  });
});
