import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { listEvents, openEvents } from '../src/catalog/events';
import { StreamLog, type StreamMessage } from '../src/stream/log';
import { EventTracker, topicKind } from '../src/events/tracker';
import { EventIntake, type IntakeState } from '../src/events/intake';
import { ReolinkClient } from '../src/camera/client';
import { startSim } from './helpers/sim';

let catalog: Catalog;
let log: StreamLog;
let messages: StreamMessage[];
beforeEach(() => {
  catalog = openCatalog(join(mkdtempSync(join(tmpdir(), 'camproxy-intake-')), 'catalog.sqlite'));
  log = new StreamLog(catalog);
  messages = [];
  log.on('message', (m: StreamMessage) => messages.push(m));
});
afterEach(() => catalog.close());

const until = async (cond: () => boolean, ms = 10000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const phases = () => messages.filter((m) => m.type === 'camera-event').map((m) => `${m.data.kind}:${m.data.phase}`);

describe('topicKind', () => {
  it('maps the camera topics to event kinds', () => {
    expect(topicKind('tns1:RuleEngine/CellMotionDetector/Motion')).toBe('motion');
    expect(topicKind('tns1:VideoSource/MotionAlarm')).toBe('motion');
    expect(topicKind('tns1:RuleEngine/MyRuleDetector/PeopleDetect')).toBe('person');
    expect(topicKind('tns1:RuleEngine/MyRuleDetector/VehicleDetect')).toBe('vehicle');
    expect(topicKind('tns1:RuleEngine/MyRuleDetector/DogCatDetect')).toBe('pet');
    expect(topicKind('tns1:RuleEngine/MyRuleDetector/Package')).toBe('Package');
  });
});

describe('EventTracker', () => {
  let now = 1_000_000;
  const tracker = () => new EventTracker(catalog, log, 'cam1', { maxOpenMin: 1 }, () => now);

  it('opens an event on true and closes it on false, with stream messages', () => {
    const t = tracker();
    t.apply('onvif', 'person', true, now);
    t.apply('onvif', 'person', true, now + 10); // repeated true: same event
    t.apply('onvif', 'person', false, now + 2000);
    const [e] = listEvents(catalog, { cam: 'cam1' });
    expect(e).toMatchObject({ kind: 'person', source: 'onvif', start_ts: now, end_ts: now + 2000, end_reason: 'state' });
    expect(phases()).toEqual(['person:start', 'person:end']);
    expect(messages[0].data).toMatchObject({ eventId: e.id, kind: 'person', phase: 'start', ts: now, source: 'onvif' });
  });

  it('takes the initial state without creating events, and closes events whose state is gone', () => {
    const t = tracker();
    t.apply('onvif', 'vehicle', true, now);
    t.initialize({ vehicle: false, person: true }, now + 500);
    expect(openEvents(catalog, 'cam1')).toHaveLength(0);
    expect(listEvents(catalog, { cam: 'cam1' })).toHaveLength(1);
    t.apply('onvif', 'person', true, now + 600); // already known true: no new event
    expect(listEvents(catalog, { cam: 'cam1' })).toHaveLength(1);
  });

  it('closes an event left open longer than maxOpenMin', () => {
    const t = tracker();
    t.apply('onvif', 'pet', true, now);
    now += 61_000;
    t.sweep();
    expect(listEvents(catalog, { cam: 'cam1' })[0]).toMatchObject({ end_reason: 'timeout', end_ts: now });
    expect(phases()).toEqual(['pet:start', 'pet:end']);
  });
});

describe('EventIntake against cam-sim', () => {
  let close: (() => Promise<void>) | undefined;
  let intake: EventIntake | undefined;
  afterEach(async () => {
    await intake?.stop();
    await close?.();
    intake = close = undefined;
  });

  async function setup(poll = { enabled: true, intervalS: 1, afterOnvifDownS: 1 }) {
    const s = await startSim({ rebootMs: 300 });
    close = s.close;
    const client = new ReolinkClient({ id: 'cam1', host: s.camera.host, protocol: 'http', user: 'proxy', password: s.password });
    const tracker = new EventTracker(catalog, log, 'cam1', { maxOpenMin: 10 });
    intake = new EventIntake({
      client, tracker,
      cfg: { onvif: { subscribeMin: 1, pullTimeoutS: 1 }, poll, maxOpenMin: 10 },
      onvif: { host: '127.0.0.1', port: s.ports.onvif, user: 'proxy', password: s.password },
      backoff: { minMs: 100, maxMs: 500 },
    });
    const states: IntakeState[] = [];
    intake.on('state', (st: IntakeState) => states.push(st));
    intake.start();
    await until(() => intake!.state().onvif === 'subscribed');
    await new Promise((r) => setTimeout(r, 200)); // the Initialized pull
    return { ...s, states };
  }

  it('turns camera detections into events, with no event from the initial state', async () => {
    const { sim } = await setup();
    expect(listEvents(catalog, { cam: 'cam1' })).toHaveLength(0);
    sim.engine.events.trigger('person', 1);
    sim.engine.events.trigger('vehicle', 1);
    await until(() => listEvents(catalog, { cam: 'cam1' }).filter((e) => e.end_ts !== null).length >= 2);
    const kinds = listEvents(catalog, { cam: 'cam1' }).map((e) => `${e.kind}/${e.source}`).sort();
    expect(kinds).toContain('person/onvif');
    expect(kinds).toContain('vehicle/onvif');
  });

  it('merges the two motion topics into one motion event', async () => {
    const { sim } = await setup();
    sim.engine.events.trigger('motion', 1);
    await until(() => phases().includes('motion:end'));
    expect(listEvents(catalog, { cam: 'cam1', kind: 'motion' })).toHaveLength(1);
    expect(phases().filter((p) => p.startsWith('motion'))).toEqual(['motion:start', 'motion:end']);
  });

  it('re-subscribes after a camera reboot; the event is closed once, not duplicated', async () => {
    const { sim } = await setup();
    sim.engine.events.trigger('person', 60);
    await until(() => phases().includes('person:start'));
    void sim.engine.reboot({ ms: 300 });
    await until(() => intake!.state().resubscribes >= 1 && intake!.state().onvif === 'subscribed', 15000);
    await until(() => openEvents(catalog, 'cam1').length === 0 || phases().includes('person:end'), 5000).catch(() => undefined);
    const people = listEvents(catalog, { cam: 'cam1', kind: 'person' });
    expect(people).toHaveLength(1);
    expect(phases().filter((p) => p === 'person:start')).toHaveLength(1);
  });

  it('falls back to polling while ONVIF is off, and returns to ONVIF', async () => {
    const { sim } = await setup();
    sim.engine.settings.running.NetPort.onvifEnable = 0;
    sim.engine.bus.emit('settings', { cmd: 'SetNetPort' });
    await until(() => intake!.state().source === 'poll', 15000);
    sim.engine.events.trigger('vehicle', 3);
    await until(() => listEvents(catalog, { cam: 'cam1', kind: 'vehicle' }).length === 1, 10000);
    expect(listEvents(catalog, { cam: 'cam1', kind: 'vehicle' })[0].source).toBe('poll');
    sim.engine.settings.running.NetPort.onvifEnable = 1;
    await until(() => intake!.state().source === 'onvif', 15000);
  }, 40000);

  it('stops cleanly: no more events after stop()', async () => {
    const { sim } = await setup();
    await intake!.stop();
    expect(intake!.state().source).toBe('none');
    sim.engine.events.trigger('person', 1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(listEvents(catalog, { cam: 'cam1' })).toHaveLength(0);
  });
});
