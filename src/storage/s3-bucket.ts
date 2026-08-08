import { AwsClient } from "aws4fetch";

/**
 * celld's attachment/backup store: an `R2Bucket`-shaped facade over any
 * S3-compatible endpoint, signed with SigV4 over plain `fetch`. Cloudflare
 * keeps the real R2 bindings; this class only ever exists on celld (or in
 * tests), where it is handed out by `attachmentsBucket`/`backupBucket`.
 *
 * The surface is deliberately narrow: the subset of R2 that this codebase
 * uses. Every R2 feature the facade does not implement (multipart uploads,
 * conditional reads/writes, ranges, checksums, batch delete, head) throws
 * `UnsupportedR2FeatureError` instead of being silently ignored.
 */
export class UnsupportedR2FeatureError extends Error {
  constructor(feature: string) {
    super(`S3Bucket: ${feature} is not supported by the celld S3 facade`);
    this.name = "UnsupportedR2FeatureError";
  }
}

export interface S3BucketConfig {
  /** S3-compatible endpoint, e.g. `https://s3.example.com` (path-style addressing). */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  /** Injectable fetch, used by tests to point the facade at an in-process S3. */
  fetchImpl?: typeof fetch;
}

/**
 * The bucket-level base URL shared by the S3 facade and presigning. With no
 * `endpoint` this is the Cloudflare R2 host — `https://{accountId}.r2.cloudflarestorage.com`
 * — and must stay byte-identical to the pre-celld URL. With an `endpoint`
 * (celld) the host is the configured S3-compatible service.
 */
export function s3BucketBaseUrl(
  endpoint: string | undefined,
  accountId: string | undefined,
): string {
  const base =
    endpoint?.replace(/\/+$/, "") ??
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  if (!base) {
    throw new Error("s3BucketBaseUrl: no S3_ENDPOINT and no R2_ACCOUNT_ID — nothing to address");
  }
  return base;
}

function xmlUnescape(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function parseTag(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match?.[1];
}

/** An S3 GET/PUT result shaped like an `R2ObjectBody` so callers read it identically. */
export class S3Object implements R2ObjectBody {
  readonly key: string;
  readonly version: string;
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly checksums: R2Checksums;
  readonly uploaded: Date;
  readonly httpMetadata?: R2HTTPMetadata;
  readonly customMetadata?: Record<string, string>;
  readonly range?: R2Range;
  readonly storageClass: string;
  readonly ssecKeyMd5?: string;

  private readonly buffer: Uint8Array;
  private bodyStream: ReadableStream | undefined;

  constructor(key: string, bytes: Uint8Array, headers: Headers, size?: number) {
    this.key = key;
    this.buffer = bytes;
    this.size = size ?? bytes.byteLength;
    const contentType = headers.get("Content-Type");
    if (contentType) this.httpMetadata = { contentType };
    const etagHeader = headers.get("ETag") ?? "";
    this.httpEtag = etagHeader;
    this.etag = etagHeader.replace(/^"|"$/g, "");
    this.version = this.etag;
    const lastModified = headers.get("Last-Modified");
    this.uploaded = lastModified ? new Date(lastModified) : new Date(0);
    this.storageClass = headers.get("x-amz-storage-class") ?? "STANDARD";
    this.checksums = { toJSON: () => ({}) };
  }

  get body(): ReadableStream {
    if (!this.bodyStream) {
      this.bodyStream = new ReadableStream({
        start: (controller) => {
          controller.enqueue(this.buffer);
          controller.close();
        },
      });
    }
    return this.bodyStream;
  }

  get bodyUsed(): boolean {
    return this.bodyStream !== undefined;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.buffer.slice().buffer;
  }

  async bytes(): Promise<Uint8Array> {
    return this.buffer.slice();
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.buffer);
  }

  async json<T>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }

  async blob(): Promise<Blob> {
    const type = this.httpMetadata?.contentType;
    return new Blob([this.buffer.slice()], type ? { type } : undefined);
  }

  writeHttpMetadata(headers: Headers): void {
    if (this.httpMetadata?.contentType) headers.set("Content-Type", this.httpMetadata.contentType);
  }
}

function applyHttpMetadata(headers: Headers, metadata: R2PutOptions["httpMetadata"]): void {
  if (!metadata) return;
  if (metadata instanceof Headers) {
    for (const [name, value] of metadata) headers.set(name, value);
    return;
  }
  if (metadata.contentType) headers.set("Content-Type", metadata.contentType);
  if (metadata.contentLanguage) headers.set("Content-Language", metadata.contentLanguage);
  if (metadata.contentDisposition) headers.set("Content-Disposition", metadata.contentDisposition);
  if (metadata.contentEncoding) headers.set("Content-Encoding", metadata.contentEncoding);
  if (metadata.cacheControl) headers.set("Cache-Control", metadata.cacheControl);
  if (metadata.cacheExpiry) headers.set("Expires", metadata.cacheExpiry.toUTCString());
}

const CHECKSUM_OPTIONS = ["md5", "sha1", "sha256", "sha384", "sha512"] as const;

/** R2's put value → fetch BodyInit; views are copied so the buffer is a real ArrayBuffer. */
function toBodyInit(
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
): BodyInit | null {
  if (value === null) return null;
  if (typeof value === "string" || value instanceof Blob || value instanceof ReadableStream)
    return value;
  if (value instanceof ArrayBuffer) return value;
  const copy = new Uint8Array(value.byteLength);
  copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return copy.buffer;
}

export class S3Bucket implements R2Bucket {
  readonly bucketName: string;
  private readonly client: AwsClient;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(config: S3BucketConfig) {
    this.bucketName = config.bucketName;
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      // Generic S3-compatible endpoints default to us-east-1 in their
      // credential scope; R2 itself does not validate the region.
      region: "us-east-1",
    });
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.baseUrl = `${s3BucketBaseUrl(config.endpoint, undefined)}/${config.bucketName}`;
  }

  private objectUrl(key: string): string {
    return new URL(`${this.baseUrl}/${key}`).toString();
  }

  /** Sign with SigV4, then send through the (possibly injected) fetch. */
  private async signedFetch(url: string, init: RequestInit): Promise<Response> {
    const signed = await this.client.sign(url, init);
    return this.fetchImpl(signed);
  }

  async head(_key: string): Promise<R2Object | null> {
    throw new UnsupportedR2FeatureError("head");
  }

  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>;
  async get(
    key: string,
    options: R2GetOptions & { onlyIf: R2Conditional | Headers },
  ): Promise<R2ObjectBody | R2Object | null>;
  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | R2Object | null> {
    if (options?.range) throw new UnsupportedR2FeatureError("get with a range");
    if (options?.onlyIf) throw new UnsupportedR2FeatureError("conditional reads (onlyIf)");
    if (options?.ssecKey) throw new UnsupportedR2FeatureError("get with ssecKey");
    const response = await this.signedFetch(this.objectUrl(key), { method: "GET" });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`S3Bucket get ${key}: HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return new S3Object(key, bytes, response.headers);
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object>;
  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options: R2PutOptions & { onlyIf: R2Conditional | Headers },
  ): Promise<R2Object | null>;
  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    if (options?.onlyIf) throw new UnsupportedR2FeatureError("conditional writes (onlyIf)");
    for (const checksum of CHECKSUM_OPTIONS) {
      if (options?.[checksum])
        throw new UnsupportedR2FeatureError(`put with a ${checksum} checksum`);
    }
    if (options?.customMetadata) throw new UnsupportedR2FeatureError("customMetadata");
    if (options?.storageClass) throw new UnsupportedR2FeatureError("storageClass");
    if (options?.ssecKey) throw new UnsupportedR2FeatureError("put with ssecKey");
    const headers = new Headers();
    applyHttpMetadata(headers, options?.httpMetadata);
    const response = await this.signedFetch(this.objectUrl(key), {
      method: "PUT",
      headers,
      body: toBodyInit(value),
    });
    if (!response.ok) {
      throw new Error(`S3Bucket put ${key}: HTTP ${response.status}`);
    }
    // S3 PUT has no body in the response; the R2 object's fields come from headers.
    return new S3Object(key, new Uint8Array(0), response.headers);
  }

  async delete(keys: string | string[]): Promise<void> {
    if (Array.isArray(keys)) throw new UnsupportedR2FeatureError("batch delete");
    const response = await this.signedFetch(this.objectUrl(keys), { method: "DELETE" });
    // S3 returns 204 for a delete, and deleting a missing key is also a 204.
    if (!response.ok && response.status !== 404) {
      throw new Error(`S3Bucket delete ${keys}: HTTP ${response.status}`);
    }
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const params = new URLSearchParams({ "list-type": "2" });
    if (options?.prefix) params.set("prefix", options.prefix);
    if (options?.cursor) params.set("continuation-token", options.cursor);
    if (options?.limit) params.set("max-keys", String(options.limit));
    if (options?.delimiter) params.set("delimiter", options.delimiter);
    if (options?.startAfter) params.set("start-after", options.startAfter);
    const response = await this.signedFetch(`${this.baseUrl}?${params}`, { method: "GET" });
    if (!response.ok) {
      throw new Error(`S3Bucket list: HTTP ${response.status}`);
    }
    const xml = await response.text();
    const truncated = parseTag(xml, "IsTruncated") === "true";
    const cursor = parseTag(xml, "NextContinuationToken");
    const objects: R2Object[] = [];
    for (const content of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const block = content[1] ?? "";
      const key = xmlUnescape(parseTag(block, "Key") ?? "");
      const etag = xmlUnescape(parseTag(block, "ETag") ?? "");
      const size = Number(parseTag(block, "Size") ?? "0");
      const lastModified = parseTag(block, "LastModified");
      const headers = new Headers();
      if (etag) headers.set("ETag", etag);
      if (lastModified) headers.set("Last-Modified", lastModified);
      const object = new S3Object(key, new Uint8Array(0), headers, size);
      objects.push(object);
    }
    const delimitedPrefixes: string[] = [];
    for (const common of xml.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)) {
      const prefix = xmlUnescape(parseTag(common[1] ?? "", "Prefix") ?? "");
      if (prefix) delimitedPrefixes.push(prefix);
    }
    return truncated
      ? { objects, delimitedPrefixes, truncated: true, cursor: cursor ?? "" }
      : { objects, delimitedPrefixes, truncated: false };
  }

  async createMultipartUpload(
    _key: string,
    _options?: R2MultipartOptions,
  ): Promise<R2MultipartUpload> {
    throw new UnsupportedR2FeatureError("multipart uploads");
  }

  resumeMultipartUpload(_key: string, _uploadId: string): R2MultipartUpload {
    throw new UnsupportedR2FeatureError("multipart uploads");
  }
}
