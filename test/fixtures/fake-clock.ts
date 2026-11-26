import type { ArchiveClock } from '../../src/net/archive-queue.js';

/**
 * A clock the test drives by hand. `advance(ms)` fires the timers that fall due, in order, and lets
 * the promise chains they release run before it returns. Nothing waits in real time.
 */
export class FakeClock implements ArchiveClock {
  t = 0;
  private timers: Array<{ id: number; at: number; callback: () => void }> = [];
  private counter = 0;

  now(): number {
    return this.t;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = ++this.counter;
    this.timers.push({ id, at: this.t + Math.max(0, ms), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter(timer => timer.id !== handle);
  }

  /** Let pending promise callbacks (and a few macrotasks, for stream reads) run. */
  async settle(): Promise<void> {
    for (let i = 0; i < 6; i++) await new Promise<void>(resolve => setImmediate(resolve));
  }

  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    await this.settle();
    for (;;) {
      const due = this.timers.filter(timer => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter(timer => timer.id !== due.id);
      this.t = Math.max(this.t, due.at);
      due.callback();
      await this.settle();
    }
    this.t = target;
    await this.settle();
  }
}
