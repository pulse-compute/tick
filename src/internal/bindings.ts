import type { CancellationController, Clock, CoordinationBinding, IdSource, Telemetry } from '../index.js';
import type { ExecutionRuntime } from '../runner.js';

const object = (value: unknown): value is object => value !== null && typeof value === 'object';
const alias = /^[A-Za-z0-9._-]{1,80}$/;
const prefix = /^[A-Za-z0-9/_-]{0,128}$/;

/** Pure declaration checks and method capture; never read storage or resolve credentials. */
export function captureCoordination(binding: CoordinationBinding): CoordinationBinding {
  try {
    if (!object(binding) || typeof binding.name !== 'string' || !alias.test(binding.name)
      || typeof binding.prefix !== 'string' || !prefix.test(binding.prefix)) throw new TypeError();
    const store = binding.store, capabilities = store?.capabilities;
    if (!object(store) || capabilities?.atomicCreate !== true || capabilities.atomicReplace !== true
      || capabilities.scope !== 'global-per-key' || capabilities.coherentValueRevision !== true
      || capabilities.reads !== 'possibly-stale' || typeof store.read !== 'function'
      || typeof store.compareAndSwap !== 'function') throw new TypeError();
    return Object.freeze({ name: binding.name, prefix: binding.prefix, store: Object.freeze({
      capabilities: Object.freeze({ atomicCreate: true as const, atomicReplace: true as const,
        scope: 'global-per-key' as const, coherentValueRevision: true as const, reads: 'possibly-stale' as const }),
      read: store.read.bind(store), compareAndSwap: store.compareAndSwap.bind(store),
    }) });
  } catch { throw new TypeError('Unsupported Tick coordination binding'); }
}

export function captureClock(clock: Clock): Clock {
  try {
    if (!object(clock) || typeof clock.nowMs !== 'function' || typeof clock.monotonicMs !== 'function') throw new TypeError();
    return Object.freeze({ nowMs: clock.nowMs.bind(clock), monotonicMs: clock.monotonicMs.bind(clock) });
  } catch { throw new TypeError('Invalid Tick clock binding'); }
}

export function captureIds(ids: IdSource): IdSource {
  try {
    if (!object(ids) || typeof ids.newAttemptToken !== 'function' || typeof ids.newMutationId !== 'function') throw new TypeError();
    return Object.freeze({ newAttemptToken: ids.newAttemptToken.bind(ids), newMutationId: ids.newMutationId.bind(ids) });
  } catch { throw new TypeError('Invalid Tick ID binding'); }
}

export function captureTelemetry(telemetry: Telemetry | undefined): Telemetry | undefined {
  try {
    if (telemetry === undefined) return undefined;
    if (!object(telemetry) || typeof telemetry.emit !== 'function') throw new TypeError();
    return Object.freeze({ emit: telemetry.emit.bind(telemetry) });
  } catch { throw new TypeError('Invalid Tick telemetry binding'); }
}

export function isNativeSignal(value: unknown): value is AbortSignal {
  try {
    if (!object(value)) return false;
    const signal = value as Partial<AbortSignal>;
    return typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function'
      && typeof signal.removeEventListener === 'function' && typeof signal.dispatchEvent === 'function'
      && typeof signal.throwIfAborted === 'function' && 'onabort' in signal;
  } catch { return false; }
}

function captureController(controller: CancellationController): CancellationController {
  try {
    const signal = controller?.signal, nativeSignal = controller?.nativeSignal;
    if (!object(signal) || signal.aborted !== false || typeof controller.abort !== 'function'
      || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') throw new TypeError();
    // Reject unrelated or notification-only "native" signals. These structural checks
    // do not certify a transport's cancellation semantics or a host's native brand.
    if (nativeSignal !== undefined && (nativeSignal !== signal || !isNativeSignal(nativeSignal))) throw new TypeError();
    return Object.freeze({ signal, ...(nativeSignal === undefined ? {} : { nativeSignal }), abort: controller.abort.bind(controller) });
  } catch { throw new TypeError('Invalid Tick cancellation binding'); }
}

export function captureRuntime(runtime: ExecutionRuntime): ExecutionRuntime {
  try {
    if (!object(runtime) || typeof runtime.createCancellationController !== 'function' || typeof runtime.setTimer !== 'function') throw new TypeError();
    const create = runtime.createCancellationController.bind(runtime), setTimer = runtime.setTimer.bind(runtime);
    const issued = new WeakSet<object>();
    return Object.freeze({ createCancellationController() {
      let controller;
      try { controller = captureController(create()); } catch { throw new TypeError('Invalid Tick cancellation binding'); }
      if (issued.has(controller.signal)) throw new TypeError('Tick cancellation binding must produce fresh signals');
      issued.add(controller.signal);
      return controller;
    }, setTimer(callback: () => void, delayMs: number) {
      try {
        if (typeof callback !== 'function' || !Number.isSafeInteger(delayMs) || delayMs <= 0) throw new TypeError();
        const cancel = setTimer(callback, delayMs);
        if (typeof cancel !== 'function') throw new TypeError();
        return cancel;
      } catch { throw new TypeError('Invalid Tick timer binding'); }
    } });
  } catch { throw new TypeError('Invalid Tick runtime binding'); }
}
