// Caps concurrent camera requests: the camera is small hardware and starts
// dropping connections when many arrive at once.
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.max) {
      this.active++;
    } else {
      // Handed the slot directly by whoever releases it (see finally
      // below); active is already accounted for, so don't increment again.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    try {
      return await fn();
    } finally {
      // Hand off directly to a queued waiter instead of decrementing first:
      // decrementing before the waiter resumes leaves a window where a
      // brand-new caller can see a free slot and jump the queue.
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
