import { AwsClient } from "aws4fetch";
import type { Env } from "../env";
import { s3BucketBaseUrl } from "./s3-bucket";

/** Presign window: 5 days in ms. URLs are bucketed within this window for cache stability. */
export const PRESIGN_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
/**
 * Presign expiry: 6 days in seconds — longer than the window (so a URL minted at
 * the window start is still valid at its end, with ~1 day margin) but under the
 * SigV4/R2 maximum of 604800s (7 days); R2 returns 400 for expiries >= 604800.
 */
export const PRESIGN_EXPIRES_SECONDS = 6 * 24 * 60 * 60;

export type PresignDeps = {
  /** Cloudflare R2 account id; unused when `endpoint` is set (celld). */
  accountId?: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  /** S3-compatible endpoint override (celld). When unset, URLs are built on
   *  the Cloudflare R2 host and stay byte-identical to the pre-celld output. */
  endpoint?: string;
};

/** Round a timestamp down to the start of its window, so presigned URLs are stable within it. */
export function bucketedAnchorMs(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

/** Format epoch ms as an AWS SigV4 basic datetime: YYYYMMDDTHHMMSSZ. */
function toAmzDate(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

export function presignDepsFromEnv(env: Env): PresignDeps {
  // Cloudflare keeps the R2_* vars; celld configures S3_* equivalents. R2 wins
  // when both are somehow present so the Cloudflare behavior is untouched.
  const accessKeyId = env.R2_ACCESS_KEY_ID ?? env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY ?? env.S3_SECRET_ACCESS_KEY;
  const bucketName = env.R2_BUCKET_NAME ?? env.S3_ATTACHMENTS_BUCKET_NAME;
  if (!accessKeyId || !secretAccessKey || !bucketName) {
    throw new Error(
      "presignDepsFromEnv: missing S3 credentials or bucket name — set R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET_NAME or the S3_* equivalents",
    );
  }
  return {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId,
    secretAccessKey,
    bucketName,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
  };
}

export async function presignGet(
  deps: PresignDeps,
  key: string,
  opts: {
    anchorMs: number;
    expiresInSeconds: number;
    /** When set, signed into the query as `response-content-disposition` so R2
     *  overrides Content-Disposition on GET (e.g. force download). */
    responseContentDisposition?: string;
  },
): Promise<string> {
  const client = new AwsClient({
    accessKeyId: deps.accessKeyId,
    secretAccessKey: deps.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const url = new URL(
    `${s3BucketBaseUrl(deps.endpoint, deps.accountId)}/${deps.bucketName}/${key}`,
  );
  url.searchParams.set("X-Amz-Expires", String(opts.expiresInSeconds));
  if (opts.responseContentDisposition) {
    url.searchParams.set("response-content-disposition", opts.responseContentDisposition);
  }
  // Supply the (bucketed, deterministic) datetime via the signer option — NOT as
  // an X-Amz-Date request header. A header would be folded into SignedHeaders
  // (host;x-amz-date), and a plain GET of the URL omits that header, so R2 fails
  // with 403 SignatureDoesNotMatch. The datetime option keeps SignedHeaders=host.
  const signed = await client.sign(new Request(url, { method: "GET" }), {
    aws: { signQuery: true, datetime: toAmzDate(opts.anchorMs) },
  });
  return signed.url;
}

/** Build a Content-Disposition value safe to embed in a signed query string. */
export function attachmentContentDisposition(filename: string | null | undefined): string {
  const raw = (filename ?? "attachment").trim() || "attachment";
  // Strip characters that break or confuse disposition parsing / quotes.
  const safe = raw.replace(/["\\\r\n]/g, "_");
  return `attachment; filename="${safe}"`;
}
