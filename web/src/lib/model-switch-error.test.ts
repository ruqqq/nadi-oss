import { describe, expect, it } from "vitest";
import { modelSwitchErrorMessage, modelSwitchUnreachableMessage } from "./model-switch-error";

describe("modelSwitchErrorMessage", () => {
  it("explains a known code and still quotes it", () => {
    const message = modelSwitchErrorMessage("provider_not_usable");
    expect(message).toContain("isn't set up for this workspace");
    expect(message).toContain("provider_not_usable");
  });

  it("quotes an unknown code rather than swallowing it", () => {
    expect(modelSwitchErrorMessage("some_new_code")).toContain("some_new_code");
  });

  it("distinguishes an unreachable RPC from a rejection", () => {
    expect(modelSwitchUnreachableMessage()).not.toBe(modelSwitchErrorMessage("malformed_body"));
    expect(modelSwitchUnreachableMessage()).toContain("reach the server");
  });
});
