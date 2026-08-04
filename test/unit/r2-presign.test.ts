import { describe, expect, it } from "vitest";
import {
  PRESIGN_EXPIRES_SECONDS,
  PRESIGN_WINDOW_MS,
  attachmentContentDisposition,
  bucketedAnchorMs,
  presignGet,
} from "../../src/storage/r2-presign";

const DEPS = {
  accountId: "acct123",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secretEXAMPLE",
  bucketName: "nadi-attachments",
};
const WINDOW = 7 * 24 * 60 * 60 * 1000;

describe("bucketedAnchorMs", () => {
  it("rounds down to the window boundary", () => {
    const t = 1_700_000_123_456;
    const anchor = bucketedAnchorMs(t, WINDOW);
    expect(anchor % WINDOW).toBe(0);
    expect(anchor).toBeLessThanOrEqual(t);
    // anything else in the same window maps to the same anchor
    expect(bucketedAnchorMs(t + 5000, WINDOW)).toBe(anchor);
  });
});

describe("presignGet", () => {
  it("produces a byte-identical URL for the same anchor (cache-stable)", async () => {
    const anchorMs = bucketedAnchorMs(1_700_000_000_000, WINDOW);
    const a = await presignGet(DEPS, "ws1/th1/abc.png", { anchorMs, expiresInSeconds: 600 });
    const b = await presignGet(DEPS, "ws1/th1/abc.png", { anchorMs, expiresInSeconds: 600 });
    expect(a).toBe(b);
    expect(a).toContain("acct123.r2.cloudflarestorage.com");
    expect(a).toContain("/nadi-attachments/ws1/th1/abc.png");
    expect(a).toContain("X-Amz-Signature=");
    expect(a).toContain("X-Amz-Expires=600");
  });

  it("produces a different URL across window boundaries", async () => {
    const a = await presignGet(DEPS, "ws1/th1/abc.png", { anchorMs: 0, expiresInSeconds: 600 });
    const b = await presignGet(DEPS, "ws1/th1/abc.png", {
      anchorMs: WINDOW,
      expiresInSeconds: 600,
    });
    expect(a).not.toBe(b);
  });

  // Regression: R2 rejects presigned GETs whose only signed header is not exactly
  // `host`. Passing X-Amz-Date as a request header makes aws4fetch sign it
  // (SignedHeaders=host;x-amz-date), so a plain GET of the URL fails with 403
  // SignatureDoesNotMatch. The date must be supplied via the signer's datetime
  // option instead, leaving SignedHeaders=host.
  it("signs only the host header", async () => {
    const u = await presignGet(DEPS, "ws1/th1/abc.png", {
      anchorMs: bucketedAnchorMs(1_700_000_000_000, WINDOW),
      expiresInSeconds: 600,
    });
    expect(new URL(u).searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  });

  // Regression: R2 (S3 SigV4) rejects X-Amz-Expires >= 604800 with 400
  // InvalidArgument ("must be less than 604800 seconds").
  it("uses an expiry under the 604800s SigV4 maximum", () => {
    expect(PRESIGN_EXPIRES_SECONDS).toBeLessThan(604800);
    // expiry must fully cover the stability window (with margin) so a URL minted
    // at the window start is still valid at the window's end.
    expect(PRESIGN_EXPIRES_SECONDS).toBeGreaterThanOrEqual(PRESIGN_WINDOW_MS / 1000);
  });

  it("signs response-content-disposition when requested for downloads", async () => {
    const disposition = attachmentContentDisposition('chart "v2".png');
    const u = await presignGet(DEPS, "ws1/th1/abc.png", {
      anchorMs: bucketedAnchorMs(1_700_000_000_000, WINDOW),
      expiresInSeconds: 600,
      responseContentDisposition: disposition,
    });
    const params = new URL(u).searchParams;
    expect(params.get("response-content-disposition")).toBe(disposition);
    expect(params.get("X-Amz-SignedHeaders")).toBe("host");
    expect(disposition).toBe('attachment; filename="chart _v2_.png"');
  });
});

describe("attachmentContentDisposition", () => {
  it("falls back to attachment when filename is empty", () => {
    expect(attachmentContentDisposition(null)).toBe('attachment; filename="attachment"');
    expect(attachmentContentDisposition("  ")).toBe('attachment; filename="attachment"');
  });
});
