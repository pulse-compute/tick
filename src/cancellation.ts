import type { CancellationController, CancellationSignal } from './index.js';

/** Local cancellation for hosts without native AbortController. Never pass this to fetch. */
export function createCooperativeController(): CancellationController {
  let aborted = false;
  const listeners = new Set<() => void>();
  const signal: CancellationSignal = Object.freeze({
    get aborted() { return aborted; },
    addEventListener(type: 'abort', listener: () => void) {
      if (type !== 'abort' || typeof listener !== 'function') throw new TypeError('Invalid Tick cancellation listener');
      if (!aborted) listeners.add(listener);
    },
    removeEventListener(type: 'abort', listener: () => void) {
      if (type === 'abort') listeners.delete(listener);
    },
  });
  return Object.freeze({ signal, abort() {
    if (aborted) return;
    aborted = true;
    const callbacks = [...listeners];
    listeners.clear();
    for (const callback of callbacks) {
      try { callback(); } catch { /* One listener must not prevent cancellation of others. */ }
    }
  } });
}
