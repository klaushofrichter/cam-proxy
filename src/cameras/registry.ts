import type { CameraWorker } from './worker';

// The camera workers of this proxy (spec 2026-10-05-multi-camera-host-design
// §3.1), always listed in config order (`order`: the ids as configured).
export class CameraRegistry {
  private readonly byId = new Map<string, CameraWorker>();

  constructor(private readonly order: () => string[]) {}

  add(w: CameraWorker): void {
    this.byId.set(w.id, w);
  }

  remove(id: string): void {
    this.byId.delete(id);
  }

  get(id: string): CameraWorker | undefined {
    return this.byId.get(id);
  }

  list(): CameraWorker[] {
    return this.order().flatMap((id) => (this.byId.has(id) ? [this.byId.get(id)!] : []));
  }

  ids(): string[] {
    return this.list().map((w) => w.id);
  }

  first(): CameraWorker {
    const w = this.list()[0];
    if (!w) throw new Error('no camera configured');
    return w;
  }

  get size(): number {
    return this.byId.size;
  }
}
