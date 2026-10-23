# Moves started from cams-admin (move.begin) — cam-proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The source proxy accepts a new `move.begin` command from cams-admin. It starts a move the way its own page does and keeps the pre-approval bounds. When the target's answer fits those bounds, it approves its own offer exactly as a click on **Approve move** would.

**Architecture:**
- `move.begin` is a source command under the allow entry `move.send`. Its handler runs `refusal()` and `request()`, the same as `POST /control/moves`.
- The bounds ride on the pending request, the `move.request` event and the journal record.
- The panel's plan logic (`planFrom`, `budgetDefault`, …) moves from `web/src/lib/moves.ts` into a shared `src/moves/plan.ts`, which the web re-exports. A new `autoPlan(bounds, summary, answer)` there builds the panel's plan from the bounds.
- When an accepted answer reaches a bounded record, `MoveSource` calls its own `approve()` with an auto-approval actor. `approve()` checks the plan with `approveProblem`, as for a click. Otherwise the offer waits for a person and the reason is audited.

**Tech Stack:** TypeScript (Node ≥ 26, CommonJS), Express 5, Svelte 5, vitest, the in-process two-proxy move e2e (`test/move-e2e.test.ts`).

**Spec:** cams-admin `docs/superpowers/specs/2026-10-22-operations-and-move-tokens-design.md` §2 and §5 step 2b (cited **S §n**). The controller's rulings R1–R6 below override the spec where they differ.

**Sibling plan:** cams-admin `docs/superpowers/plans/2026-10-23-move-begin-cams-admin.md` (cited **CA Task n**).

**Execution order across repos:** CA Task 1 (contract) merges first. Then **this plan's Task 1**, at once: this repo's `contract-drift` check fails on every PR until the new contract is vendored. Then Tasks 2–5, and a release. CA Tasks 2–4 run in parallel with this plan. CA Task 5 (localstack) needs this plan on main.

## Global Constraints

- Never print, log, audit or send a camera password, the move token, a sealed blob or an X25519 private key. `move.begin` and its result carry none of them (R1).
- Audit detail keys must not end in `key` or contain `token|password|secret` unless they are meant to be redacted.
- Every new audit action literal goes into `src/audit/actions.ts` AUDIT_ACTIONS, `web/src/lib/audit.ts` ACTIONS and a row in `docs/audit-log.md` (`test/audit-actions.test.ts`).
- The Pi path is untouched. Without `tls.site`, `move.begin` answers `failed` `no_site_ca` and emits nothing. `test/pi-compat.test.ts` stays green.
- Approving is still done only by `approve()`. The auto-approval calls it and does not bypass it, so `approveProblem` and `samePlan` stay the only rules.
- The plan rules exist once, in `src/moves/plan.ts`. The web imports them from there, and nothing copies them (R2).
- CHANGELOG.md: lines under `## Unreleased`.
- Real camera only with Klaus's OK, after the localstack passes.

## Rulings

From the controller, as given:
- **R1** New proxy command `move.begin`, cams-admin → source, under allow entry `move.send` (add it to `MOVE_SEND`).
  - Args: `{camera: <proxy camera id>, target: <proxyId>, bounds: {transfer: boolean, kinds: string[], space: <the MovePlan space choices>, maxBudgetS: integer} | null}`.
  - The source runs the same refusal checks and `request()` as `POST /control/moves`, with actor `{origin: 'managed', label: 'cams-admin move'}`. It returns `{requestId}` or a refusal code.
  - The source keeps `bounds` with the pending request and the move record. The camera password stays on the proxy, as today.
- **R2** Auto-approval happens at the source.
  - When the target's answer arrives for a move with non-null bounds, the source builds the plan the UI would build, then calls its own `approve()` with an actor label naming the auto-approval.
  - The plan uses the bounds' transfer, kinds and space, with kinds limited to what exists, and `budgetS = max(estimateS, …)` by the UI's rule.
  - It approves only when the answer accepts and the plan fits: the estimate is ≤ `maxBudgetS`, and the requested space choice is possible.
  - Otherwise the offer waits for a person, exactly as today, and an audit note gives the reason.
  - The UI's plan logic is reused, never forked.
- **R4** cam-proxy re-vendors cams-admin's `contract/v1` (CA Task 1). The contract adds the `move.begin` args and result, and `bounds` on the `move.request` event.
- **R5** cams does not change.
- **R6** Every change has tests, plus one end-to-end move that is approved automatically.

Added while planning (each with why and cost if wrong):
- **B1** `bounds.kinds` narrows the panel's plan.
  - With space `omit`, the kinds with content that are not in `bounds.kinds` become `leaveOut`, and `planFrom` checks that the rest fits.
  - With `all`, `fit` or `retention`, `planFrom` picks every kind with content, and the result is then intersected with `bounds.kinds`. `approveProblem` accepts any subset of the kinds with content for these options.
  - Why: the panel lets you leave kinds out only under `omit`. R2 says the plan uses the bounds' kinds.
  - Cost if wrong: an auto-approved plan with `fit` or `retention` and fewer kinds than a person could click. It stays valid for `approveProblem`.
- **B2** If the answer's space fits (or has no space), every `bounds.space` choice resolves to `all`.
  - Why: a space choice only means something when the content does not fit, and `approveProblem` refuses anything but `all` when it fits.
  - Cost: none.
- **B3** The budget is `transfer ? min(budgetDefault(estimateS) * 60, maxBudgetS) : estimateS`. This is the panel's rule (whole minutes, at least the estimate), capped at `maxBudgetS`. Since the estimate is ≤ `maxBudgetS`, the result is never below the estimate.
  - Cost if wrong: a budget a few seconds below the panel's rounded minute.
- **B4** The check that the estimate is ≤ `maxBudgetS` also applies when `transfer` is false. cams-admin's estimate counts every kind, even when nothing is copied.
  - Cost: a caller with `transfer: false` sets a generous `maxBudgetS`.
- **B5** The reasons an offer is left for a person form a closed list, `AutoWaitReason = 'over_budget' | 'space' | 'no_estimate' | 'not_allowed' | 'plan'`:
  - `not_allowed`: `hostRefusal()` is non-null;
  - `plan`: `approve()` refused the plan, with its detail.

  The reason is audited as the new action `move-auto-approve` (outcome `failure`), kept on the record as `autoApproval`, and shown in the panel. cams-admin does not learn the reason in this step: it sees `awaiting-approval` with `autoApprove: true`.
  - Cost if wrong: a contract addition later if cams-admin should show the reason.
- **B6** A rejected answer (`accept: false`) writes no `move-auto-approve` note. The existing rejected path covers it.
- **B7** After every welcome, the source sends `move.approve` again for each source record still `opened` with a plan, whether a person or the auto-approval approved it. cams-admin ignores the same plan again (`samePlan` in its `onApprove`).
  - Why: with nobody to click again, a lost `move.approve` event would leave the move waiting until the 30-minute expiry.
  - Cost: one repeated event per welcome while a move is approved and not started.
- **B8** `move.begin` gives the refusal as status `failed` with the refusal as the code: `no_site_ca`, `external_cert`, `moves_not_allowed`, `busy` or `unknown_camera`. That list is cams-admin's `MOVE_BEGIN_REFUSALS`.
- **B9** The `move.request` event always carries `bounds` (null for a page request). The contract has the field optional, so cams-admin still accepts proxies that are not yet updated (CA A1). The test here pins that it is always sent.
- **B10** The auto-approval actor is `{origin: 'managed', label: 'cams-admin auto-approval'}` with user `cams-admin`. The request actor is `{origin: 'managed', label: 'cams-admin move'}` with user `cams-admin` (R1).

## Review Focus

1. The answer arrives before `move.open` (the pending request keeps it, `answer()` :728): the auto-approval still happens, once, when `open()` creates the record. Task 4 `answer before open is approved at open`.
2. The connection drops just after the auto-approval emitted `move.approve`: it is sent again after the next welcome, and approving twice writes one record. Task 4 `approval re-sent after welcome`.
3. The local admin removes `move.send` between `move.begin` and the answer: no approval, a `move-auto-approve` note with reason `not_allowed`, and the offer waits. Task 4 `no move.send at answer time waits`.
4. `move.begin` for a camera that is hidden (`moved`) or unknown: `failed` `unknown_camera`, no event, no audit `move-request`. Task 3 `begin for an unknown or hidden camera`.
5. The estimate equals `maxBudgetS` exactly: approved, with `budgetS === maxBudgetS`. Task 2 `estimate equal to maxBudgetS`.

---

### Task 1: Re-vendor the contract; `move.begin` in the policy and the validators

**Files:**
- Copy: cams-admin `contract/v1` → `test/contract/cams-admin-v1/` (update `SOURCE` to the cams-admin commit, `(contract/v1, main)`)
- Modify: `src/fleet/policy.ts` (`MOVE_SEND` :35 gets `'move.begin'`; `IMPLEMENTED` and `MOVE_COMMANDS` follow from it)
- Modify: `src/moves/types.ts` (`MoveBounds`; the `move.request` member of `MoveEvent` gets `bounds: MoveBounds | null`)
- Modify: `src/fleet/command-args.ts` (`MoveBeginArgs`, `validateMoveBegin`, an `ARGS_VALIDATORS` entry, `boundsProblem`)
- Modify: `src/moves/source.ts` `request()`: emit `bounds: null` for now (B9), so the event matches the strict schema
- Test: `test/fleet-move-contract.test.ts`

**Interfaces:**
- Produces:
  - `export interface MoveBounds { transfer: boolean; kinds: MoveKind[]; space: MoveSpacePlan; maxBudgetS: number }` in `src/moves/types.ts`.
  - `export interface MoveBeginArgs { v: 1; camera: string; target: string; bounds: MoveBounds | null }`.
  - `export const validateMoveBegin: (a: unknown) => ArgsVerdict<MoveBeginArgs>`. Its detail codes: `camera` (not `idLike`), `target` (not `PRX_ID`), `bounds` (not null and not closed `{transfer, kinds, space, maxBudgetS}`, kinds not unique ⊂ `MOVE_KINDS`, space not in `SPACE_PLANS`, `maxBudgetS` not an integer 60..604800).
  - `export const boundsProblem: (b: unknown) => string | null`, for Task 3.
  - `entryFor('move.begin', …) === 'move.send'`.

- [ ] **Step 1: Write the failing tests** in `test/fleet-move-contract.test.ts`:
  - The existing `every move fixture validates against IMPLEMENTED (no pending fixtures)` now covers `valid-command-move-begin`, `valid-command-move-begin-no-bounds` and `refused-move-begin-not-allowed`. It must pass unchanged once the validator and the entry exist.
  - Extend `the entry each command needs`: `expect(entryFor('move.begin', {})).toBe('move.send')`.
  - Extend `the validators agree with the strict schemas on the fixtures and refuse their mutations` with `move.begin` mutations: `maxBudgetS: 59`, `604801`, `1.5`; `kinds: ['clips','clips']`; `kinds: ['video']`; `space: 'some'`; an extra key in `bounds`; `target: 'prx_short'`. Each is refused by both strict and `validateMoveBegin`, and the detail is `bounds` or `target`.
  - Change `the handlers: one per command name, each a stub answering failed/internal` to expect 10 names, `move.begin` among them.
  - New: `the move.request event with bounds null and with bounds is valid on the strict schema`.
- [ ] **Step 2: Run** `npx vitest run test/fleet-move-contract.test.ts`. Expected: FAIL (`move.begin` is not implemented, and the fixtures disagree).
- [ ] **Step 3: Implement** the vendored copy, `MOVE_SEND`, the types, the validator and the `bounds: null` in `request()`.
- [ ] **Step 4: Run** `npm test && scripts/contract-drift.sh`. Expected: PASS, and `contract/v1 matches cams-admin origin/main`. The tests that list commands (`fleet-control`, `fleet-config`, `managed-ui-unlock`, `pi-compat`, `fleet-isolation`) are updated where they count the commands.
- [ ] **Step 5: Commit** `feat(moves): move.begin in the contract, the allow list and the validators`. Merge when all checks pass. cams-admin's cross-check then runs the `move.begin` fixtures strictly.

### Task 2: One home for the panel's plan rules; `autoPlan`

**Files:**
- Create: `src/moves/plan.ts`
- Modify: `web/src/lib/moves.ts`. `budgetDefault`, `estimateText`, `hasContent`, `kindsWithContent`, `spaceOptions`, `MoveForm` and `planFrom` move to `src/moves/plan.ts`, and this file re-exports them under the same names. `KINDS` moves too; `KIND_LABEL` stays here.
- Test: `test/move-plan.test.ts` (new). `test/move-ui-lib.test.ts` stays unchanged and green.

**Interfaces:**
- Produces, in `src/moves/plan.ts`. It has no Node imports, because the web bundle imports it.
  - `export const KINDS: readonly MoveKind[]`
  - `budgetDefault(estimateS: number): number`
  - `estimateText(s: number): string`
  - `hasContent(s, k)`
  - `kindsWithContent(s): MoveKind[]`
  - `spaceOptions(space)`
  - `interface MoveForm`
  - `planFrom(f: MoveForm): { plan: MovePlan | null; error: string | null }`. These are the same signatures and bodies as today.
  - `export type AutoWaitReason = 'over_budget' | 'space' | 'no_estimate' | 'not_allowed' | 'plan'`
  - `export function autoPlan(b: MoveBounds, summary: MoveSummary, answer: MoveAnswer): { plan: MovePlan } | { reason: AutoWaitReason }`. It needs `answer.accept === true`; the caller checks that.

How `autoPlan` decides, in this order (B1–B4):
1. If `answer.estimateS` is undefined → `no_estimate`.
2. If `estimateS > b.maxBudgetS` → `over_budget`.
3. Let `fits = !answer.space || answer.space.fits`.
4. If `b.transfer && !fits && b.space === 'all'` → `space`.
5. Call `planFrom` with:
   - `transfer: b.transfer`;
   - `leaveOut: kindsWithContent(summary).filter((k) => !b.kinds.includes(k))`;
   - `option: fits ? 'fit' : b.space` (`'fit'` is never read when it fits);
   - `budgetMin: (b.transfer ? Math.min(budgetDefault(estimateS) * 60, b.maxBudgetS) : estimateS) / 60`;
   - `estimateS`, `summary`, `space: answer.space`.
6. If `planFrom` returns an error → `space`.
7. For any space other than `omit`, set `plan.kinds = plan.kinds.filter((k) => b.kinds.includes(k))`.

- [ ] **Step 1: Write the failing tests** in `test/move-plan.test.ts`. They use the fixtures of `test/move-ui-lib.test.ts`: `summary` (stills 10 files 4 GiB, clips 5 files 2 GiB, archive 1 file 1 GiB, events and checks empty) and `tight` (needed 7 GiB, available 3 GiB, proposal `{'stills.maxGB': 90, 'storage.maxBytes': 200 GiB}`). Two answers: `fitsA = {accept: true, space: {needed: 7 GiB, available: 100 GiB, fits: true, perKind: {}, retentionProposal: null}, estimateS: 540}` and `tightA = {accept: true, space: tight, estimateS: 540}`.

```ts
const all5 = ['stills', 'clips', 'events', 'checks', 'archive'] as MoveKind[];
it('fits: all kinds with content, space all, budget the rounded estimate', () =>
  expect(autoPlan({ transfer: true, kinds: all5, space: 'fit', maxBudgetS: 3600 }, summary, fitsA))
    .toEqual({ plan: { transfer: true, kinds: ['stills', 'clips', 'archive'], space: 'all', targetSettings: null, budgetS: 540, estimateS: 540 } }));
it('bounds kinds narrow the plan', () =>
  expect((autoPlan({ transfer: true, kinds: ['clips'], space: 'fit', maxBudgetS: 3600 }, summary, fitsA) as any).plan.kinds).toEqual(['clips']));
it('over the budget waits', () =>
  expect(autoPlan({ transfer: true, kinds: all5, space: 'fit', maxBudgetS: 539 }, summary, fitsA)).toEqual({ reason: 'over_budget' }));
it('estimate equal to maxBudgetS', () => // Review Focus 5
  expect((autoPlan({ transfer: true, kinds: all5, space: 'fit', maxBudgetS: 540 }, summary, fitsA) as any).plan.budgetS).toBe(540));
it('the rounded budget is capped at maxBudgetS', () =>
  expect((autoPlan({ transfer: true, kinds: all5, space: 'fit', maxBudgetS: 560 }, summary, { ...fitsA, estimateS: 541 }) as any).plan.budgetS).toBe(560));
it('tight + omit leaving stills out fits exactly', () =>
  expect((autoPlan({ transfer: true, kinds: ['clips', 'archive'], space: 'omit', maxBudgetS: 3600 }, summary, tightA) as any).plan)
    .toMatchObject({ kinds: ['clips', 'archive'], space: 'omit', targetSettings: null }));
it('tight + omit that still does not fit waits', () =>
  expect(autoPlan({ transfer: true, kinds: ['stills'], space: 'omit', maxBudgetS: 3600 }, summary, tightA)).toEqual({ reason: 'space' }));
it('tight + all waits', () =>
  expect(autoPlan({ transfer: true, kinds: all5, space: 'all', maxBudgetS: 3600 }, summary, tightA)).toEqual({ reason: 'space' }));
it('tight + retention takes the proposal', () =>
  expect((autoPlan({ transfer: true, kinds: all5, space: 'retention', maxBudgetS: 3600 }, summary, tightA) as any).plan)
    .toMatchObject({ space: 'retention', targetSettings: { 'stills.maxGB': 90, 'storage.maxBytes': 200 * 1024 ** 3 } }));
it('tight + retention without a proposal waits', () =>
  expect(autoPlan({ transfer: true, kinds: all5, space: 'retention', maxBudgetS: 3600 }, summary, { ...tightA, space: { ...tight, retentionProposal: null } })).toEqual({ reason: 'space' }));
it('no transfer: no kinds, budget the estimate', () =>
  expect(autoPlan({ transfer: false, kinds: [], space: 'all', maxBudgetS: 3600 }, summary, fitsA))
    .toEqual({ plan: { transfer: false, kinds: [], space: 'all', targetSettings: null, budgetS: 540, estimateS: 540 } }));
it('no estimate waits', () =>
  expect(autoPlan({ transfer: true, kinds: all5, space: 'fit', maxBudgetS: 3600 }, summary, { accept: true, space: fitsA.space })).toEqual({ reason: 'no_estimate' }));
it('every plan autoPlan returns passes approveProblem', () => {
  // all four spaces × transfer true/false × kinds {all5, ['clips'], []} × {fitsA, tightA}
  for (const c of cases) { const r = autoPlan(c.b, summary, c.a); if ('plan' in r) expect(approveProblem(r.plan, summary, c.a)).toBeNull(); }
});
it('the web lib re-exports the same functions', () => expect(webPlanFrom).toBe(planFrom)); // import { planFrom as webPlanFrom } from '../web/src/lib/moves'
```

- [ ] **Step 2: Run** `npx vitest run test/move-plan.test.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Implement.** Move the functions without changing their bodies, re-export them from `web/src/lib/moves.ts`, and add `autoPlan`.
- [ ] **Step 4: Run** `npm test && npm run lint:types && npm run build:web && npm run check`. Expected: PASS. `test/move-ui-lib.test.ts` passes unchanged, and the web bundle builds.
- [ ] **Step 5: Commit** `refactor(moves): the panel's plan rules in src/moves/plan.ts; autoPlan`.

### Task 3: The `move.begin` handler; the bounds go with the request

**Files:**
- Modify: `src/moves/source.ts`:
  - `Pending` gets `bounds: MoveBounds | null`;
  - `request(cam, target, who, bounds: MoveBounds | null = null)` puts `bounds` on the pending request, the `move.request` event and the `move-request` audit detail (`bounds`, `autoApprove: bounds !== null`);
  - `open()` copies `bounds` into the record;
  - `MoveView` gets `bounds`;
  - `list()` fills it;
  - new `begin(a: MoveBeginArgs): Done`;
  - `handlers()` gets `'move.begin': guard((a: MoveBeginArgs) => this.begin(a))`;
  - exports `BEGIN_ASKER` and `AUTO_ASKER`.
- Modify: `src/moves/journal.ts` (`MoveRecord.bounds?: MoveBounds | null`; `MoveRecord.autoApproval?: { state: 'approved' | 'waiting'; reason?: AutoWaitReason; at: number }`)
- Modify: `openapi.yaml` (the `GET /control/moves` summary :968 lists `bounds`, `autoApproval?`)
- Test: `test/move-source.test.ts`

**Interfaces:**
- Consumes: `MoveBeginArgs`, `MoveBounds` (Task 1); `AutoWaitReason` (Task 2).
- Produces:
  - `export const BEGIN_ASKER: Asker = { actor: { origin: 'managed', label: 'cams-admin move' }, user: 'cams-admin' }`
  - `export const AUTO_ASKER: Asker = { actor: { origin: 'managed', label: 'cams-admin auto-approval' }, user: 'cams-admin' }`
  - `MoveSource.begin(a)`: `const why = this.refusal(a.camera)`. If `why` is set → `failed(why)`. Otherwise `ok({ requestId: this.request(a.camera, a.target, BEGIN_ASKER, a.bounds).requestId })`.
  - `MoveView.bounds: MoveBounds | null`, `MoveView.autoApproval?: { state; reason? }`.

- [ ] **Step 1: Write the failing tests** in `test/move-source.test.ts`, in a new `describe('move.begin (cams-admin starts a move)')`:
  - `begin emits move.request with the bounds and answers the requestId`:
    - The result is `{status: 'ok', result: {requestId}}`, and `requestId` matches `/^rq_[0-9A-HJKMNP-TV-Z]{20}$/`.
    - One `move.request` event has `bounds` equal to the args' bounds and `actor` `{origin: 'managed', label: 'cams-admin move'}`.
    - The `move-request` audit has `user: 'cams-admin'` and `details.autoApprove === true`.
  - `begin with bounds null is a plain request`: the event has `bounds: null`.
  - `a page request sends bounds null` (B9): `POST /control/moves` → the event has the key `bounds` with value `null`.
  - `begin is refused like the page`: with no `tls.site` → `failed` `no_site_ca`; a camera with `tlsName` → `external_cert`; without `move.send` → `moves_not_allowed`; a journal with an active move → `busy`. In every case no event and no `move-request` audit.
  - `begin for an unknown or hidden camera` (Review Focus 4): an unknown id, and a camera with `moved` set → `failed` `unknown_camera`, no event.
  - `open keeps the bounds in the record; list shows them`: after `move.open`, `journal.load(id).bounds` equals the bounds, and `GET /control/moves` items carry `bounds`.
  - `no password or token in a begin event or record`: extend the existing check (`no password, move token or public key in any event or audit record`) to cover the begin path.
- [ ] **Step 2: Run** `npx vitest run test/move-source.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS (`openapi.test.ts` included).
- [ ] **Step 5: Commit** `feat(moves): move.begin starts a move on the source and keeps its bounds`.

### Task 4: Auto-approval at the source

**Files:**
- Modify: `src/moves/source.ts`:
  - new `private autoApprove(r: MoveRecord): void`. It is called from `answer()` after an accepted answer is saved on the record (:723–726), and from `open()` after `journal.save(r)` when the pending request already held an accepted answer (:698).
  - new `reemitApprovals(): void` (B7).
  - `list()` fills `autoApproval`.
- Modify: `src/proxy.ts` (`camsAdmin.onWelcome` :1064 also calls `moveSource.reemitApprovals()`)
- Modify: `src/audit/actions.ts`, `web/src/lib/audit.ts`, `docs/audit-log.md` (the action `move-auto-approve`)
- Modify: `web/src/lib/moves.ts` (`autoWaitText(reason: AutoWaitReason): string`, `MoveItem.bounds`, `MoveItem.autoApproval`), `web/src/components/MovePanel.svelte` (one line with `data-testid="move-auto-wait"` when `autoApproval?.state === 'waiting'`)
- Test: `test/move-source.test.ts`, `test/move-ui-lib.test.ts`

**Interfaces:**
- Consumes: `autoPlan` (Task 2); `AUTO_ASKER`, `MoveRecord.bounds` (Task 3); `approve()`, `hostRefusal()` (unchanged).
- Produces:
  - `autoApprove(r)` does nothing when any of these holds: `!r.bounds`, `r.plan`, `!r.answer?.accept`, `r.autoApproval`. Otherwise it decides in this order:
    1. `hostRefusal()` non-null → wait with reason `not_allowed`;
    2. `autoPlan(r.bounds, r.summary ?? summarize(...), r.answer)` returns a reason → wait with that reason;
    3. `approve(r.id, plan, AUTO_ASKER)` answers non-202 → wait with reason `plan` and the detail.

    On success it sets `autoApproval = {state: 'approved', at}`.
  - Waiting sets `autoApproval = {state: 'waiting', reason, at}`, saves the record, and writes one audit record. `approve()` writes no record for an auto-approval that did not happen. The audit record:
    - `action 'move-auto-approve'`, `outcome 'failure'`, `user 'cams-admin'`, `camera`;
    - message: `Camera move <id> (<cam> to <target>): not approved automatically (<reason>); waiting for approval here`;
    - details: `{moveId, camera, source, target, role: 'source', reason, detail?, bounds, estimateS}`.
  - `reemitApprovals()`: for each source record with `phase === 'opened' && plan`, emit `{kind: 'move.approve', moveId, plan}`.
  - The panel line copy, exactly:

```ts
autoWaitText('over_budget') === 'Started from cams-admin; not approved automatically: the estimate is over the time budget cams-admin allowed. Approve it here or cancel.'
autoWaitText('space')       === "Started from cams-admin; not approved automatically: the content doesn't fit the way cams-admin allowed. Approve it here or cancel."
autoWaitText('no_estimate') === 'Started from cams-admin; not approved automatically: the target gave no estimate. Approve it here or cancel.'
autoWaitText('not_allowed') === "Started from cams-admin; not approved automatically: sending cameras away isn't allowed here right now. Approve it here or cancel."
autoWaitText('plan')        === 'Started from cams-admin; not approved automatically: the plan did not fit the answer. Approve it here or cancel.'
```

- [ ] **Step 1: Write the failing tests** in `test/move-source.test.ts`, in a new `describe('auto-approval within bounds (R2)')`. Use the existing fake-admin helpers: `move.begin` → `move.open` → `move.answer`.
  - `an accepted answer within bounds approves at once`:
    - Answer `{accept: true, space: fits, estimateS: 540}`, bounds `{transfer: true, kinds: all5, space: 'fit', maxBudgetS: 3600}`.
    - Exactly one `move.approve` event, whose plan equals `autoPlan(...)`'s plan.
    - The record has `plan` set and `autoApproval.state === 'approved'`.
    - One `move-approve` audit has `details.label === 'cams-admin auto-approval'` and `details.origin === 'managed'`.
    - No `move-auto-approve` audit.
  - `go accepts the auto-approved plan`: a following `move.go` with that plan → `ok`, phase `switching`.
  - `over the budget waits for a person`:
    - With `maxBudgetS: 300` there is no `move.approve`.
    - One `move-auto-approve` audit has `reason: 'over_budget'`, and `GET /control/moves` shows `autoApproval: {state: 'waiting', reason: 'over_budget'}`.
    - A manual `POST /control/moves/:id/approve` with a valid plan still → 202.
  - `a space choice that is not possible waits` (tight answer, `space: 'all'`): reason `space`.
  - `no move.send at answer time waits` (Review Focus 3): `sendAllowed` false at answer time → reason `not_allowed`, no `move.approve`.
  - `answer before open is approved at open` (Review Focus 1): `move.answer` first (pending), then `move.open`. Exactly one `move.approve`, emitted after `open`.
  - `a repeated answer does not approve twice`: the same `move.answer` again → still one `move.approve` and one `move-approve` audit.
  - `a rejected answer writes no auto-approval note` (B6): `accept: false`. No `move-auto-approve` audit and no `move.approve`.
  - `bounds null never approves`: a page-started request with an accepted answer → no `move.approve`, and no `autoApproval` in the record.
  - `approval re-sent after welcome` (Review Focus 2): after an auto-approval, `reemitApprovals()` (and the welcome hook in `test/fleet-move-contract.test.ts` `onWelcome runs after every welcome…`) emits `move.approve` with the same plan once per call. A record in `switching` emits none.
  - `move-ui-lib`: the five `autoWaitText` strings above.
- [ ] **Step 2: Run** `npx vitest run test/move-source.test.ts test/move-ui-lib.test.ts test/audit-actions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `autoApprove`, the two call sites, `reemitApprovals` and its wiring, the audit action (all three lists) and the panel line.
- [ ] **Step 4: Run** `npm test && npm run check` (svelte-check). Expected: PASS.
- [ ] **Step 5: Commit** `feat(moves): the source approves its own offer within cams-admin's bounds`.

### Task 5: End to end, docs, CHANGELOG

**Files:**
- Modify: `test/move-e2e.test.ts` (a second `it`)
- Modify: `docs/camera-move.md`:
  - "Starting one": a paragraph "Started from cams-admin". It covers `move.begin` under `move.send`, and the bounds and when they approve: estimate within `maxBudgetS`, the space choice possible, kinds limited to what exists, the budget being the panel's.
  - Otherwise the offer waits on the panel with the reason.
  - "Approving is the only approval" becomes "Approving here, or the auto-approval within the bounds cams-admin started the move with, is the only approval".
  - "In the audit log": `move-auto-approve`.
- Modify: `CHANGELOG.md` `## Unreleased`, with the line: "Camera moves can be started by cams-admin (new command `move.begin`, under `move.send`). With bounds from cams-admin, the source approves its own offer when the target's answer fits them (estimate within the time budget, the space choice possible); otherwise the offer waits on the panel with the reason (`move-auto-approve` in the audit log)."
- Test: `test/move-e2e.test.ts`

- [ ] **Step 1: Write the failing test** `an auto-approved move started by move.begin ends done`. It uses the same two proxies and sim as `moves cam3 with its content from the source to the target`, with the scripted cams-admin relaying in the CA order. The steps:
  - send `move.begin {v: 1, camera: 'cam3', target: <target proxyId>, bounds: {transfer: true, kinds: all5, space: 'fit', maxBudgetS: 3600}}` to the source;
  - relay `move.request` → `move.open` / `move.offer` → `move.answer`;
  - **the test never calls approve**. It waits for the source's `move.approve` event and relays `move.start` / `move.go` from it;
  - then the rest as in the existing test, until `done`.

  Its assertions:
  - the `move.begin` result validates against the strict `move.begin.result` schema;
  - every event validates against the strict event schema, including `move.request` with `bounds`;
  - the source's `move-approve` audit has `label: 'cams-admin auto-approval'`;
  - the target serves cam3 and its copied days, and the source has none left (the existing helpers);
  - the source's move actions contain `move-request`, `move-approve`, `move-switch`, `move-done`, and do not contain `move-auto-approve`.
- [ ] **Step 2: Run** `npx vitest run test/move-e2e.test.ts`. Expected: it FAILS before Task 4 is on the branch and PASSES after. On a branch that already has Tasks 1–4, run it once to see it pass.
- [ ] **Step 3: Write** the docs and the CHANGELOG line.
- [ ] **Step 4: Run** `npm test && scripts/contract-drift.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `test(moves): an auto-approved move end to end; docs`. Release when all checks pass, then update the proxies (Pi: pull + up -d), which unblocks CA Task 5.
