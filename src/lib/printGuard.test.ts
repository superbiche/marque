import { describe, it, expect } from "vitest";
import {
  PrintGuard,
  createPrintGuard,
  PRINT_GUARD_FALLBACK_MS,
  type PrintGuardClock,
} from "./printGuard";

// A deterministic fake clock: timers are stored, not really scheduled, and
// advanced by hand so tests never wait on the real timer.
class FakeClock implements PrintGuardClock {
  private now = 0;
  private next = 1;
  private timers = new Map<unknown, { fn: () => void; due: number }>();

  setTimeout(fn: () => void, ms: number) {
    const handle = this.next++;
    this.timers.set(handle, { fn, due: this.now + ms });
    return handle;
  }

  clearTimeout(handle: unknown) {
    this.timers.delete(handle);
  }

  // Number of live timers — used to assert the guard schedules exactly one
  // fallback and that release() cancels it.
  get pending(): number {
    return this.timers.size;
  }

  // Advance virtual time, firing every due timer in due order.
  advance(ms: number) {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.due <= target)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) break;
      const [handle, t] = due;
      this.now = t.due;
      this.timers.delete(handle);
      t.fn();
    }
    this.now = target;
  }
}

// Build a guard over a shared fake clock so a test can both drive the guard
// and inspect/advance the clock it scheduled on.
function armedPair() {
  const clock = new FakeClock();
  const guard = new PrintGuard(clock);
  return { guard, clock };
}

describe("PrintGuard", () => {
  it("starts unblocked with no timer scheduled", () => {
    const { guard, clock } = armedPair();
    expect(guard.isBlocked).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it("blocks re-entry once armed and schedules exactly one fallback", () => {
    const { guard, clock } = armedPair();
    guard.arm();
    expect(guard.isBlocked).toBe(true);
    expect(clock.pending).toBe(1);
  });

  it("a re-arm while armed is a no-op and does not extend the bound", () => {
    const { guard, clock } = armedPair();
    guard.arm();
    guard.arm();
    guard.arm();
    expect(guard.isBlocked).toBe(true);
    // Still exactly one live timer: re-arms don't stack.
    expect(clock.pending).toBe(1);
    // The single fallback still releases at the original bound.
    clock.advance(PRINT_GUARD_FALLBACK_MS);
    expect(guard.isBlocked).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it("the bounded fallback releases the guard when no signal fires (macOS)", () => {
    const { guard, clock } = armedPair();
    guard.arm();
    // Just before the bound: still blocked.
    clock.advance(PRINT_GUARD_FALLBACK_MS - 1);
    expect(guard.isBlocked).toBe(true);
    // Crossing the bound: the fallback fires and releases.
    clock.advance(1);
    expect(guard.isBlocked).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it("release() cancels the fallback so a late firing cannot re-arm", () => {
    const { guard, clock } = armedPair();
    guard.arm();
    guard.release();
    // The timer was cancelled, not merely the flag cleared.
    expect(guard.isBlocked).toBe(false);
    expect(clock.pending).toBe(0);
    // Even if the clock advanced past the original bound, nothing re-arms.
    clock.advance(PRINT_GUARD_FALLBACK_MS * 2);
    expect(guard.isBlocked).toBe(false);
  });

  it("release() is idempotent (including before ever arming)", () => {
    const { guard } = armedPair();
    // Releasing with never having armed must not throw or arm anything.
    expect(() => guard.release()).not.toThrow();
    expect(guard.isBlocked).toBe(false);
    guard.arm();
    guard.release();
    expect(guard.release()).toBeUndefined();
    expect(guard.isBlocked).toBe(false);
  });

  it("re-arms after a release and re-runs its own bounded fallback", () => {
    const { guard, clock } = armedPair();
    guard.arm();
    guard.release();
    guard.arm();
    expect(guard.isBlocked).toBe(true);
    expect(clock.pending).toBe(1);
    clock.advance(PRINT_GUARD_FALLBACK_MS);
    expect(guard.isBlocked).toBe(false);
  });

  it("createPrintGuard returns a working guard over the default clock", () => {
    const guard = createPrintGuard();
    expect(guard.isBlocked).toBe(false);
    // No clock injected: use the real one, but only assert arm/release
    // transitions here (the real timer is long; do not advance it).
    guard.arm();
    expect(guard.isBlocked).toBe(true);
    guard.release();
    expect(guard.isBlocked).toBe(false);
  });
});
