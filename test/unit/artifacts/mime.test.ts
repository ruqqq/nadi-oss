import { describe, expect, it } from "vitest";
import { mimeFromFilename } from "../../../src/artifacts/mime";

describe("mimeFromFilename", () => {
  it("maps html entry files to text/html", () => {
    expect(mimeFromFilename("index.html")).toBe("text/html");
    expect(mimeFromFilename("page.HTM")).toBe("text/html");
  });

  it("maps common web asset extensions", () => {
    expect(mimeFromFilename("app.css")).toBe("text/css");
    expect(mimeFromFilename("bundle.js")).toBe("application/javascript");
    expect(mimeFromFilename("module.mjs")).toBe("application/javascript");
    expect(mimeFromFilename("data.json")).toBe("application/json");
    expect(mimeFromFilename("logo.svg")).toBe("image/svg+xml");
    expect(mimeFromFilename("favicon.ico")).toBe("image/x-icon");
    expect(mimeFromFilename("photo.png")).toBe("image/png");
    expect(mimeFromFilename("photo.jpg")).toBe("image/jpeg");
    expect(mimeFromFilename("photo.jpeg")).toBe("image/jpeg");
    expect(mimeFromFilename("anim.gif")).toBe("image/gif");
    expect(mimeFromFilename("tile.webp")).toBe("image/webp");
    expect(mimeFromFilename("Inter.woff2")).toBe("font/woff2");
    expect(mimeFromFilename("Inter.woff")).toBe("font/woff");
    expect(mimeFromFilename("Inter.ttf")).toBe("font/ttf");
    expect(mimeFromFilename("bundle.js.map")).toBe("application/json");
    expect(mimeFromFilename("readme.txt")).toBe("text/plain");
    expect(mimeFromFilename("module.wasm")).toBe("application/wasm");
  });

  it("falls back to application/octet-stream for unknown extensions", () => {
    expect(mimeFromFilename("binary.bin")).toBe("application/octet-stream");
    expect(mimeFromFilename("noextension")).toBe("application/octet-stream");
  });
});
