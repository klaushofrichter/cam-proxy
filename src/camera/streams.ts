// The camera's video streams as clients see them (spec
// 2026-10-30-camera-onboarding-design §4.8): codec, size and frame rate per
// stream, from GetEnc (cams's ReolinkClient.streams, moved here). Read-only.

export interface StreamInfo { codec: 'h264' | 'h265'; width: number; height: number; fps: number }
export interface Streams { main: StreamInfo | null; sub: StreamInfo | null }

export type CameraCommand = <T>(cmd: string, param?: object) => Promise<T>;

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

  constructor(
    private readonly command: CameraCommand,
    private readonly now: () => number = Date.now,
  ) {}

  read(): Promise<Streams> {
    const e = this.enc;
    if (e && this.now() - e.at < (e.ok ? OK_MS : FAILED_MS)) return Promise.resolve(e.streams);
    this.asking ??= this.ask().finally(() => {
      this.asking = undefined;
    });
    return this.asking;
  }

  private async ask(): Promise<Streams> {
    let ok = false;
    let streams: Streams = { main: null, sub: null };
    try {
      const v = await this.command<{ Enc?: { mainStream?: RawStream; subStream?: RawStream } }>('GetEnc', { channel: 0 });
      streams = { main: toStream(v?.Enc?.mainStream), sub: toStream(v?.Enc?.subStream) };
      ok = true;
    } catch {
      // extra information: the status stands without it
    }
    this.enc = { at: this.now(), ok, streams };
    return streams;
  }
}
