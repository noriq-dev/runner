import { describe, expect, it } from 'vitest';
import { AsyncQueue } from '../src/async-queue';

async function collect<T>(q: AsyncQueue<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of q) out.push(v);
  return out;
}

describe('AsyncQueue', () => {
  it('delivers buffered items in order, then ends on close', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    q.close();
    expect(await collect(q)).toEqual([1, 2, 3]);
  });

  it('wakes a waiting consumer when an item is pushed later', async () => {
    const q = new AsyncQueue<string>();
    const collected = collect(q); // starts consuming, immediately awaits
    await Promise.resolve();
    q.push('a');
    q.push('b');
    q.close();
    expect(await collected).toEqual(['a', 'b']);
  });

  it('ends iteration immediately when closed with nothing buffered', async () => {
    const q = new AsyncQueue<number>();
    const collected = collect(q);
    q.close();
    expect(await collected).toEqual([]);
  });

  it('ignores pushes after close', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.close();
    q.push(2); // dropped
    expect(await collect(q)).toEqual([1]);
  });
});
