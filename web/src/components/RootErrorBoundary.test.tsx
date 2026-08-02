// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recover = vi.hoisted(() => vi.fn(() => Promise.resolve("recovering" as const)));
vi.mock("@/lib/stale-bundle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stale-bundle")>()),
  recoverFromStaleBundle: recover,
}));

import { RootErrorBoundary } from "./RootErrorBoundary";

function Boom({ error }: { error: Error }): never {
  throw error;
}

function chunkError() {
  return new Error("Failed to fetch dynamically imported module: /assets/Settings-a1b2.js");
}

beforeEach(() => {
  recover.mockClear();
  // React logs the caught error; keep the run readable.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RootErrorBoundary", () => {
  it("recovers onto the new build when a chunk is missing", () => {
    render(
      <RootErrorBoundary>
        <Boom error={chunkError()} />
      </RootErrorBoundary>,
    );
    expect(recover).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Nadi was updated")).toBeTruthy();
  });

  it("does NOT auto-reload on a real crash — that would be a reload loop", () => {
    render(
      <RootErrorBoundary>
        <Boom error={new Error("Cannot read properties of undefined")} />
      </RootErrorBoundary>,
    );
    expect(recover).not.toHaveBeenCalled();
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("renders its children when nothing throws", () => {
    render(
      <RootErrorBoundary>
        <p>All good</p>
      </RootErrorBoundary>,
    );
    expect(screen.getByText("All good")).toBeTruthy();
  });
});
