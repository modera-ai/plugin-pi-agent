import type { AgentEvent } from "@modera/contracts";

/** Every send waits until the host advances past the event it has persisted. */
export class EventChannel {
  private queue: {
    event: AgentEvent;
    resolve: () => void;
    reject: (error: unknown) => void;
  }[] = [];
  private pending = new Set<(error: unknown) => void>();
  private wake?: () => void;
  private ended = false;
  private error?: unknown;

  constructor(private readonly signal: AbortSignal) {}

  async send(event: AgentEvent): Promise<void> {
    this.signal.throwIfAborted();
    if (this.ended) throw new Error("Agent event consumer closed");
    await new Promise<void>((resolve, reject) => {
      this.pending.add(reject);
      this.queue.push({
        event,
        resolve: () => {
          this.pending.delete(reject);
          resolve();
        },
        reject,
      });
      this.wake?.();
    });
    this.signal.throwIfAborted();
  }

  finish(error?: unknown): void {
    this.ended = true;
    this.error = error;
    this.wake?.();
  }

  close(): void {
    this.ended = true;
    for (const reject of this.pending)
      reject(new Error("Agent event consumer closed"));
    this.pending.clear();
    this.queue = [];
    this.wake?.();
  }

  async *events(): AsyncGenerator<AgentEvent> {
    while (true) {
      const item = this.queue.shift();
      if (item) {
        yield item.event;
        item.resolve();
      } else if (this.ended) {
        if (this.error !== undefined) throw this.error;
        return;
      } else {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = undefined;
      }
    }
  }
}
