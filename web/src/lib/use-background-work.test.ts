import { describe, expect, it } from "vitest";
import { isBackgroundWorkRow } from "./use-background-work";

/**
 * `isBackgroundWorkRow` is the runtime guard `useBackgroundWork` filters the
 * socket response through, replacing the old `as BackgroundWorkRow[]` cast
 * that let a wire response missing `exitCode` (or `at`) pass straight
 * through with no compile-time or run-time signal. These tests exist because
 * nothing else in this codebase would catch a regression here: loosening the
 * type back to `exitCode?: number` breaks no OTHER test.
 */
describe("isBackgroundWorkRow", () => {
  const runningRow = {
    id: "r1",
    kind: "process",
    label: "make build",
    startedAt: 1_000,
    terminal: null,
  };

  const finishedRow = {
    id: "f1",
    kind: "process",
    label: "make build",
    startedAt: 1_000,
    terminal: { outcome: "exited", reason: "process_exit", exitCode: 7, at: 8_000 },
  };

  it("accepts a running row", () => {
    expect(isBackgroundWorkRow(runningRow)).toBe(true);
  });

  it("accepts a finished row with a full terminal shape", () => {
    expect(isBackgroundWorkRow(finishedRow)).toBe(true);
  });

  it("accepts an explicit null exitCode (the unknown-exit-code state)", () => {
    expect(
      isBackgroundWorkRow({
        ...finishedRow,
        terminal: { ...finishedRow.terminal, exitCode: null },
      }),
    ).toBe(true);
  });

  it("rejects a terminal row with exitCode missing entirely — the exact shape the old `as` cast let through", () => {
    const { exitCode: _exitCode, ...terminalWithoutExitCode } = finishedRow.terminal;
    expect(isBackgroundWorkRow({ ...finishedRow, terminal: terminalWithoutExitCode })).toBe(false);
  });

  it("rejects a terminal row with `at` missing entirely", () => {
    const { at: _at, ...terminalWithoutAt } = finishedRow.terminal;
    expect(isBackgroundWorkRow({ ...finishedRow, terminal: terminalWithoutAt })).toBe(false);
  });

  it("rejects a row with an unrecognised kind", () => {
    expect(isBackgroundWorkRow({ ...runningRow, kind: "ghost" })).toBe(false);
  });

  it("rejects null and non-objects", () => {
    expect(isBackgroundWorkRow(null)).toBe(false);
    expect(isBackgroundWorkRow("not a row")).toBe(false);
    expect(isBackgroundWorkRow(42)).toBe(false);
  });
});
