import { describe, expect, it } from "vitest";
import {
  PRESIGN_EXPIRES_SECONDS,
  PRESIGN_WINDOW_MS,
  attachmentContentDisposition,
  bucketedAnchorMs,
  presignDepsFromEnv,
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

describe("presignGet with a configurable endpoint (celld)", () => {
  const anchorMs = bucketedAnchorMs(1_700_000_000_000, WINDOW);
  const { accountId: _accountId, ...cloudflareDeps } = DEPS;
  const celldDeps = { ...cloudflareDeps, endpoint: "https://s3.example.com" };

  it("builds the URL on the configured endpoint with the same signed query shape", async () => {
    const u = await presignGet(celldDeps, "ws1/th1/abc.png", {
      anchorMs,
      expiresInSeconds: 600,
    });
    const url = new URL(u);
    expect(url.origin).toBe("https://s3.example.com");
    expect(url.pathname).toBe("/nadi-attachments/ws1/th1/abc.png");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps Cloudflare's R2 URLs byte-identical to the pre-celld output", async () => {
    const u = await presignGet(DEPS, "ws1/th1/abc.png", { anchorMs, expiresInSeconds: 600 });
    // Golden value captured from the pre-celld URL construction
    // (`https://{accountId}.r2.cloudflarestorage.com/{bucket}/{key}` + the same
    // signQuery options) for these exact inputs.
    expect(u).toBe(
      "https://acct123.r2.cloudflarestorage.com/nadi-attachments/ws1/th1/abc.png?" +
        "X-Amz-Expires=600&X-Amz-Date=20231109T000000Z&X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAEXAMPLE%2F20231109%2Fauto%2Fs3%2Faws4_request" +
        "&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=fae3e60213a458f3db508bd43d5c1ce6679b9c310b6019337965e83a6d85d605",
    );
  });

  it("throws when there is neither an endpoint nor an accountId to address", async () => {
    const { endpoint: _endpoint, ...noEndpoint } = celldDeps;
    await expect(presignGet(noEndpoint, "k", { anchorMs, expiresInSeconds: 600 })).rejects.toThrow(
      /no S3_ENDPOINT and no R2_ACCOUNT_ID/,
    );
  });
});

describe("presignDepsFromEnv", () => {
  it("keeps reading the R2_* vars on Cloudflare and adds no endpoint", () => {
    const deps = presignDepsFromEnv({
      R2_ACCOUNT_ID: "acct123",
      R2_ACCESS_KEY_ID: "AKIAEXAMPLE",
      R2_SECRET_ACCESS_KEY: "secretEXAMPLE",
      R2_BUCKET_NAME: "nadi-attachments",
    } as never);
    expect(deps).toEqual({
      accountId: "acct123",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "secretEXAMPLE",
      bucketName: "nadi-attachments",
    });
    expect("endpoint" in deps).toBe(false);
  });

  it("falls back to the S3_* vars on celld and picks up the endpoint", () => {
    const deps = presignDepsFromEnv({
      S3_ENDPOINT: "https://s3.example.com",
      S3_ACCESS_KEY_ID: "AKIACELLD",
      S3_SECRET_ACCESS_KEY: "secretCELLD",
      S3_ATTACHMENTS_BUCKET_NAME: "nadi-attachments",
    } as never);
    expect(deps).toEqual({
      accountId: undefined,
      accessKeyId: "AKIACELLD",
      secretAccessKey: "secretCELLD",
      bucketName: "nadi-attachments",
      endpoint: "https://s3.example.com",
    });
  });

  it("prefers R2_* when both are present (Cloudflare behavior is untouched)", () => {
    const deps = presignDepsFromEnv({
      R2_ACCOUNT_ID: "acct123",
      R2_ACCESS_KEY_ID: "AKIAEXAMPLE",
      R2_SECRET_ACCESS_KEY: "secretEXAMPLE",
      R2_BUCKET_NAME: "nadi-attachments",
      S3_ENDPOINT: "https://s3.example.com",
      S3_ACCESS_KEY_ID: "AKIACELLD",
      S3_SECRET_ACCESS_KEY: "secretCELLD",
    } as never);
    expect(deps.accessKeyId).toBe("AKIAEXAMPLE");
    expect(deps.endpoint).toBe("https://s3.example.com");
  });

  it("fails loudly when no credentials or bucket name are configured", () => {
    expect(() => presignDepsFromEnv({} as never)).toThrow(/missing S3 credentials or bucket name/);
  });
});
