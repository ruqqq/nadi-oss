import { describe, expect, it } from "vitest";
import {
  MODEL_SWITCH_PART_TYPE,
  modelSwitchPart,
  readModelSwitchPart,
  sameModelTuple,
} from "../../../src/agent/model-switch";

const data = {
  from: { provider: "openai", model: "gpt-5" },
  to: { provider: "anthropic", model: "claude-opus-5" },
};

describe("model switch marker", () => {
  it("builds a data part with the reserved type", () => {
    expect(modelSwitchPart(data)).toEqual({ type: MODEL_SWITCH_PART_TYPE, data });
  });

  it("round-trips through the reader", () => {
    expect(readModelSwitchPart(modelSwitchPart(data))).toEqual(data);
  });

  it("rejects parts of the wrong type", () => {
    expect(readModelSwitchPart({ type: "text", text: "hi" })).toBeNull();
  });

  it("rejects a marker with a malformed payload", () => {
    expect(readModelSwitchPart({ type: MODEL_SWITCH_PART_TYPE, data: { to: {} } })).toBeNull();
    expect(readModelSwitchPart({ type: MODEL_SWITCH_PART_TYPE })).toBeNull();
    expect(readModelSwitchPart(null)).toBeNull();
  });

  it("compares tuples on provider AND model", () => {
    expect(
      sameModelTuple(
        { provider: "openrouter", model: "a" },
        { provider: "openrouter", model: "a" },
      ),
    ).toBe(true);
    expect(
      sameModelTuple(
        { provider: "openrouter", model: "anthropic/claude" },
        { provider: "openrouter", model: "openai/gpt-5" },
      ),
    ).toBe(false);
  });
});
