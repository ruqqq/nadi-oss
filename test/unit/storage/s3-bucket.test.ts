import { describe, expect, it } from "vitest";
import { deleteR2PrefixBestEffort } from "../../../src/artifacts/serve";
import { attachmentsBucket, backupBucket } from "../../../src/storage/bucket-binding";
import { S3Bucket, UnsupportedR2FeatureError } from "../../../src/storage/s3-bucket";
import { FAKE_S3_ENDPOINT, FakeS3 } from "../../helpers/fake-s3";

function makeBucket(server: FakeS3, bucketName = "nadi-attachments"): S3Bucket {
  return new S3Bucket({
    endpoint: FAKE_S3_ENDPOINT,
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "SECRETEXAMPLE",
    bucketName,
    fetchImpl: server.handle,
  });
}

describe("S3Bucket surface", () => {
  it("put + get round-trips values with content type", async () => {
    const server = new FakeS3();
    const bucket = makeBucket(server);

    await bucket.put("ws1/th1/note.txt", "hello world", {
      httpMetadata: { contentType: "text/plain" },
    });

    const object = (await bucket.get("ws1/th1/note.txt")) as R2ObjectBody;
    expect(object.key).toBe("ws1/th1/note.txt");
    expect(await object.text()).toBe("hello world");
    expect(object.httpMetadata?.contentType).toBe("text/plain");
    expect(object.size).toBe(11);
    expect(object.etag).toMatch(/^fake-etag-/);
    expect(object.uploaded).toBeInstanceOf(Date);
    expect(object.storageClass).toBe("STANDARD");
    expect(object.bodyUsed).toBe(false);
    // body is a readable stream of the same bytes
    const streamText = await new Response(object.body).text();
    expect(streamText).toBe("hello world");
    expect(object.bodyUsed).toBe(true);
  });

  it("put accepts ArrayBuffer, ArrayBufferView and Blob values", async () => {
    const server = new FakeS3();
    const bucket = makeBucket(server);

    await bucket.put("a", new TextEncoder().encode("view").buffer);
    await bucket.put("b", new TextEncoder().encode("typed"));
    await bucket.put("c", new Blob(["blob"], { type: "text/plain" }));
    await bucket.put(
      "d",
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode("stream"));
          controller.close();
        },
      }),
    );

    expect(await (await bucket.get("a"))?.text()).toBe("view");
    expect(await (await bucket.get("b"))?.text()).toBe("typed");
    expect(await (await bucket.get("c"))?.text()).toBe("blob");
    expect((await bucket.get("c"))?.httpMetadata?.contentType).toBe("text/plain");
    expect(await (await bucket.get("d"))?.text()).toBe("stream");
  });

  it("get returns null for a missing key instead of throwing", async () => {
    const server = new FakeS3();
    const bucket = makeBucket(server);
    await bucket.put("present", "x");
    expect(await bucket.get("present")).not.toBeNull();
    expect(await bucket.get("missing")).toBeNull();
  });

  it("delete removes an object and tolerates deleting a missing key", async () => {
    const server = new FakeS3();
    const bucket = makeBucket(server);
    await bucket.put("ws1/th1/artifact", "data");
    await bucket.delete("ws1/th1/artifact");
    expect(await bucket.get("ws1/th1/artifact")).toBeNull();
    await bucket.delete("never-existed");
    expect(server.requests.at(-1)?.method).toBe("DELETE");
  });

  it("list returns the objects under a prefix, sorted", async () => {
    const server = new FakeS3();
    const bucket = makeBucket(server);
    for (const key of ["ws1/a", "ws1/b", "ws2/c", "ws1/d"]) {
      await bucket.put(key, key);
    }
    const listed = await bucket.list({ prefix: "ws1/" });
    expect(listed.objects.map((o) => o.key)).toEqual(["ws1/a", "ws1/b", "ws1/d"]);
    expect(listed.objects.map((o) => o.size)).toEqual([5, 5, 5]);
    expect(listed.truncated).toBe(false);
    expect(listed.delimitedPrefixes).toEqual([]);
  });

  it("list paginates with limit and cursor", async () => {
    const server = new FakeS3();
    const bucket = makeBucket(server);
    for (let i = 0; i < 5; i++) await bucket.put(`ws1/k${i}`, `v${i}`);

    const page1 = await bucket.list({ prefix: "ws1/", limit: 2 });
    expect(page1.truncated).toBe(true);
    const cursor1 = page1.truncated ? page1.cursor : undefined;
    expect(cursor1).toBeTypeOf("string");
    expect(page1.objects.map((o) => o.key)).toEqual(["ws1/k0", "ws1/k1"]);

    const page2 = await bucket.list({
      prefix: "ws1/",
      limit: 2,
      ...(cursor1 ? { cursor: cursor1 } : {}),
    });
    expect(page2.objects.map((o) => o.key)).toEqual(["ws1/k2", "ws1/k3"]);
    const cursor2 = page2.truncated ? page2.cursor : undefined;
    const page3 = await bucket.list({
      prefix: "ws1/",
      limit: 2,
      ...(cursor2 ? { cursor: cursor2 } : {}),
    });
    expect(page3.objects.map((o) => o.key)).toEqual(["ws1/k4"]);
    expect(page3.truncated).toBe(false);
  });

  it("list returns delimited prefixes when a delimiter is given", async () => {
    const server = new FakeS3();
    const bucket = makeBucket(server);
    for (const key of ["a/1.txt", "a/2.txt", "b/1.txt"]) await bucket.put(key, key);
    const listed = await bucket.list({ prefix: "", delimiter: "/" });
    expect(listed.delimitedPrefixes.sort()).toEqual(["a/", "b/"]);
    expect(listed.objects).toEqual([]);
  });

  it("signs every request with SigV4 headers", async () => {
    const server = new FakeS3();
    const bucket = makeBucket(server);
    await bucket.put("ws1/key", "payload", { httpMetadata: { contentType: "text/plain" } });
    await bucket.get("ws1/key");
    await bucket.delete("ws1/key");
    await bucket.list({ prefix: "ws1/" });

    for (const request of server.requests) {
      expect(request.authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request/,
      );
      // aws4fetch's default for s3 regular requests
      expect(request.headers.get("x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD");
    }
    // the PUT body must reach the server as the stored bytes
    const put = server.requests.find((r) => r.method === "PUT");
    expect(put).toBeDefined();
    expect(new TextDecoder().decode(put!.body)).toBe("payload");
  });
});

describe("S3Bucket rejects unimplemented R2 features", () => {
  const bucket = makeBucket(new FakeS3());

  it("multipart uploads throw UnsupportedR2FeatureError", async () => {
    await expect(bucket.createMultipartUpload("k")).rejects.toBeInstanceOf(
      UnsupportedR2FeatureError,
    );
    expect(() => bucket.resumeMultipartUpload("k", "id")).toThrow(UnsupportedR2FeatureError);
  });

  it("head throws", async () => {
    await expect(bucket.head("k")).rejects.toBeInstanceOf(UnsupportedR2FeatureError);
  });

  it("conditional reads (onlyIf) throw", async () => {
    await expect(bucket.get("k", { onlyIf: { etagMatches: "x" } })).rejects.toBeInstanceOf(
      UnsupportedR2FeatureError,
    );
  });

  it("range reads throw", async () => {
    await expect(bucket.get("k", { range: { offset: 0, length: 1 } })).rejects.toBeInstanceOf(
      UnsupportedR2FeatureError,
    );
  });

  it("conditional writes (onlyIf) throw", async () => {
    await expect(
      bucket.put("k", "v", { onlyIf: { uploadedBefore: new Date() } }),
    ).rejects.toBeInstanceOf(UnsupportedR2FeatureError);
  });

  it("checksum options throw", async () => {
    await expect(bucket.put("k", "v", { md5: "abc" })).rejects.toBeInstanceOf(
      UnsupportedR2FeatureError,
    );
    await expect(bucket.put("k", "v", { sha256: "abc" })).rejects.toBeInstanceOf(
      UnsupportedR2FeatureError,
    );
  });

  it("customMetadata, storageClass and ssecKey throw", async () => {
    await expect(bucket.put("k", "v", { customMetadata: { a: "b" } })).rejects.toBeInstanceOf(
      UnsupportedR2FeatureError,
    );
    await expect(
      bucket.put("k", "v", { storageClass: "REDUCED_REDUNDANCY" }),
    ).rejects.toBeInstanceOf(UnsupportedR2FeatureError);
    await expect(bucket.put("k", "v", { ssecKey: "key" })).rejects.toBeInstanceOf(
      UnsupportedR2FeatureError,
    );
  });

  it("batch delete throws", async () => {
    await expect(bucket.delete(["a", "b"])).rejects.toBeInstanceOf(UnsupportedR2FeatureError);
  });
});

describe("deleteR2PrefixBestEffort", () => {
  it("deletes every object under the prefix and leaves the rest", async () => {
    const server = new FakeS3();
    const bucket = makeBucket(server);
    await bucket.put("ws1/art/1", "a");
    await bucket.put("ws1/art/2", "b");
    await bucket.put("ws1/other", "c");
    await bucket.put("ws2/art/1", "d");

    await deleteR2PrefixBestEffort(bucket, "ws1/art/");

    expect(await bucket.get("ws1/art/1")).toBeNull();
    expect(await bucket.get("ws1/art/2")).toBeNull();
    expect(await bucket.get("ws1/other")).not.toBeNull();
    expect(await bucket.get("ws2/art/1")).not.toBeNull();
  });

  it("deletes across list pages when the bucket has more than one page", async () => {
    const server = new FakeS3();
    const bucket = makeBucket(server);
    // More keys than the default S3 max-keys page (1000) so truncation kicks in.
    for (let i = 0; i < 1001; i++) {
      await bucket.put(`bulk/pad-${String(i).padStart(4, "0")}`, "x");
    }
    await bucket.put("keep", "x");

    await deleteR2PrefixBestEffort(bucket, "bulk/");

    expect((await bucket.list({ prefix: "bulk/" })).objects).toEqual([]);
    expect(await bucket.get("keep")).not.toBeNull();
  });
});

describe("attachmentsBucket / backupBucket resolution", () => {
  it("returns the real binding when one is present (Cloudflare, unchanged)", () => {
    const real = {} as R2Bucket;
    expect(attachmentsBucket({ ATTACHMENTS_BUCKET: real })).toBe(real);
    expect(backupBucket({ BACKUP_BUCKET: real })).toBe(real);
  });

  it("returns an S3Bucket when the S3 config is complete (celld)", () => {
    const bucket = attachmentsBucket({
      S3_ENDPOINT: FAKE_S3_ENDPOINT,
      S3_ACCESS_KEY_ID: "akid",
      S3_SECRET_ACCESS_KEY: "secret",
      S3_ATTACHMENTS_BUCKET_NAME: "nadi-attachments",
    });
    expect(bucket).toBeInstanceOf(S3Bucket);
    const backup = backupBucket({
      S3_ENDPOINT: FAKE_S3_ENDPOINT,
      S3_ACCESS_KEY_ID: "akid",
      S3_SECRET_ACCESS_KEY: "secret",
      S3_BACKUP_BUCKET_NAME: "nadi-backups",
    });
    expect(backup).toBeInstanceOf(S3Bucket);
    expect((backup as S3Bucket).bucketName).toBe("nadi-backups");
    expect((bucket as S3Bucket).bucketName).toBe("nadi-attachments");
  });

  it("throws naming both options when neither binding nor config is present", () => {
    expect(() => attachmentsBucket({})).toThrow(/ATTACHMENTS_BUCKET/);
    expect(() => attachmentsBucket({})).toThrow(/S3_/);
    expect(() => backupBucket({})).toThrow(/BACKUP_BUCKET/);
  });

  it("throws on partial S3 config instead of guessing", () => {
    expect(() =>
      attachmentsBucket({ S3_ENDPOINT: FAKE_S3_ENDPOINT, S3_ACCESS_KEY_ID: "akid" }),
    ).toThrow(/partial S3 config/);
    expect(() => backupBucket({ S3_SECRET_ACCESS_KEY: "secret" })).toThrow(/partial S3 config/);
  });
});
