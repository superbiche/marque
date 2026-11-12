// Minimal clock seam so the guard can be driven deterministically in tests;
// the default is the real global timer/interval API.
export interface PrintGuardClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemClock: PrintGuardClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as number),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as number),
};

// How often the guard re-checks whether the print sheet has closed (the window
// regained focus) while it is armed. Short enough to feel instant, infrequent
// enough to be free. This is a *backstop*, not the primary release — the
// afterprint / focus / visibilitychange signals release sooner.
export const PRINT_GUARD_CHECK_INTERVAL_MS = 2_000;

// Absolute ceiling: even if the window never reports focus again (a missed
// signal or a stuck sheet), the guard releases here so it can never stick.
// 10 minutes is far longer than any print sheet is realistically left open.
export const PRINT_GUARD_ABSOLUTE_MS = 10 * 60 * 1_000;

// Default focus probe. The print sheet holds the webview's focus while it is
// open and returns it when the sheet closes (confirmed on macOS); `hasFocus()`
// is false while the sheet is up and true once it is dismissed. Taken as a
// seam so tests can drive it.
const defaultIsFocused = (): boolean =>
  typeof document !== "undefined" && document.hasFocus();

export interface PrintGuardOptions {
  /** Injectable clock (defaults to the global timer/interval API). */
  clock?: PrintGuardClock;
  /** Whether the window currently has focus (defaults to document.hasFocus). */
  isFocused?: () => boolean;
  /** How often the guard re-checks focus while armed (default 2 s). */
  checkIntervalMs?: number;
  /** Absolute release ceiling, in ms (default 10 min). */
  absoluteMs?: number;
}

// Re-entry guard for window.print().
//
// Arming is synchronous — it happens before the platform print is actually
// invoked — so a second print trigger while a sheet/dialog is up is dropped.
// The guard releases on whichever of the *primary* completion signals fires
// first:
//   - `afterprint`             the native print path (WebKitGTK, WebView2) done.
//   - `focus`                  the print sheet/dialog closes and the window
//                              regains focus (confirmed to fire on macOS).
//   - `visibilitychange`->visible  the page is visible again after a
//                              full-screen print preview.
// As a *backstop* for the case where a primary signal is missed, it re-checks
// focus on a short interval and releases as soon as the window has focus
// again — and it releases unconditionally after the absolute ceiling so it can
// never stick. Crucially the focus-poll never releases while the sheet still
// holds the window's focus, which is exactly the case the fixed 60 s timer of
// round 1 got wrong (a sheet left open past 60 s would re-allow a second
// sheet).
//
// The class touches no globals: all timing goes through the injected clock and
// all focus through the injected predicate, so it is a pure, unit-testable
// piece.
export class PrintGuard {
  private _armed = false;
  private _focusPoll: unknown;
  private _absolute: unknown;
  private readonly _clock: PrintGuardClock;
  private readonly _isFocused: () => boolean;
  private readonly _checkIntervalMs: number;
  private readonly _absoluteMs: number;

  constructor(options: PrintGuardOptions = {}) {
    this._clock = options.clock ?? systemClock;
    this._isFocused = options.isFocused ?? defaultIsFocused;
    this._checkIntervalMs = options.checkIntervalMs ?? PRINT_GUARD_CHECK_INTERVAL_MS;
    this._absoluteMs = options.absoluteMs ?? PRINT_GUARD_ABSOLUTE_MS;
  }

  // True while a print is in flight and re-entry must be blocked.
  get isBlocked(): boolean {
    return this._armed;
  }

  // Arm the guard. Idempotent: if already armed, a re-arm is a no-op and the
  // first arm's timers are kept, so a blocked re-print never extends the
  // bound.
  arm(): void {
    if (this._armed) return;
    this._armed = true;
    // Polled backstop: release only once the window has focus again, i.e. the
    // sheet has closed. It never releases while the sheet still holds focus.
    this._focusPoll = this._clock.setInterval(
      () => {
        if (this._isFocused()) this.release();
      },
      this._checkIntervalMs,
    );
    // Absolute backstop: release no matter what, so the guard never sticks.
    this._absolute = this._clock.setTimeout(
      () => this.release(),
      this._absoluteMs,
    );
  }

  // Release the guard. Idempotent. Cancels the focus-poll interval and the
  // absolute timer so a late firing after an earlier release is a no-op.
  release(): void {
    if (!this._armed) return;
    this._armed = false;
    this._clock.clearInterval(this._focusPoll);
    this._clock.clearTimeout(this._absolute);
  }
}

export function createPrintGuard(options?: PrintGuardOptions): PrintGuard {
  return new PrintGuard(options);
}
