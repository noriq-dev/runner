import { describe, expect, it } from 'vitest';
import type { DriverExit, DriverSession } from '../src/drivers/types';
import { type Steer, SteeringBridge, steerModeForKind } from '../src/steering';

class FakeSession implements DriverSession {
  order: string[] = [];
  inputs: string[] = [];
  interrupts = 0;
  interruptThrows = false;
  /** Model a session whose input queue has closed (the agent already finished). */
  inputClosed = false;
  constructor(readonly runId: string) {}
  pushInput(text: string): boolean {
    this.order.push('push');
    if (this.inputClosed) return false; // silently accepts nothing — like AsyncQueue
    this.inputs.push(text);
    return true;
  }
  async interrupt(): Promise<void> {
    this.order.push('interrupt');
    this.interrupts += 1;
    if (this.interruptThrows) throw new Error('interrupt boom');
  }
  async stop(): Promise<void> {}
  done(): Promise<DriverExit> {
    return new Promise<DriverExit>(() => {});
  }
}

// register(runId, session, stop) — a run's stop hook (budgetRun.stop in prod).
function register(bridge: SteeringBridge, session: FakeSession): { stops: number } {
  const box = { stops: 0 };
  bridge.register(session.runId, session, async () => {
    box.stops += 1;
  });
  return box;
}

const steer = (over: Partial<Steer> = {}): Steer => ({
  runId: 'run_1',
  steerId: 's1',
  mode: 'soft',
  body: 'focus on the auth module',
  sourceCommentId: 'cmt_1',
  sourceMessageId: null,
  noticeCursor: 42,
  ...over,
});

describe('steerModeForKind', () => {
  it('priority / scope redirects → hard; everything else → soft', () => {
    expect(steerModeForKind('priority')).toBe('hard');
    expect(steerModeForKind('scope_redirect')).toBe('hard');
    expect(steerModeForKind('redirect')).toBe('hard');
    expect(steerModeForKind('instruction')).toBe('soft');
    expect(steerModeForKind('question')).toBe('soft');
    expect(steerModeForKind('message')).toBe('soft');
  });
});

describe('SteeringBridge', () => {
  it('soft steer queues a user turn (runtime delivery)', async () => {
    const bridge = new SteeringBridge();
    const session = new FakeSession('run_1');
    register(bridge, session);
    const result = await bridge.applySteer(steer({ mode: 'soft' }));
    expect(session.inputs).toEqual(['focus on the auth module']);
    expect(session.interrupts).toBe(0);
    expect(result).toMatchObject({ delivered: true, via: 'runtime', steerId: 's1', noticeCursor: 42 });
  });

  it('hard steer interrupts THEN injects', async () => {
    const bridge = new SteeringBridge();
    const session = new FakeSession('run_1');
    register(bridge, session);
    const result = await bridge.applySteer(steer({ mode: 'hard', body: 're-scope: drop the caching work' }));
    expect(session.order).toEqual(['interrupt', 'push']); // interrupt first, then inject
    expect(session.inputs).toEqual(['re-scope: drop the caching work']);
    expect(result).toMatchObject({ delivered: true, via: 'runtime' });
  });

  it('a steer for an unknown/ended run is dropped (notices fallback)', async () => {
    const bridge = new SteeringBridge();
    const result = await bridge.applySteer(steer());
    expect(result).toMatchObject({ delivered: false, via: 'dropped' });
  });

  it('unregister makes a run un-steerable', async () => {
    const bridge = new SteeringBridge();
    const session = new FakeSession('run_1');
    register(bridge, session);
    expect(bridge.hasRun('run_1')).toBe(true);
    bridge.unregister('run_1');
    expect(bridge.hasRun('run_1')).toBe(false);
    expect((await bridge.applySteer(steer())).via).toBe('dropped');
  });

  it('a delivery failure falls back (not dropped)', async () => {
    const bridge = new SteeringBridge();
    const session = new FakeSession('run_1');
    session.interruptThrows = true;
    register(bridge, session);
    const result = await bridge.applySteer(steer({ mode: 'hard' }));
    expect(result).toMatchObject({ delivered: false, via: 'fallback' });
    expect(result.detail).toMatch(/interrupt boom/);
  });

  it('cancelRun hard-interrupts then stops (SIGTERM + teardown)', async () => {
    const bridge = new SteeringBridge();
    const session = new FakeSession('run_1');
    const box = register(bridge, session);
    expect(await bridge.cancelRun('run_1')).toBe(true);
    expect(session.interrupts).toBe(1); // hard interrupt first
    expect(box.stops).toBe(1); // then stop → SIGTERM + supervisor teardown
  });

  it('cancelRun on an unknown run is a no-op', async () => {
    const bridge = new SteeringBridge();
    expect(await bridge.cancelRun('nope')).toBe(false);
  });
});

describe('a steer that arrives after the session closed', () => {
  it('is reported as dropped, not delivered — so the notices fallback still runs', async () => {
    // Regression: AsyncQueue.push silently no-ops once closed, so applySteer saw no error
    // and acked via:'runtime' — which suppresses the notices fallback. The steer reached
    // NOBODY while the human watched it get acked as delivered.
    const bridge = new SteeringBridge();
    const session = new FakeSession('run_1');
    session.inputClosed = true; // the agent finished while the steer was in flight
    bridge.register('run_1', session, async () => {});

    const res = await bridge.applySteer({
      runId: 'run_1',
      steerId: 's1',
      mode: 'soft',
      body: 'do the other thing',
      sourceCommentId: null,
      sourceMessageId: null,
      noticeCursor: 7,
    });

    expect(res.delivered).toBe(false);
    expect(res.via).toBe('dropped'); // 'runtime' here would lose the steer entirely
    expect(res.noticeCursor).toBe(7); // the fallback needs this
    expect(session.inputs).toEqual([]);
  });

  it('still reports runtime delivery when the session accepts it', async () => {
    const bridge = new SteeringBridge();
    const session = new FakeSession('run_2');
    bridge.register('run_2', session, async () => {});
    const res = await bridge.applySteer({
      runId: 'run_2',
      steerId: 's2',
      mode: 'soft',
      body: 'go left',
      sourceCommentId: null,
      sourceMessageId: null,
      noticeCursor: null,
    });
    expect(res).toMatchObject({ delivered: true, via: 'runtime' });
    expect(session.inputs).toEqual(['go left']);
  });
});

describe('stopAll (daemon shutdown)', () => {
  it('stops every live session so none are orphaned', async () => {
    // Exiting without this leaves spawned agents running against the worktree, spending
    // real money, with the budget enforcer dead.
    const bridge = new SteeringBridge();
    const stopped: string[] = [];
    for (const id of ['run_a', 'run_b', 'run_c']) {
      bridge.register(id, new FakeSession(id), async () => {
        stopped.push(id);
      });
    }
    const ids = await bridge.stopAll();
    expect(ids.sort()).toEqual(['run_a', 'run_b', 'run_c']);
    expect(stopped.sort()).toEqual(['run_a', 'run_b', 'run_c']);
    expect(bridge.hasRun('run_a')).toBe(false); // and the map is emptied
  });

  it('keeps going when one session refuses to stop', async () => {
    const bridge = new SteeringBridge();
    bridge.register('bad', new FakeSession('bad'), async () => {
      throw new Error('stop boom');
    });
    const ok: string[] = [];
    bridge.register('good', new FakeSession('good'), async () => {
      ok.push('good');
    });
    await expect(bridge.stopAll()).resolves.toHaveLength(2);
    expect(ok).toEqual(['good']); // one failure must not strand the rest
  });
});
