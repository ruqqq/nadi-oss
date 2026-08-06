/**
 * In-process fake S3 server for the celld S3Bucket tests. Implements just the
 * subset of the S3 REST API the facade uses: GetObject, PutObject, DeleteObject
 * and ListObjectsV2 (prefix/delimiter/max-keys/continuation-token). Requests
 * are recorded so tests can assert on the SigV4 surface (method, URL, headers).
 * No signature verification — that is the deploy story, out of scope here.
 */

export interface FakeS3Object {
  body: Uint8Array;
  contentType: string | undefined;
  etag: string;
  lastModified: string;
}

export interface FakeS3Request {
  method: string;
  url: URL;
  authorization: string | undefined;
  headers: Headers;
  body: Uint8Array | undefined;
}

export const FAKE_S3_ENDPOINT = "https://fake-s3.test";

const XML_ERROR_BODY =
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>Not Found</Message></Error>';

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export class FakeS3 {
  /** bucket name → key → object. The bucket is ignored by handlers (one bucket per server). */
  readonly objects = new Map<string, FakeS3Object>();
  readonly requests: FakeS3Request[] = [];
  private etagCounter = 0;

  constructor(readonly bucketName = "nadi-attachments") {}

  handle = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const authorization = request.headers.get("authorization") ?? undefined;
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
    this.requests.push({
      method: request.method,
      url,
      authorization,
      headers: new Headers(request.headers),
      body,
    });

    const segments = url.pathname.split("/").filter(Boolean);
    const bucket = decodeURIComponent(segments[0] ?? "");
    const key = segments.slice(1).map(decodeURIComponent).join("/");

    if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
      return this.list(bucket, url);
    }
    if (request.method === "GET") {
      const object = this.objects.get(key);
      if (!object) return new Response(XML_ERROR_BODY, { status: 404 });
      return new Response(object.body.slice(), {
        status: 200,
        headers: {
          "Content-Type": object.contentType ?? "application/octet-stream",
          ETag: object.etag,
          "Last-Modified": object.lastModified,
        },
      });
    }
    if (request.method === "PUT") {
      const contentType = request.headers.get("Content-Type") ?? undefined;
      const etag = `"fake-etag-${this.etagCounter++}"`;
      this.objects.set(key, {
        body: body ?? new Uint8Array(0),
        contentType,
        etag,
        lastModified: new Date().toUTCString(),
      });
      return new Response(null, { status: 200, headers: { ETag: etag } });
    }
    if (request.method === "DELETE") {
      this.objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response("unsupported method", { status: 400 });
  };

  private list(bucket: string, url: URL): Response {
    const prefix = url.searchParams.get("prefix") ?? "";
    const delimiter = url.searchParams.get("delimiter") ?? undefined;
    const maxKeys = Number(url.searchParams.get("max-keys") ?? "1000");
    const continuationToken = url.searchParams.get("continuation-token") ?? undefined;

    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();

    const page: string[] = [];
    const commonPrefixes = new Set<string>();
    let truncated = false;
    let count = 0;
    for (const key of keys) {
      if (continuationToken && key <= continuationToken) continue;
      if (delimiter) {
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf(delimiter);
        if (slash >= 0) {
          commonPrefixes.add(prefix + rest.slice(0, slash + delimiter.length));
          // CommonPrefixes do not consume the max-keys budget.
          continue;
        }
      }
      if (count >= maxKeys) {
        truncated = true;
        break;
      }
      page.push(key);
      count++;
    }

    const contents = page
      .map((key) => {
        const object = this.objects.get(key)!;
        return (
          `<Contents><Key>${xmlEscape(key)}</Key><LastModified>${object.lastModified}</LastModified>` +
          `<ETag>${object.etag}</ETag><Size>${object.body.byteLength}</Size>` +
          `<StorageClass>STANDARD</StorageClass></Contents>`
        );
      })
      .join("");
    const commonXml = [...commonPrefixes]
      .map((p) => `<CommonPrefixes><Prefix>${xmlEscape(p)}</Prefix></CommonPrefixes>`)
      .join("");
    const nextToken = truncated ? (page.at(-1) ?? "") : undefined;

    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
      `<Name>${bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount>` +
      `<MaxKeys>${maxKeys}</MaxKeys><IsTruncated>${truncated}</IsTruncated>` +
      (nextToken ? `<NextContinuationToken>${xmlEscape(nextToken)}</NextContinuationToken>` : "") +
      contents +
      commonXml +
      `</ListBucketResult>`;
    return new Response(xml, { status: 200, headers: { "Content-Type": "application/xml" } });
  }

  /** Delete all stored objects, keep the request log (fresh test, same server). */
  resetObjects(): void {
    this.objects.clear();
    this.requests.length = 0;
  }
}
