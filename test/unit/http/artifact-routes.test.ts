import { describe, expect, it } from "vitest";
import { resolveArtifactOrigin } from "../../../src/http/artifact-routes";

describe("resolveArtifactOrigin", () => {
  it("uses https for non-localhost app hosts", () => {
    const origin = resolveArtifactOrigin(
      new Request("https://nadi.test/api/artifacts/art_1"),
      "artifacts.example.com",
    );
    expect(origin).toBe("https://artifacts.example.com");
  });

  it("uses http with request port for localhost-style hosts", () => {
    const origin = resolveArtifactOrigin(
      new Request("http://localhost:8787/api/artifacts/art_1"),
      "artifacts.localhost",
    );
    expect(origin).toBe("http://artifacts.localhost:8787");
  });

  it("uses http without port for localhost-style hosts when port is absent", () => {
    const origin = resolveArtifactOrigin(
      new Request("http://127.0.0.1/api/artifacts/art_1"),
      "artifacts.localhost",
    );
    expect(origin).toBe("http://artifacts.localhost");
  });
});
