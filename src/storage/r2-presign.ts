import { AwsClient } from "aws4fetch";

/** Presign window: 5 days in ms. URLs are bucketed within this window for cache stability. */
export const PRESIGN_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
/**
 * Presign expiry: 6 days in seconds — longer than the window (so a URL minted at
 * the window start is still valid at its end, with ~1 day margin) but under the
 * SigV4/R2 maximum of 604800s (7 days); R2 returns 400 for expiries >= 604800.
 */
export const PRESIGN_EXPIRES_SECONDS = 6 * 24 * 60 * 60;

export type PresignDeps = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
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
  return {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucketName: env.R2_BUCKET_NAME,
  };
}

export async function presignGet(
  deps: PresignDeps,
  key: string,
  opts: { anchorMs: number; expiresInSeconds: number },
): Promise<string> {
  const client = new AwsClient({
    accessKeyId: deps.accessKeyId,
    secretAccessKey: deps.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const url = new URL(
    `https://${deps.accountId}.r2.cloudflarestorage.com/${deps.bucketName}/${key}`,
  );
  url.searchParams.set("X-Amz-Expires", String(opts.expiresInSeconds));
  // Supply the (bucketed, deterministic) datetime via the signer option — NOT as
  // an X-Amz-Date request header. A header would be folded into SignedHeaders
  // (host;x-amz-date), and a plain GET of the URL omits that header, so R2 fails
  // with 403 SignatureDoesNotMatch. The datetime option keeps SignedHeaders=host.
  const signed = await client.sign(new Request(url, { method: "GET" }), {
    aws: { signQuery: true, datetime: toAmzDate(opts.anchorMs) },
  });
  return signed.url;
}
