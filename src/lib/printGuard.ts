// Minimal clock seam so the guard can be driven deterministically in tests;
// the default is the real global interval API.
export interface PrintGuardClock {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemClock: PrintGuardClock = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as number),
};

// How often the guard re-checks whether the print sheet has closed (the window
// regained focus) while it is armed. Short enough to feel instant, infrequent
// enough to be free. This is a *backstop*, not the primary release — the
// afterprint / focus / visibilitychange signals release sooner.
export const PRINT_GUARD_CHECK_INTERVAL_MS = 2_000;

// Default focus probe. The print sheet holds the webview's focus while it is
// open and returns it when the sheet closes (confirmed on macOS); `hasFocus()`
// is false while the sheet is up and true once it is dismissed. Taken as a
// seam so tests can drive it.
const defaultIsFocused = (): boolean =>
  typeof document !== "undefined" && document.hasFocus();

export interface PrintGuardOptions {
  /** Injectable clock (defaults to the global interval API). */
  clock?: PrintGuardClock;
  /** Whether the window currently has focus (defaults to document.hasFocus). */
  isFocused?: () => boolean;
  /** How often the guard re-checks focus while armed (default 2 s). */
  checkIntervalMs?: number;
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
// again. There is no time-based release: the poll never releases while the
// sheet still holds the window's focus (a sheet left open stays guarded,
// however long it stays open), and the guard cannot stick in any user sense —
// the moment the user can interact with the window again the sheet is closed,
// focus has returned, and the next poll releases.
//
// The class touches no globals: all timing goes through the injected clock and
// all focus through the injected predicate, so it is a pure, unit-testable
// piece.
export class PrintGuard {
  private _armed = false;
  private _focusPoll: unknown;
  private readonly _clock: PrintGuardClock;
  private readonly _isFocused: () => boolean;
  private readonly _checkIntervalMs: number;

  constructor(options: PrintGuardOptions = {}) {
    this._clock = options.clock ?? systemClock;
    this._isFocused = options.isFocused ?? defaultIsFocused;
    this._checkIntervalMs = options.checkIntervalMs ?? PRINT_GUARD_CHECK_INTERVAL_MS;
  }

  // True while a print is in flight and re-entry must be blocked.
  get isBlocked(): boolean {
    return this._armed;
  }

  // Arm the guard. Idempotent: if already armed, a re-arm is a no-op and the
  // first arm's interval is kept, so a blocked re-print never stacks timers.
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
  }

  // Release the guard. Idempotent. Cancels the focus-poll interval so a late
  // tick after an earlier release is a no-op.
  release(): void {
    if (!this._armed) return;
    this._armed = false;
    this._clock.clearInterval(this._focusPoll);
  }
}

export function createPrintGuard(options?: PrintGuardOptions): PrintGuard {
  return new PrintGuard(options);
}
