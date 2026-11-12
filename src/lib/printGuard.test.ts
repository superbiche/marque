import { describe, it, expect } from "vitest";
import {
  PrintGuard,
  createPrintGuard,
  PRINT_GUARD_CHECK_INTERVAL_MS,
  PRINT_GUARD_ABSOLUTE_MS,
  type PrintGuardClock,
} from "./printGuard";

// A deterministic fake clock: one-shot timers fire at their due time, intervals
// fire at each period boundary, and `advance` walks through them in
// chronological order so tests never wait on a real timer.
class FakeClock implements PrintGuardClock {
  private now = 0;
  private next = 1;
  private timeouts = new Map<unknown, { fn: () => void; due: number }>();
  private intervals = new Map<unknown, { fn: () => void; period: number; last: number }>();

  get pending(): number {
    return this.timeouts.size + this.intervals.size;
  }

  setTimeout(fn: () => void, ms: number) {
    const handle = this.next++;
    this.timeouts.set(handle, { fn, due: this.now + ms });
    return handle;
  }
  clearTimeout(handle: unknown) {
    this.timeouts.delete(handle);
  }
  setInterval(fn: () => void, ms: number) {
    const handle = this.next++;
    this.intervals.set(handle, { fn, period: ms, last: this.now });
    return handle;
  }
  clearInterval(handle: unknown) {
    this.intervals.delete(handle);
  }

  // Advance virtual time, firing the earliest scheduled event (an interval tick
  // or a one-shot timeout) each step until `target` is reached.
  advance(ms: number) {
    const target = this.now + ms;
    for (;;) {
      let nextTime: number | null = null;
      for (const t of this.timeouts.values()) {
        if (t.due > this.now && t.due <= target && (nextTime === null || t.due < nextTime)) {
          nextTime = t.due;
        }
      }
      for (const i of this.intervals.values()) {
        const due = i.last + i.period;
        if (due > this.now && due <= target && (nextTime === null || due < nextTime)) {
          nextTime = due;
        }
      }
      if (nextTime === null) break;
      this.now = nextTime;
      // One-shot timeouts due now (snapshot so release() deleting them is safe).
      for (const [handle, t] of [...this.timeouts]) {
        if (t.due === this.now) {
          this.timeouts.delete(handle);
          t.fn();
        }
      }
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

  it("arms re-entry and schedules both the focus-poll and the absolute backstop", () => {
    const { guard, clock } = makeGuard();
    guard.arm();
    expect(guard.isBlocked).toBe(true);
    // One interval (focus poll) + one timeout (absolute) = two live timers.
    expect(clock.pending).toBe(2);
  });

  it("a re-arm while armed is a no-op and does not stack timers", () => {
    const { guard, clock } = makeGuard();
    guard.arm();
    guard.arm();
    guard.arm();
    expect(guard.isBlocked).toBe(true);
    expect(clock.pending).toBe(2);
  });

  // The round-2 fix: the old 60 s one-shot timer released on its own, so a
  // sheet left open past 60 s re-allowed a second sheet. The focus-poll must
  // NOT release while the window has no focus (i.e. the sheet is still up).
  it("stays blocked with no focus well past the old 60 s window", () => {
    const { guard, clock, focus } = makeGuard();
    focus.value = false; // sheet holds the window's focus
    guard.arm();
    // 120 s — double the old 60 s fallback. The poll fires throughout but the
    // window never regains focus, so the guard must stay armed.
    clock.advance(120 * 1_000);
    expect(guard.isBlocked).toBe(true);
    // The backstops are still live (not released by the poll).
    expect(clock.pending).toBe(2);
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
    // Release cancels both backstops.
    expect(clock.pending).toBe(0);
  });

  it("releases at the absolute bound even if focus never returns", () => {
    const { guard, clock, focus } = makeGuard();
    focus.value = false; // stuck: focus never comes back
    guard.arm();
    // Just before the bound: the poll never released, still armed.
    clock.advance(PRINT_GUARD_ABSOLUTE_MS - 1);
    expect(guard.isBlocked).toBe(true);
    // At the bound: the one-shot backstop releases unconditionally.
    clock.advance(1);
    expect(guard.isBlocked).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it("release() is idempotent and cancels both backstops", () => {
    const { guard, clock } = makeGuard();
    // Releasing before ever arming must not throw or arm anything.
    expect(() => guard.release()).not.toThrow();
    expect(guard.isBlocked).toBe(false);
    guard.arm();
    guard.release();
    expect(guard.isBlocked).toBe(false);
    expect(clock.pending).toBe(0);
    // Advancing far past both bounds cannot re-arm anything.
    clock.advance(PRINT_GUARD_ABSOLUTE_MS * 2);
    expect(guard.isBlocked).toBe(false);
  });

  it("re-arms after a release and re-runs its own backstops", () => {
    const { guard, clock } = makeGuard();
    guard.arm();
    guard.release();
    expect(clock.pending).toBe(0);
    guard.arm();
    expect(guard.isBlocked).toBe(true);
    expect(clock.pending).toBe(2);
  });

  it("createPrintGuard returns a working guard over the default clock", () => {
    // No clock/focus injected: uses the real globals. Only assert arm/release
    // transitions here (no time is advanced, so the long backstops never run
    // and the real document is never queried).
    const guard = createPrintGuard();
    expect(guard.isBlocked).toBe(false);
    guard.arm();
    expect(guard.isBlocked).toBe(true);
    guard.release();
    expect(guard.isBlocked).toBe(false);
  });
});
