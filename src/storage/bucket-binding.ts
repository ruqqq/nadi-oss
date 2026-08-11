import { S3Bucket, type S3BucketConfig } from "./s3-bucket";

/**
 * The R2Bucket-shaped store every attachments consumer gets. Cloudflare keeps
 * the real `ATTACHMENTS_BUCKET` R2 binding, unchanged; celld has no R2, so
 * this hands out an S3Bucket signed against the configured S3 endpoint. Gate
 * is binding presence, not a platform flag, and a misconfigured platform
 * fails loudly instead of silently serving a store that does not exist.
 */
export function attachmentsBucket(env: {
  ATTACHMENTS_BUCKET?: R2Bucket;
  S3_ENDPOINT?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_ATTACHMENTS_BUCKET_NAME?: string;
}): R2Bucket {
  if (env.ATTACHMENTS_BUCKET) return env.ATTACHMENTS_BUCKET;
  const config = s3BucketConfigFromEnv(
    env,
    env.S3_ATTACHMENTS_BUCKET_NAME,
    "S3_ATTACHMENTS_BUCKET_NAME",
    "ATTACHMENTS_BUCKET",
  );
  if (config) return new S3Bucket(config);
  throw new Error(
    "attachmentsBucket: neither ATTACHMENTS_BUCKET nor S3_* config — attachments have no backing store",
  );
}

/** Mirror of `attachmentsBucket` for the compute-backup bucket. */
export function backupBucket(env: {
  BACKUP_BUCKET?: R2Bucket;
  S3_ENDPOINT?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_BACKUP_BUCKET_NAME?: string;
}): R2Bucket {
  if (env.BACKUP_BUCKET) return env.BACKUP_BUCKET;
  const config = s3BucketConfigFromEnv(
    env,
    env.S3_BACKUP_BUCKET_NAME,
    "S3_BACKUP_BUCKET_NAME",
    "BACKUP_BUCKET",
  );
  if (config) return new S3Bucket(config);
  throw new Error(
    "backupBucket: neither BACKUP_BUCKET nor S3_* config — backups have no backing store",
  );
}

function s3BucketConfigFromEnv(
  env: { S3_ENDPOINT?: string; S3_ACCESS_KEY_ID?: string; S3_SECRET_ACCESS_KEY?: string },
  bucketName: string | undefined,
  bucketNameVar: string,
  bindingName: string,
): S3BucketConfig | null {
  const {
    S3_ENDPOINT: endpoint,
    S3_ACCESS_KEY_ID: accessKeyId,
    S3_SECRET_ACCESS_KEY: secretAccessKey,
  } = env;
  if (!endpoint && !accessKeyId && !secretAccessKey && !bucketName) return null;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucketName) {
    throw new Error(
      `${bindingName}: partial S3 config — set all of S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, ${bucketNameVar}`,
    );
  }
  return { endpoint, accessKeyId, secretAccessKey, bucketName };
}
