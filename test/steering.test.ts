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

// register(runId, session, stop, key?) — a run's stop hook (budgetRun.stop in prod). `key` is the
// session's tally slot on a decomposed run (RUN-170); omitted for the single-session shape.
function register(bridge: SteeringBridge, session: FakeSession, key?: string): { stops: number } {
  const box = { stops: 0 };
  bridge.register(
    session.runId,
    session,
    async () => {
      box.stops += 1;
    },
    key,
  );
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

  // A cancel arriving BETWEEN stages has nothing to stop and is still a cancel (RUN-165). Answering
  // false and letting the next stage spawn is how an operator pays for a run they ended.
  it('cancelRun with no live session still cancels the RUN', async () => {
    const bridge = new SteeringBridge();
    expect(await bridge.cancelRun('run_nobody')).toBe(true);
    expect(bridge.isCancelled('run_nobody')).toBe(true);
  });

  it('a run nobody cancelled is not cancelled', () => {
    expect(new SteeringBridge().isCancelled('run_1')).toBe(false);
  });

  // The fact has to outlive the session that was live when it arrived — that is the entire bug.
  it('stays cancelled after the session it stopped is gone', async () => {
    const bridge = new SteeringBridge();
    const session = new FakeSession('run_1');
    register(bridge, session);
    await bridge.cancelRun('run_1');
    bridge.unregister('run_1');
    expect(bridge.isCancelled('run_1')).toBe(true);
  });

  // …but not forever: a long-lived daemon must not keep one entry per cancelled run for its life.
  it('forgets a run once it is terminal', async () => {
    const bridge = new SteeringBridge();
    await bridge.cancelRun('run_1');
    bridge.forget('run_1');
    expect(bridge.isCancelled('run_1')).toBe(false);
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

  it('stops every session of a multi-session run, reporting the run once', async () => {
    const bridge = new SteeringBridge();
    const a = new FakeSession('run_1');
    const b = new FakeSession('run_1');
    const boxA = register(bridge, a, 'step:a');
    const boxB = register(bridge, b, 'step:b');
    const ids = await bridge.stopAll();
    expect(ids).toEqual(['run_1']); // the RUN is what shutdown reports, not its session count
    expect(boxA.stops).toBe(1);
    expect(boxB.stops).toBe(1);
    expect(bridge.hasRun('run_1')).toBe(false);
  });
});

// RUN-170: a wave runs a run's steps concurrently, so one run is several live sessions at once.
// A runId-keyed map made the second registration clobber the first — and its unregister then
// removed the survivor, leaving a live, spending session no cancel could reach.
describe('several live sessions of one run (RUN-170)', () => {
  it('a second registration under its own key does not clobber the first', async () => {
    const bridge = new SteeringBridge();
    const a = new FakeSession('run_1');
    const b = new FakeSession('run_1');
    register(bridge, a, 'step:a');
    register(bridge, b, 'step:b');
    // A steer names the RUN and carries no session address: it reaches every live session,
    // because the one it was about missing it loses the steer.
    const result = await bridge.applySteer(steer({ body: 'stop touching the schema' }));
    expect(a.inputs).toEqual(['stop touching the schema']);
    expect(b.inputs).toEqual(['stop touching the schema']);
    expect(result).toMatchObject({ delivered: true, via: 'runtime' });
  });

  it('a hard steer interrupts EACH session before injecting into it', async () => {
    const bridge = new SteeringBridge();
    const a = new FakeSession('run_1');
    const b = new FakeSession('run_1');
    register(bridge, a, 'step:a');
    register(bridge, b, 'step:b');
    await bridge.applySteer(steer({ mode: 'hard' }));
    expect(a.order).toEqual(['interrupt', 'push']);
    expect(b.order).toEqual(['interrupt', 'push']);
  });

  it('delivery to at least one session is runtime delivery, even when a sibling already closed', async () => {
    const bridge = new SteeringBridge();
    const closed = new FakeSession('run_1');
    closed.inputClosed = true; // this step finished while the steer was in flight
    const live = new FakeSession('run_1');
    register(bridge, closed, 'step:a');
    register(bridge, live, 'step:b');
    const result = await bridge.applySteer(steer());
    expect(live.inputs).toHaveLength(1);
    expect(result).toMatchObject({ delivered: true, via: 'runtime' });
  });

  it('every session closed → dropped, so the notices fallback still runs', async () => {
    const bridge = new SteeringBridge();
    const a = new FakeSession('run_1');
    const b = new FakeSession('run_1');
    a.inputClosed = true;
    b.inputClosed = true;
    register(bridge, a, 'step:a');
    register(bridge, b, 'step:b');
    const result = await bridge.applySteer(steer());
    expect(result).toMatchObject({ delivered: false, via: 'dropped' });
  });

  it('cancelRun stops EVERY live session of the run', async () => {
    const bridge = new SteeringBridge();
    const a = new FakeSession('run_1');
    const b = new FakeSession('run_1');
    const boxA = register(bridge, a, 'step:a');
    const boxB = register(bridge, b, 'step:b');
    expect(await bridge.cancelRun('run_1')).toBe(true);
    expect(a.interrupts).toBe(1);
    expect(b.interrupts).toBe(1);
    expect(boxA.stops).toBe(1);
    expect(boxB.stops).toBe(1);
    expect(bridge.isCancelled('run_1')).toBe(true);
  });

  it('one session refusing to stop does not strand its siblings', async () => {
    const bridge = new SteeringBridge();
    const bad = new FakeSession('run_1');
    const good = new FakeSession('run_1');
    bridge.register(
      'run_1',
      bad,
      async () => {
        throw new Error('stop boom');
      },
      'step:a',
    );
    const box = register(bridge, good, 'step:b');
    await expect(bridge.cancelRun('run_1')).resolves.toBe(true);
    expect(box.stops).toBe(1); // the sibling still went down
  });

  it('unregister removes only its own session', async () => {
    const bridge = new SteeringBridge();
    const a = new FakeSession('run_1');
    const b = new FakeSession('run_1');
    register(bridge, a, 'step:a');
    register(bridge, b, 'step:b');
    bridge.unregister('run_1', 'step:a');
    expect(bridge.hasRun('run_1')).toBe(true); // b is still live and steerable
    const result = await bridge.applySteer(steer());
    expect(a.inputs).toEqual([]);
    expect(b.inputs).toHaveLength(1);
    expect(result).toMatchObject({ delivered: true, via: 'runtime' });
    bridge.unregister('run_1', 'step:b');
    expect(bridge.hasRun('run_1')).toBe(false);
  });

  // The single-session shape is every existing call site: default key in, default key out.
  it('keyless register and unregister keep addressing the same (single) session', () => {
    const bridge = new SteeringBridge();
    register(bridge, new FakeSession('run_1'));
    expect(bridge.hasRun('run_1')).toBe(true);
    bridge.unregister('run_1');
    expect(bridge.hasRun('run_1')).toBe(false);
  });
});
