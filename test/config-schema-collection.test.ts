import { describe, expect, it } from 'vitest';
import { CAMERA_ID, CAMERA_NODE, checkPartial, collection, jsonSchema, leafAt, leafPaths, LEGACY_CAMERA, SettingError, type Node } from '../src/config/schema';

const TREE: Node = {
  sse: { pingS: { type: 'integer', min: 1, max: 300, doc: 'ping' } },
  cams: collection({ id: { type: 'string', pattern: CAMERA_ID, doc: 'id' }, n: { type: 'integer', min: 1, max: 9, doc: 'n' } }, 'the cameras'),
};
const msg = (f: () => void) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(SettingError);
    return (e as Error).message;
  }
  throw new Error('expected a SettingError');
};

describe('keyed collection (spec §4.1)', () => {
  it('checks each entry under its id', () => {
    checkPartial({ cams: { cam3: { n: 2 }, cam4: { id: 'cam4' } } }, TREE);
    expect(msg(() => checkPartial({ cams: { cam3: { n: 0 } } }, TREE))).toBe('cams.cam3.n: must be from 1 to 9');
    expect(msg(() => checkPartial({ cams: { Cam3: {} } }, TREE))).toBe('cams.Cam3: not a camera id');
    expect(msg(() => checkPartial({ cams: { cam3: { id: 'cam4' } } }, TREE))).toBe("cams.cam3.id: must be the camera's key (cam3)");
    expect(msg(() => checkPartial({ cams: [] }, TREE))).toBe('cams: must be an object');
    expect(msg(() => checkPartial({ cams: { cam3: { zz: 1 } } }, TREE))).toBe('cams.cam3.zz: unknown setting');
  });
  it('leaf paths expand to the given ids, in that order', () => {
    expect(leafPaths(TREE, '', ['b', 'a'])).toEqual(['sse.pingS', 'cams.b.id', 'cams.b.n', 'cams.a.id', 'cams.a.n']);
    expect(leafPaths(TREE)).toEqual(['sse.pingS']);
  });
  it('leafAt skips the id segment', () => {
    expect(leafAt('cams.cam9.n', TREE)).toMatchObject({ type: 'integer', max: 9 });
    expect(leafAt('cams.n', TREE)).toBeUndefined();
  });
  it('the JSON schema: an array of the node, id required', () => {
    const js = jsonSchema(TREE) as { properties: Record<string, { type: string; items: { required: string[]; properties: object } }> };
    expect(js.properties.cams.type).toBe('array');
    expect(js.properties.cams.items.required).toEqual(['id']);
    expect(Object.keys(js.properties.cams.items.properties)).toEqual(['id', 'n']);
  });
  it('the camera node has the per-camera keys and the closed list of host overrides', () => {
    expect(leafPaths(CAMERA_NODE)).toEqual([
      'id', 'name', 'host', 'protocol', 'tlsName', 'webUiUrl', 'user', 'onvifPort', 'rtspPort', 'baichuanPort', 'statusPollS',
      'poeSwitch.port', 'ftp.user', 'ftp.enabled', 'ftp.stream', 'stills.enabled', 'stills.stream', 'stills.intervalS', 'storage.sharePercent',
      'analytics.kinds.person', 'analytics.kinds.vehicle', 'analytics.kinds.pet', 'events.poll.enabled',
    ]);
    expect(leafPaths(LEGACY_CAMERA)).toContain('poeSwitch.model');
  });
});
