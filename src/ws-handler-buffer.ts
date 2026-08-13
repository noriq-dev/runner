import type { WsHandlers } from './ws-client';

type BufferedHandlerName =
  | 'onAssigned'
  | 'onCancel'
  | 'onSteer'
  | 'onPlanCompleted'
  | 'onResume'
  | 'onReconnect';

type ImmediateHandlerName =
  | 'onRegistered'
  | 'onDisconnect'
  | 'onMissionTaskAck'
  | 'onMissionReconcileRequest'
  | 'onMissionReconcileResult';

type HandlerArguments<K extends keyof WsHandlers> = Parameters<NonNullable<WsHandlers[K]>>;

type BufferedFrame = {
  [K in BufferedHandlerName]: {
    readonly handler: K;
    readonly args: HandlerArguments<K>;
    readonly bytes: number;
  };
}[BufferedHandlerName];

type BufferPhase = 'buffering' | 'draining' | 'active' | 'failed';

/**
 * Control-plane handlers which must be usable before the daemon finishes constructing its
 * ordinary run handlers. Mission acknowledgements join registration and reconciliation here:
 * delaying any of them can consume a server-owned deadline or strand a pending report.
 */
export type WsStartupHandlers = Required<Pick<WsHandlers, ImmediateHandlerName>>;

export interface BufferedWsHandlersOptions {
  /** Maximum number of ordinary frames waiting to be delivered, excluding one in-flight drain. */
  maxBufferedFrames: number;
  /** Maximum canonical JSON bytes retained across all queued ordinary frames. */
  maxBufferedBytes: number;
  /** Handlers that are safe to call immediately, before ordinary handler activation. */
  startupHandlers: WsStartupHandlers;
  /**
   * Required fail-closed notification. Overflow permanently poisons the buffer; activation will
   * reject and no remaining ordinary frame will be delivered.
   */
  onOverflow: (error: WsHandlerBufferOverflowError) => void;
}

export class WsHandlerBufferOverflowError extends Error {
  readonly code = 'WS_HANDLER_BUFFER_OVERFLOW';

  constructor(
    readonly maxBufferedFrames: number,
    readonly bufferedFrames: number,
    readonly incomingHandler: BufferedHandlerName,
    readonly maxBufferedBytes: number,
    readonly bufferedBytes: number,
    readonly incomingBytes: number,
  ) {
    super(
      `WebSocket startup handler buffer exhausted its ${maxBufferedFrames}-frame/` +
        `${maxBufferedBytes}-byte capacity while receiving ${incomingHandler}`,
    );
    this.name = 'WsHandlerBufferOverflowError';
  }
}

/**
 * A one-way startup barrier for WsClient callbacks.
 *
 * Ordinary frames are retained in arrival order until `activate()`. Registration and mission
 * control frames never wait: they use the explicitly supplied startup handlers until activation
 * completes, then use the active handler when it exists (falling back to the startup handler).
 */
export class BufferedWsHandlers implements WsHandlers {
  private readonly queue: BufferedFrame[] = [];
  private readonly maxBufferedFrames: number;
  private readonly maxBufferedBytes: number;
  private readonly startupHandlers: WsStartupHandlers;
  private readonly overflow: (error: WsHandlerBufferOverflowError) => void;
  private phase: BufferPhase = 'buffering';
  private activeHandlers: WsHandlers | null = null;
  private activation: Promise<void> | null = null;
  private failure: Error | null = null;
  private queuedBytes = 0;

  constructor(options: BufferedWsHandlersOptions) {
    if (!Number.isSafeInteger(options.maxBufferedFrames) || options.maxBufferedFrames < 1) {
      throw new RangeError('maxBufferedFrames must be a positive safe integer');
    }
    if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1) {
      throw new RangeError('maxBufferedBytes must be a positive safe integer');
    }
    this.maxBufferedFrames = options.maxBufferedFrames;
    this.maxBufferedBytes = options.maxBufferedBytes;
    this.startupHandlers = options.startupHandlers;
    this.overflow = options.onOverflow;
  }

  get bufferedFrames(): number {
    return this.queue.length;
  }

  get bufferedBytes(): number {
    return this.queuedBytes;
  }

  readonly onRegistered: NonNullable<WsHandlers['onRegistered']> = (message, generation) => {
    this.routeImmediate('onRegistered', [message, generation]);
  };

  readonly onDisconnect: NonNullable<WsHandlers['onDisconnect']> = (reason, generation) => {
    this.routeImmediate('onDisconnect', [reason, generation]);
  };

  readonly onMissionTaskAck: NonNullable<WsHandlers['onMissionTaskAck']> = (ack, generation) => {
    this.routeImmediate('onMissionTaskAck', [ack, generation]);
  };

  readonly onMissionReconcileRequest: NonNullable<WsHandlers['onMissionReconcileRequest']> = (
    request,
    generation,
  ) => {
    this.routeImmediate('onMissionReconcileRequest', [request, generation]);
  };

  readonly onMissionReconcileResult: NonNullable<WsHandlers['onMissionReconcileResult']> = (
    results,
    generation,
  ) => {
    this.routeImmediate('onMissionReconcileResult', [results, generation]);
  };

  readonly onAssigned: NonNullable<WsHandlers['onAssigned']> = (run, missionLease, generation) => {
    this.routeBuffered('onAssigned', [run, missionLease, generation]);
  };

  readonly onCancel: NonNullable<WsHandlers['onCancel']> = (message, generation) => {
    this.routeBuffered('onCancel', [message, generation]);
  };

  readonly onSteer: NonNullable<WsHandlers['onSteer']> = (steer) => {
    this.routeBuffered('onSteer', [steer]);
  };

  readonly onPlanCompleted: NonNullable<WsHandlers['onPlanCompleted']> = (message) => {
    this.routeBuffered('onPlanCompleted', [message]);
  };

  readonly onResume: NonNullable<WsHandlers['onResume']> = (message) => {
    this.routeBuffered('onResume', [message]);
  };

  readonly onReconnect: NonNullable<WsHandlers['onReconnect']> = (generation) => {
    this.routeBuffered('onReconnect', [generation]);
  };

  /**
   * Install the ordinary daemon handlers and drain exactly once. Repeating activation with the
   * same handler object is idempotent; attempting to replace it is rejected.
   */
  activate(handlers: WsHandlers): Promise<void> {
    if (this.activeHandlers !== null) {
      if (this.activeHandlers !== handlers) {
        return Promise.reject(new Error('WebSocket startup handlers have already been activated'));
      }
      return this.activation ?? Promise.resolve();
    }
    if (this.failure !== null) return Promise.reject(this.failure);

    this.activeHandlers = handlers;
    this.phase = 'draining';
    // Begin on a microtask so `activation` is installed before an invoked handler can re-enter
    // activate(). That makes repeat activation idempotent without risking a second drain.
    this.activation = Promise.resolve().then(() => this.drain());
    return this.activation;
  }

  private routeBuffered<K extends BufferedHandlerName>(handler: K, args: HandlerArguments<K>): void {
    if (this.phase === 'active') {
      this.invoke(this.activeHandlers!, handler, args);
      return;
    }
    if (this.phase === 'failed') throw this.failure;
    const incomingBytes = Buffer.byteLength(JSON.stringify({ handler, args }), 'utf8');
    if (
      this.queue.length >= this.maxBufferedFrames ||
      incomingBytes > this.maxBufferedBytes - this.queuedBytes
    ) {
      const error = new WsHandlerBufferOverflowError(
        this.maxBufferedFrames,
        this.queue.length,
        handler,
        this.maxBufferedBytes,
        this.queuedBytes,
        incomingBytes,
      );
      this.failure = error;
      this.phase = 'failed';
      this.queue.length = 0;
      this.queuedBytes = 0;
      this.overflow(error);
      return;
    }
    this.queue.push({ handler, args, bytes: incomingBytes } as BufferedFrame);
    this.queuedBytes += incomingBytes;
  }

  private routeImmediate<K extends ImmediateHandlerName>(handler: K, args: HandlerArguments<K>): void {
    const active = this.phase === 'active' ? this.activeHandlers?.[handler] : undefined;
    const selected = active ?? this.startupHandlers[handler];
    (selected as (...values: HandlerArguments<K>) => unknown)(...args);
  }

  private invoke<K extends keyof WsHandlers>(
    handlers: WsHandlers,
    handler: K,
    args: HandlerArguments<K>,
  ): unknown {
    const selected = handlers[handler];
    return (selected as ((...values: HandlerArguments<K>) => unknown) | undefined)?.(...args);
  }

  private async drain(): Promise<void> {
    try {
      while (this.phase === 'draining') {
        const frame = this.queue.shift();
        if (frame === undefined) {
          this.phase = 'active';
          return;
        }
        this.queuedBytes -= frame.bytes;
        await this.invokeFrame(frame);
      }
      throw this.failure ?? new Error('WebSocket startup handler drain stopped unexpectedly');
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.failure = failure;
      this.phase = 'failed';
      this.queue.length = 0;
      this.queuedBytes = 0;
      throw failure;
    }
  }

  private invokeFrame(frame: BufferedFrame): unknown {
    const selected = this.activeHandlers?.[frame.handler] as ((...values: unknown[]) => unknown) | undefined;
    return selected?.(...frame.args);
  }
}
