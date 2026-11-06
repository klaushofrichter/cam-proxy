import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { cameraNameProblem, nameSaveError } from '../web/src/lib/camera-name';

describe('the Settings camera name field', () => {
  it("validates with the server's rules as you type", () => {
    expect(cameraNameProblem('Backyard Left')).toBeNull();
    expect(cameraNameProblem('Back_yard')).toBe('not allowed: _');
    expect(cameraNameProblem('Den ')).toBe('no leading or trailing space');
  });

  it("shows the 400's reason, an offline camera, or the error code", () => {
    expect(nameSaveError(400, { error: 'invalid_name', reason: 'not allowed by the camera (rspCode -54)' })).toBe('Not saved: not allowed by the camera (rspCode -54)');
    expect(nameSaveError(503, { error: 'camera_offline' })).toBe('Not saved: the camera is offline');
    expect(nameSaveError(502, { error: 'camera_error' })).toBe('Not saved: camera_error');
    expect(nameSaveError(500, null)).toBe('Not saved: HTTP 500');
  });
});

describe('the Status page camera name', () => {
  // config.json's camera name is only the initial name (camera name sync, 2026-11-06): the camera holds the name.
  it("calls a name not yet read from the camera the initial name, not the configured one", () => {
    const page = readFileSync(join(__dirname, '../web/src/pages/Status.svelte'), 'utf8');
    expect(page).toContain('(initial name)');
    expect(page).toContain('not read from the camera yet: the initial name');
    expect(page).not.toMatch(/\(configured\)|the configured name/);
  });
});
