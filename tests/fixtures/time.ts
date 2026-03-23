import { vi } from "vitest";

const defaultFrozenTime = new Date("2026-01-01T00:00:00.000Z");

export function freezeTime(at: Date | string = defaultFrozenTime): Date {
  const frozenAt = at instanceof Date ? at : new Date(at);

  vi.useFakeTimers();
  vi.setSystemTime(frozenAt);

  return frozenAt;
}

export function advanceFrozenTimeBy(ms: number): void {
  vi.advanceTimersByTime(ms);
}

export function restoreTime(): void {
  vi.useRealTimers();
}
