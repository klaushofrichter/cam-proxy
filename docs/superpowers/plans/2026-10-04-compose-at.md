# Compositions anchored at a second (#179 phase 3, cam-proxy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, test first. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /api/cameras/{cam}/compositions` accepts `{at, preS, postS, size, badge, timeZone?, dryRun?}` as an alternative to `{clipId, span?}`, so cams can "Save clip around this" second from FTP clips where they cover it and 1 fps stills elsewhere.

**Architecture:** `planComposition` takes `clip` as optional (the window comes from `span`); the API builds the span `{at, at+1000}`, validates `at` and the window, refuses an all-cards plan with 409 `nothing_to_compose`, answers dry runs without a job, rate-limits and audits real requests.

**Spec:** `docs/superpowers/specs/2026-10-04-still-checks-design.md` §4, §13 (rulings 38–47).

## Global Constraints

- Same `compositionWindow` and limits (`COMPOSE_MAX_S` 300, 120 at 1080p); the length table gains `at` cases.
- `at`: safe integer ≥ 0, whole second, ≤ now, ≥ dayStart(now − max(stillsDays, clipsDays)·DAY); rolls 0…3600; window end ≤ now.
- No new dependency; CHANGELOG under `## Unreleased`; stage files explicitly, never `tools/`.

## Tasks

### Task 1: the planner without a clip

**Files:** `src/compose/plan.ts`, `test/compose-plan.test.ts`.

- [ ] Tests: around a second covered by a clip (the clip, cards/stills outside); a window over a clip's edge (stills before, the clip after); stills only; a gap in the stills (cards inside); all cards (the planner still answers; the API refuses); `planSeconds` counts; the length table's `at` cases (0/0 → 1, 10/10 → 21, 149/150 → 300, 150/150 → refused, 1080p 60/59 → 120, 60/60 → refused, negative → refused).
- [ ] Implement `clip?`, `planSeconds`; run; commit.

### Task 2: the API

**Files:** `src/api/compose-api.ts`, `src/proxy.ts` (audit), `test/compose-api.test.ts`.

- [ ] Tests: 400s (both anchors, neither, span with at, at a string / fraction / not a whole second / future / too old, negative roll, window in the future, over 300 s, over 120 s at 1080p); 409 `nothing_to_compose`; dry run counts for a window over a clip edge and for stills only; a real job around a still-only second and around a clip second (encodes, `durationS`); the audit record; the limiter's 429.
- [ ] Implement; run; commit.

### Task 3: docs

**Files:** `openapi.yaml`, `README.md`, `docs/audit-log.md`, `CHANGELOG.md`.

- [ ] Document the body, the answers, the audit record; run `npm test`, `npm run build`, `npm run lint:types`, `npm run check`, e2e; commit.
