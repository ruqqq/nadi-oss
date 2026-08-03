import { describe, expect, it } from "vitest";
import type { McpServer } from "../mcp-api";
import { FEATURED_CONNECTIONS, findFeaturedServer } from "./featured-connections";

const markdump = FEATURED_CONNECTIONS.find((c) => c.id === "markdump")!;

function server(overrides: Partial<McpServer>): McpServer {
  return { id: "srv_1", name: "Markdump", url: markdump.url, enabled: true, createdAt: 0, ...overrides };
}

describe("FEATURED_CONNECTIONS", () => {
  it("pins the exact endpoints", () => {
    expect(FEATURED_CONNECTIONS.map((c) => [c.id, c.url])).toEqual([
      ["markdump", "https://markdump.com/mcp"],
      ["composio", "https://connect.composio.dev/mcp"],
    ]);
  });
});

describe("findFeaturedServer", () => {
  it("matches on URL", () => {
    expect(findFeaturedServer([server({})], markdump)?.id).toBe("srv_1");
  });

  it("still matches a server the user renamed", () => {
    // A user can rename a server; renaming must not make us add a second one.
    expect(findFeaturedServer([server({ name: "my wiki" })], markdump)?.id).toBe("srv_1");
  });

  it("ignores a trailing slash and case in the host", () => {
    expect(findFeaturedServer([server({ url: "https://MarkDump.com/mcp/" })], markdump)?.id).toBe(
      "srv_1",
    );
  });

  it("does not match a different path on the same host", () => {
    expect(findFeaturedServer([server({ url: "https://markdump.com/other" })], markdump)).toBe(null);
  });

  it("is null for an empty list", () => {
    expect(findFeaturedServer([], markdump)).toBe(null);
  });
});
