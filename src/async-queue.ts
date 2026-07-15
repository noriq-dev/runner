/**
 * A pushable async iterable — the streaming-input channel for a steerable agent
 * session. The driver hands this to the Agent SDK's streaming `query()` as the
 * prompt; pushing a value delivers a new user turn to the live session, and
 * closing it ends the input stream.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  /** @returns false if the queue is closed — the item was NOT delivered. Callers that
   *  report delivery (steering) must not treat a closed queue as success: the push is a
   *  silent no-op, and an ack of `via:'runtime'` would suppress the notices fallback,
   *  losing the message entirely. */
  push(item: T): boolean {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    let waiter = this.waiters.shift();
    while (waiter) {
      waiter({ value: undefined as unknown as T, done: true });
      waiter = this.waiters.shift();
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const buffered = this.items.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (result.done) return;
      yield result.value;
    }
  }
}
