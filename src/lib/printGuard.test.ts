import { describe, it, expect } from "vitest";
import {
  PrintGuard,
  createPrintGuard,
  PRINT_GUARD_CHECK_INTERVAL_MS,
  type PrintGuardClock,
} from "./printGuard";

// A deterministic fake clock: intervals fire at each period boundary, and
// `advance` walks through them in chronological order so tests never wait on
// a real timer.
class FakeClock implements PrintGuardClock {
  private now = 0;
  private next = 1;
  private intervals = new Map<unknown, { fn: () => void; period: number; last: number }>();

  get pending(): number {
    return this.intervals.size;
  }

  setInterval(fn: () => void, ms: number) {
    const handle = this.next++;
    this.intervals.set(handle, { fn, period: ms, last: this.now });
    return handle;
  }
  clearInterval(handle: unknown) {
    this.intervals.delete(handle);
  }

  // Advance virtual time, firing each interval tick at every period boundary
  // reached, until `target` is reached.
  advance(ms: number) {
    const target = this.now + ms;
    for (;;) {
      let nextTime: number | null = null;
      for (const i of this.intervals.values()) {
        const due = i.last + i.period;
        if (due > this.now && due <= target && (nextTime === null || due < nextTime)) {
          nextTime = due;
        }
      }
      if (nextTime === null) break;
      this.now = nextTime;
      // Interval ticks due now (fire each period boundary reached).
      for (const i of this.intervals.values()) {
        while (i.last + i.period <= this.now) {
          i.last += i.period;
          i.fn();
        }
      }
    }
    this.now = target;
  }
}

// Build a guard over a shared fake clock and a focus predicate that a test can
// flip, so a test can both drive the guard and control when focus returns.
function makeGuard(focus?: { value: boolean }) {
  const state = focus ?? { value: false };
  const clock = new FakeClock();
  const guard = new PrintGuard({ clock, isFocused: () => state.value });
  return { guard, clock, focus: state };
}

describe("PrintGuard", () => {
  it("starts unblocked with no timer scheduled", () => {
    const { guard, clock } = makeGuard();
    expect(guard.isBlocked).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it("arms re-entry and schedules the focus-poll backstop", () => {
    const { guard, clock } = makeGuard();
    guard.arm();
    expect(guard.isBlocked).toBe(true);
    // One live interval (the focus poll); there is no time-based release.
    expect(clock.pending).toBe(1);
  });

  it("a re-arm while armed is a no-op and does not stack timers", () => {
    const { guard, clock } = makeGuard();
    guard.arm();
    guard.arm();
    guard.arm();
    expect(guard.isBlocked).toBe(true);
    expect(clock.pending).toBe(1);
  });

  // The round-3 fix: release is signal/focus-driven only, never time-driven.
  // A sheet left open — for an hour — while the window has no focus stays
  // guarded, because the focus-poll never releases while focus is away.
  it("stays blocked with focus still away, even with a sheet left open for an hour", () => {
    const { guard, clock, focus } = makeGuard();
    focus.value = false; // sheet holds the window's focus
    guard.arm();
    // One hour: the poll fires throughout but the window never regains focus,
    // so the guard must stay armed.
    clock.advance(60 * 60 * 1_000);
    expect(guard.isBlocked).toBe(true);
    // The backstop is still live (not released by the poll).
    expect(clock.pending).toBe(1);
  });

  it("releases when focus returns (the sheet closed)", () => {
    const { guard, clock, focus } = makeGuard();
    focus.value = false;
    guard.arm();
    // Not yet: the window still has no focus at the first poll.
    clock.advance(PRINT_GUARD_CHECK_INTERVAL_MS);
    expect(guard.isBlocked).toBe(true);
    // Sheet closes -> the window regains focus; the next poll releases.
    focus.value = true;
    clock.advance(PRINT_GUARD_CHECK_INTERVAL_MS);
    expect(guard.isBlocked).toBe(false);
    // Release cancels the focus-poll.
    expect(clock.pending).toBe(0);
  });

  it("release() is idempotent and cancels the focus-poll", () => {
    const { guard, clock } = makeGuard();
    // Releasing before ever arming must not throw or arm anything.
    expect(() => guard.release()).not.toThrow();
    expect(guard.isBlocked).toBe(false);
    guard.arm();
    guard.release();
    expect(guard.isBlocked).toBe(false);
    expect(clock.pending).toBe(0);
    // Advancing a long time cannot re-arm anything.
    clock.advance(60 * 60 * 1_000);
    expect(guard.isBlocked).toBe(false);
  });

  it("re-arms after a release and re-runs the focus-poll", () => {
    const { guard, clock } = makeGuard();
    guard.arm();
    guard.release();
    expect(clock.pending).toBe(0);
    guard.arm();
    expect(guard.isBlocked).toBe(true);
    expect(clock.pending).toBe(1);
  });

  it("createPrintGuard returns a working guard over the default clock", () => {
    // No clock/focus injected: uses the real globals. Only assert arm/release
    // transitions here (no time is advanced, so the real interval never runs
    // and the real document is never queried).
    const guard = createPrintGuard();
    expect(guard.isBlocked).toBe(false);
    guard.arm();
    expect(guard.isBlocked).toBe(true);
    guard.release();
    expect(guard.isBlocked).toBe(false);
  });
});
