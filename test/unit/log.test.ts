import { describe, expect, it, vi } from "vitest";
import { log, setLogLevel } from "../../src/log";

describe("structured logger", () => {
  it("emits JSON fields at or above the current level", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    setLogLevel("info");

    log.debug("ignored.event", { value: 1 });
    log.info("kept.event", { value: 2 });

    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(spy.mock.calls[0]?.[0]));
    expect(parsed).toMatchObject({
      level: "info",
      event: "kept.event",
      value: 2,
    });
    expect(typeof parsed.ts).toBe("string");
  });
});
