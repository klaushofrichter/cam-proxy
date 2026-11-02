// The camera's video streams as clients see them (spec
// 2026-10-30-camera-onboarding-design §4.8): codec, size and frame rate per
// stream, from GetEnc (cams's ReolinkClient.streams, moved here). Read-only.

export interface StreamInfo { codec: 'h264' | 'h265'; width: number; height: number; fps: number }
export interface Streams { main: StreamInfo | null; sub: StreamInfo | null }

export type CameraCommand = <T>(cmd: string, param?: object) => Promise<T>;
// A Get with action 1: its value with the camera's initial and range.
export type RangeCommand = <T>(cmd: string, param?: object) => Promise<{ value: T; initial?: unknown; range?: unknown }>;

interface RawStream { vType?: string; width?: number; height?: number; frameRate?: number }

function toStream(s: RawStream | undefined): StreamInfo | null {
  if (!s || typeof s.width !== 'number' || typeof s.height !== 'number' || typeof s.frameRate !== 'number') return null;
  return { codec: s.vType === 'h265' ? 'h265' : 'h264', width: s.width, height: s.height, fps: s.frameRate };
}

const OK_MS = 600_000;
const FAILED_MS = 30_000;

// GetEnc changes rarely: asked once per 10 minutes; a failure answers both
// streams null and is asked again after 30 s. Concurrent reads share one ask.
export class StreamsReader {
  private enc: { at: number; ok: boolean; streams: Streams } | undefined;
  private asking: Promise<Streams> | undefined;
  private gen = 0;

  constructor(
    private readonly command: CameraCommand,
    private readonly now: () => number = Date.now,
  ) {}

  // The next read asks the camera (after a change of its encoding).
  // A read in flight then is not kept, and not shared with later reads.
  forget(): void {
    this.enc = undefined;
    this.asking = undefined;
    this.gen++;
  }

  read(): Promise<Streams> {
    const e = this.enc;
    if (e && this.now() - e.at < (e.ok ? OK_MS : FAILED_MS)) return Promise.resolve(e.streams);
    if (this.asking) return this.asking;
    const p = this.ask().finally(() => {
      if (this.asking === p) this.asking = undefined;
    });
    this.asking = p;
    return p;
  }

  private async ask(): Promise<Streams> {
    const gen = this.gen;
    let ok = false;
    let streams: Streams = { main: null, sub: null };
    try {
      const v = await this.command<{ Enc?: { mainStream?: RawStream; subStream?: RawStream } }>('GetEnc', { channel: 0 });
      streams = { main: toStream(v?.Enc?.mainStream), sub: toStream(v?.Enc?.subStream) };
      ok = true;
    } catch {
      // extra information: the status stands without it
    }
    if (gen === this.gen) this.enc = { at: this.now(), ok, streams };
    return streams;
  }
}
