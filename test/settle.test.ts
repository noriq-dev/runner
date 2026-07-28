import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCK_RELEASE_TIMEOUT_MS, withTimeout } from '../src/stages/settle';

// Settling is the one stage that runs no matter how a run got here, and RUN-177 moved a network
// call onto its path: the lock release must be ATTEMPTED before the terminal report, because
// reporting is what retires the agent the release authenticates as.
//
// That ordering is right and it introduced a way for the lock service to wedge a run — a release
// that never answers would stall the report, so the run stays non-terminal server-side, its agent
// is never retired, its continuation is never recorded and its runner slot is held for the life of
// the daemon. The asymmetry is the whole argument: a missed release costs promptness (the server
// auto-releases on task settle, and TTL covers the rest), a missed settle costs correctness.
describe('the lock release cannot wedge settling (RUN-177)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up on a release that never answers, and carries on', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    // A release that never settles — the hung-server case, which no `.catch()` can rescue.
    const settled = withTimeout(new Promise(() => {}), LOCK_RELEASE_TIMEOUT_MS, onTimeout);
    let done = false;
    void settled.then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(LOCK_RELEASE_TIMEOUT_MS - 1);
    expect(done).toBe(false); // still waiting — it does not give up early

    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(done).toBe(true);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('does not wait out the timeout when the release answers promptly', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    await withTimeout(Promise.resolve('released'), LOCK_RELEASE_TIMEOUT_MS, onTimeout);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('treats a REJECTED release as answered, not as a timeout', async () => {
    // The caller catches its own rejection before handing the promise over, so this asserts the
    // race itself does not mistake a fast failure for a hang — and never rejects onward, which
    // would abort the settle it exists to protect.
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    await expect(
      withTimeout(
        Promise.reject(new Error('lock service said no')).catch(() => {}),
        5_000,
        onTimeout,
      ),
    ).resolves.toBeUndefined();
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
