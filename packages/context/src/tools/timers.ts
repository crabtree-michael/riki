/**
 * The one impure thing this component does, behind an interface so it is not impure in a test.
 *
 * `Clock` (a port, `../common/types.ts`) answers *what time is it*; this answers *wake me later*.
 * They are separate because the watchdog needs both and a test needs to control both without
 * waiting 1200 ms of real time to watch a deadline fire — `ManualTimers` in `testing/` is what
 * makes every deadline test run in microseconds and never flake.
 */

export interface Timers {
  /** Returns a cancel function. Calling it after the timer fired is a no-op. */
  after(ms: number, fn: () => void): () => void;
}

export const systemTimers: Timers = {
  after(ms: number, fn: () => void): () => void {
    // `unref` where it exists: a pending watchdog must never be the reason the process stays up.
    const handle: ReturnType<typeof setTimeout> = setTimeout(fn, Math.max(0, ms));
    if (typeof handle === 'object' && 'unref' in handle) handle.unref();
    return () => {
      clearTimeout(handle);
    };
  },
};
