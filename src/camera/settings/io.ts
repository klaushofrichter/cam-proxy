// Reading and writing the settings sections cams edits (spec
// 2026-10-30-camera-onboarding-design §4.8), moved from cams
// (server/reolink/device.ts readDetectionRaw/readImageRaw, server/routes/settings.ts
// apply, expectedChange and writeSection). Every write sends the camera's whole
// current object with only the asked keys changed, then reads the section
// again: a field counts as saved only when the re-read shows it.
import { CameraError } from '../client';
import type { CameraCommand } from '../streams';
import {
  AI_KINDS, AI_TYPE, changedKeys, detectionCommands, detectionFrom, imageCommands, imageFrom, patchApplied, validateDetectionPatch, validateImagePatch,
  type AiKind, type DetectionPatch, type DetectionSettings, type ImagePatch, type ImageSettings, type RawDetection, type RawImage, type SettingsCommand,
} from './model';

export type SettingsSection = 'detection' | 'image';
export const SECTIONS: readonly SettingsSection[] = ['detection', 'image'];
export const isSection = (v: unknown): v is SettingsSection => (SECTIONS as readonly unknown[]).includes(v);

export type FieldError = 'camera_rejected' | 'not_applied';
export type WriteResult =
  | { status: 400; details: string[] }
  | {
      status: 200 | 207;
      fields: Record<string, { ok: boolean; error?: FieldError }>;
      settings: DetectionSettings | ImageSettings;
      patch: DetectionPatch | ImagePatch;
      // Keys (dotted, names only) the camera changed that no write asked for.
      unexpected: string[];
    };

// Reads go one at a time: they share the camera's API gate.
async function readDetection(command: CameraCommand): Promise<{ raw: RawDetection; settings: DetectionSettings }> {
  const rec = await command('GetRecV20', { channel: 0 });
  const md = await command('GetMdAlarm', { channel: 0 });
  const ai = {} as Record<AiKind, unknown>;
  for (const kind of AI_KINDS) ai[kind] = await command('GetAiAlarm', { channel: 0, ai_type: AI_TYPE[kind] });
  const raw = { rec, md, ai };
  return { raw, settings: detectionFrom(raw) };
}

async function readImage(command: CameraCommand): Promise<{ raw: RawImage; settings: ImageSettings }> {
  const isp = await command('GetIsp', { channel: 0 });
  const ir = await command('GetIrLights', { channel: 0 });
  const wl = await command('GetWhiteLed', { channel: 0 });
  const osd = await command('GetOsd', { channel: 0 });
  const raw = { isp, ir, wl, osd };
  return { raw, settings: imageFrom(raw) };
}

export function readSection(command: CameraCommand, section: SettingsSection): Promise<{ raw: RawDetection | RawImage; settings: DetectionSettings | ImageSettings }> {
  return section === 'detection' ? readDetection(command) : readImage(command);
}

// A changed key is expected only if the camera now holds exactly the value
// a write sent for it (and that value differs from before). Paths from
// changedKeys() look like "osd.Osd.osdChannel.name": the RawImage or
// RawDetection key, the reply wrapper, then the object's own keys.
function at(o: unknown, path: string[]): unknown {
  for (const k of path) {
    if (typeof o !== 'object' || o === null) return undefined;
    o = (o as Record<string, unknown>)[k];
  }
  return o;
}
function expectedChange(key: string, commands: SettingsCommand[], after: unknown): boolean {
  const parts = key.split('.');
  const now = JSON.stringify(at(after, parts));
  return commands.some((c) => {
    const [wrap, body] = Object.entries(c.param as Record<string, unknown>)[0];
    const i = parts.indexOf(wrap);
    if (i < 0) return false;
    // ai.<kind>.AiAlarm.…: only the command for that AI type counts.
    if (parts[0] === 'ai' && (body as Record<string, unknown>)?.ai_type !== AI_TYPE[parts[1] as AiKind]) return false;
    return JSON.stringify(at(body, parts.slice(i + 1))) === now;
  });
}

// One command at a time; a failing command doesn't stop the rest. An offline
// or auth failure fails the whole request (rethrown).
async function apply(command: CameraCommand, commands: SettingsCommand[], sent?: (cmd: string) => void): Promise<Record<string, { ok: boolean; error?: FieldError }>> {
  const fields: Record<string, { ok: boolean; error?: FieldError }> = {};
  for (const c of commands) {
    try {
      sent?.(c.cmd);
      await command(c.cmd, c.param);
      for (const f of c.fields) fields[f] = { ok: true };
    } catch (err) {
      if (err instanceof CameraError && err.code !== 'camera_error') throw err;
      for (const f of c.fields) fields[f] = { ok: false, error: 'camera_rejected' };
    }
  }
  return fields;
}

// Validates `body`, reads the section, sends the whole objects it changes,
// reads again and judges every field against the re-read. 400 before the
// camera is asked anything. `o.sent`: told each command just before it goes
// (the caller's audit knows whether anything was written before a failure).
export async function writeSection(command: CameraCommand, section: SettingsSection, body: unknown, o: { sent?: (cmd: string) => void } = {}): Promise<WriteResult> {
  const v = section === 'detection' ? validateDetectionPatch(body) : validateImagePatch(body);
  if (!v.ok) return { status: 400, details: v.details };
  const before = await readSection(command, section);
  const commands = section === 'detection' ? detectionCommands(v.patch as DetectionPatch, before.raw as RawDetection) : imageCommands(v.patch as ImagePatch, before.raw as RawImage);
  const fields = await apply(command, commands, o.sent);
  const after = await readSection(command, section);
  for (const [field, r] of Object.entries(fields)) {
    if (r.ok && !patchApplied(field, v.patch, after.settings)) fields[field] = { ok: false, error: 'not_applied' };
  }
  // A write sent the whole object, so after it the camera's object should
  // equal exactly what was sent. Anything else moved on its own.
  const unexpected = changedKeys(before.raw, after.raw).filter((key) => !expectedChange(key, commands, after.raw));
  const allOk = Object.values(fields).every((f) => f.ok);
  return { status: allOk ? 200 : 207, fields, settings: after.settings, patch: v.patch, unexpected };
}
