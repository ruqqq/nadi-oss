import { describe, expect, it } from "vitest";
import * as server from "../../../src/agent/model-switch";
import * as web from "../../../web/src/lib/model-switch";

/**
 * `web/src/lib/model-switch.ts` hand-duplicates `src/agent/model-switch.ts`
 * because `web/` is a separate package whose tsconfig cannot reach `src/`
 * (see that file's own doc). Nothing else enforces the two stay identical: a
 * silent rename of `"data-model-switch"` on one side would leave the
 * server's sanitizer unable to segment the transcript AND the client's
 * divider unable to render it — with every OTHER test on both sides still
 * green, since each side only ever exercises its own copy.
 *
 * This project pulls web/src into the strict root typecheck (see
 * nadi-web-lib-typechecked-under-worker-tsconfig), so it can import both
 * trees by relative path with no build-step wiring.
 */
describe("model-switch marker parity", () => {
  it("agrees on the wire constant", () => {
    expect(web.MODEL_SWITCH_PART_TYPE).toBe(server.MODEL_SWITCH_PART_TYPE);
  });

  it("produces an identical part from both constructors", () => {
    const data = {
      from: { provider: "openai", model: "gpt-5" },
      to: { provider: "anthropic", model: "claude-opus-5" },
    };
    expect(web.modelSwitchPart(data)).toEqual(server.modelSwitchPart(data));
  });

  it("agrees on a valid marker", () => {
    const part = server.modelSwitchPart({
      from: { provider: "openai", model: "gpt-5" },
      to: { provider: "anthropic", model: "claude-opus-5" },
    });
    expect(web.readModelSwitchPart(part)).toEqual(server.readModelSwitchPart(part));
    expect(web.readModelSwitchPart(part)).toEqual({
      from: { provider: "openai", model: "gpt-5" },
      to: { provider: "anthropic", model: "claude-opus-5" },
    });
  });

  it("agrees on every rejection case", () => {
    const cases: unknown[] = [
      null,
      undefined,
      "not-an-object",
      { type: "data-something-else", data: { from: { provider: "a", model: "b" }, to: { provider: "c", model: "d" } } },
      { type: server.MODEL_SWITCH_PART_TYPE },
      { type: server.MODEL_SWITCH_PART_TYPE, data: null },
      { type: server.MODEL_SWITCH_PART_TYPE, data: "not-an-object" },
      // Malformed `from`: missing model.
      {
        type: server.MODEL_SWITCH_PART_TYPE,
        data: { from: { provider: "openai" }, to: { provider: "anthropic", model: "claude-opus-5" } },
      },
      // Malformed `to`: empty provider.
      {
        type: server.MODEL_SWITCH_PART_TYPE,
        data: { from: { provider: "openai", model: "gpt-5" }, to: { provider: "", model: "claude-opus-5" } },
      },
      // Malformed `from`: wrong type for model.
      {
        type: server.MODEL_SWITCH_PART_TYPE,
        data: {
          from: { provider: "openai", model: 5 },
          to: { provider: "anthropic", model: "claude-opus-5" },
        },
      },
    ];

    for (const testCase of cases) {
      expect(web.readModelSwitchPart(testCase), JSON.stringify(testCase)).toEqual(
        server.readModelSwitchPart(testCase),
      );
      expect(server.readModelSwitchPart(testCase), JSON.stringify(testCase)).toBeNull();
    }
  });

  it("agrees on tuple equality, including provider-same/model-different", () => {
    const a = { provider: "openai", model: "gpt-5" };
    const sameBoth = { provider: "openai", model: "gpt-5" };
    const sameProviderOnly = { provider: "openai", model: "gpt-5-mini" };
    const neitherSame = { provider: "anthropic", model: "claude-opus-5" };

    for (const b of [sameBoth, sameProviderOnly, neitherSame]) {
      expect(web.sameModelTuple(a, b)).toBe(server.sameModelTuple(a, b));
    }
    expect(web.sameModelTuple(a, sameBoth)).toBe(true);
    expect(web.sameModelTuple(a, sameProviderOnly)).toBe(false);
    expect(web.sameModelTuple(a, neitherSame)).toBe(false);
  });
});

/**
 * The client READS the marker (MessageRow renders the divider from it) but
 * must never WRITE one. Client-side attachment made the marker conditional on
 * one send path: an automaton tick, a failed `getPendingModelSwitch`
 * hydration and the feedback branch all committed switches the transcript
 * never recorded, and two queued sends drew two dividers for one switch —
 * naming a model that never ran, since only the last queued switch applies.
 * The server writes it from the commit it actually performs.
 */
describe("the client never writes the marker", () => {
  it("App.tsx does not construct a model-switch part", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("web/src/App.tsx", "utf8"),
    );
    expect(source).not.toContain("modelSwitchPart(");
  });
});
