import { describe, expect, it } from "vitest";
import { computeDerivativeSize } from "./image-dimensions";

describe("computeDerivativeSize", () => {
  it("scales down the long edge to maxEdge, preserving aspect ratio", () => {
    expect(computeDerivativeSize(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(computeDerivativeSize(3000, 4000, 2048)).toEqual({ width: 1536, height: 2048 });
  });

  it("never upscales", () => {
    expect(computeDerivativeSize(800, 600, 2048)).toEqual({ width: 800, height: 600 });
  });
});
