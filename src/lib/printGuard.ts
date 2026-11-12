// Minimal clock seam so the guard can be driven deterministically in tests;
// the default is the real global setTimeout/clearTimeout.
export interface PrintGuardClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: PrintGuardClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as number),
};

// How long re-entry stays blocked after a print is triggered when no
// completion signal (afterprint / focus / visibility) arrives in time.
// macOS is the only platform where none of those fire: Tauri overrides
// window.print with a native NSPrintOperation that reports no completion to
// the page (wry 0.57, wkwebview/mod.rs:953 — separate thread, no delegate).
// 60 s is generous enough to never cut a real print short, bounded enough
// that the guard can never stick.
export const PRINT_GUARD_FALLBACK_MS = 60_000;

// Re-entry guard for window.print().
//
// Arming is synchronous — it happens before the platform print is actually
// invoked — so a second print trigger while a sheet/dialog is up is dropped.
// The guard releases itself on whichever observable completion signal fires
// first:
//   - `afterprint`           the native print path (WebKitGTK, WebView2) done.
//   - `focus`                the print dialog is a separate modal window; the
//                            main window regains focus when it closes.
//   - `visibilitychange`->visible  the page is visible again after a
//                            full-screen print preview.
//   - the bounded fallback timer above — the guaranteed release, and the only
//     one macOS ever reaches (see PRINT_GUARD_FALLBACK_MS).
//
// The class touches no globals: all timing goes through the injected clock,
// so it is a pure, unit-testable piece.
export class PrintGuard {
  private _armed = false;
  private _fallback: unknown;

  constructor(private readonly clock: PrintGuardClock = systemClock) {}

  // True while a print is in flight and re-entry must be blocked.
  get isBlocked(): boolean {
    return this._armed;
  }

  // Arm the guard. Idempotent: if already armed, a re-arm is a no-op and the
  // first arm's fallback timer is kept, so a blocked re-print never extends
  // the bound.
  arm(): void {
    if (this._armed) return;
    this._armed = true;
    this._fallback = this.clock.setTimeout(
      () => this.release(),
      PRINT_GUARD_FALLBACK_MS,
    );
  }

  // Release the guard. Idempotent. Cancels the pending fallback timer so a
  // late signal (or the fallback) after an earlier release is a no-op.
  release(): void {
    if (!this._armed) return;
    this._armed = false;
    this.clock.clearTimeout(this._fallback);
    this._fallback = undefined;
  }
}

export function createPrintGuard(clock?: PrintGuardClock): PrintGuard {
  return new PrintGuard(clock);
}
