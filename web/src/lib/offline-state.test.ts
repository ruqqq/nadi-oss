import { describe, expect, test } from "vitest";
import { OfflineError, isNetworkFailure, isOfflineError, resolveOffline } from "./offline-state";

describe("resolveOffline", () => {
  // A successful probe is proof, not a hint: if the `online` event was missed,
  // `navigator.onLine` can still read a stale `false` while the server answers.
  test("a reachable probe beats a stale browserOnline: false", () => {
    expect(resolveOffline({ browserOnline: false, reachability: "reachable" })).toBe(false);
  });

  // navigator.onLine happily reports `true` on a connected-but-dead network
  // (captive portal, dead uplink), so a failed probe must flip us offline.
  test("an unreachable probe beats browserOnline: true", () => {
    expect(resolveOffline({ browserOnline: true, reachability: "unreachable" })).toBe(true);
  });

  test("unreachable is offline when the browser agrees", () => {
    expect(resolveOffline({ browserOnline: false, reachability: "unreachable" })).toBe(true);
  });

  test("reachable is online when the browser agrees", () => {
    expect(resolveOffline({ browserOnline: true, reachability: "reachable" })).toBe(false);
  });

  // No probe evidence yet (cold mount, or reset by a browser `offline` event):
  // the browser's hint is all we have.
  test("unknown falls back to browserOnline: false", () => {
    expect(resolveOffline({ browserOnline: false, reachability: "unknown" })).toBe(true);
  });

  test("unknown falls back to browserOnline: true", () => {
    expect(resolveOffline({ browserOnline: true, reachability: "unknown" })).toBe(false);
  });
});

describe("isOfflineError", () => {
  test("recognises an OfflineError", () => {
    expect(isOfflineError(new OfflineError())).toBe(true);
  });

  test("rejects other errors", () => {
    expect(isOfflineError(new Error("nope"))).toBe(false);
    expect(isOfflineError("nope")).toBe(false);
  });
});

describe("isNetworkFailure", () => {
  test("a fetch rejection is a network failure", () => {
    expect(isNetworkFailure(new TypeError("Failed to fetch"))).toBe(true);
  });

  test("an OfflineError is a network failure", () => {
    expect(isNetworkFailure(new OfflineError())).toBe(true);
  });

  // errorFromResponse produces a plain Error for a real HTTP reply — the server
  // was reachable, so this must NOT be treated as offline.
  test("an HTTP error is not a network failure", () => {
    expect(isNetworkFailure(new Error("Workspace not found"))).toBe(false);
  });
});
