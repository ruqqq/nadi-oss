import { describe, expect, it } from "vitest";
import {
  decideCapabilityAction,
  MODEL_CAPABILITY_TTL_MS,
} from "../../../src/providers/model-capabilities";

describe("decideCapabilityAction", () => {
  it("fetches when there is nothing cached", () => {
    expect(decideCapabilityAction({ row: null, now: 1000 })).toBe("fetch");
  });

  it("serves a fresh row without touching the network", () => {
    expect(decideCapabilityAction({ row: { fetchedAt: 1000 }, now: 1000 })).toBe("serve-fresh");
    expect(
      decideCapabilityAction({ row: { fetchedAt: 1000 }, now: 1000 + MODEL_CAPABILITY_TTL_MS - 1 }),
    ).toBe("serve-fresh");
  });

  it("serves a stale row and revalidates behind it", () => {
    // A turn must never wait on models.dev, and an outage must degrade to the
    // last good copy rather than to "nothing reasons".
    expect(
      decideCapabilityAction({ row: { fetchedAt: 1000 }, now: 1000 + MODEL_CAPABILITY_TTL_MS }),
    ).toBe("serve-stale-and-revalidate");
  });
});
