import { describe, expect, it, vi } from "vitest";
import {
  buildExtractionQuestion,
  createAttachmentExtractor,
  DEFAULT_EXTRACTION_QUESTION,
  isExtractableMime,
  isExtractionEnabled,
  MAX_CONCURRENT_EXTRACTIONS,
  MAX_QUERY_CHARS,
} from "../../../src/agent/attachment-extraction";
import type { ExtractionRow, ExtractionStore } from "../../../src/agent/attachment-extraction";

function row(overrides: Partial<ExtractionRow> = {}): ExtractionRow {
  return {
    id: "img1",
    mimeType: "image/png",
    filename: "shot.png",
    r2Key: "ws/th/img1.png",
    byteSize: 1024,
    extractedText: null,
    extractedSource: null,
    extractedError: null,
    extractedAttempts: 0,
    ...overrides,
  };
}

function fakeStore(initial: ExtractionRow | null) {
  const state = { row: initial, attempts: 0, saved: [] as string[], failures: [] as string[] };
  const store: ExtractionStore = {
    load: async () => state.row,
    beginAttempt: async () => {
      state.attempts += 1;
      if (state.row) {
        state.row = { ...state.row, extractedAttempts: state.row.extractedAttempts + 1 };
      }
    },
    saveSuccess: async (_id, text) => {
      state.saved.push(text);
      if (state.row) state.row = { ...state.row, extractedText: text };
    },
    saveFailure: async (_id, error) => {
      state.failures.push(error);
    },
  };
  return { store, state };
}

const bucket = {
  get: async () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
} as unknown as R2Bucket;

const OFFICE_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("isExtractionEnabled", () => {
  it('enables only on the exact string "true"', () => {
    expect(isExtractionEnabled("true")).toBe(true);
  });

  it("stays off for anything else, including a missing or truthy-looking value", () => {
    for (const flag of [undefined, "", "false", "1", "yes", "TRUE", " true"]) {
      expect(isExtractionEnabled(flag)).toBe(false);
    }
  });
});

describe("isExtractableMime", () => {
  it("accepts images, pdf and office formats", () => {
    expect(isExtractableMime("image/png")).toBe(true);
    expect(isExtractableMime("application/pdf")).toBe(true);
    expect(isExtractableMime(OFFICE_DOCX)).toBe(true);
  });

  it("rejects text and unknown types", () => {
    expect(isExtractableMime("text/plain")).toBe(false);
    expect(isExtractableMime("application/zip")).toBe(false);
  });
});

describe("buildExtractionQuestion", () => {
  it("returns the generic prompt unchanged when there is no query", () => {
    for (const query of [undefined, "", "   ", "\n\n"]) {
      expect(buildExtractionQuestion(query)).toBe(DEFAULT_EXTRACTION_QUESTION);
    }
  });

  it("asks for a transcription section before the answer section", () => {
    const question = buildExtractionQuestion("why does this crash?");

    expect(question).toContain("## Transcription");
    expect(question).toContain("## Answer");
    expect(question).toContain("why does this crash?");
    // Transcription must come first: the answer is the instruction a small model
    // is most tempted to satisfy at the transcription's expense.
    expect(question.indexOf("## Transcription")).toBeLessThan(question.indexOf("## Answer"));
  });

  it("truncates an over-long query", () => {
    const question = buildExtractionQuestion("x".repeat(MAX_QUERY_CHARS + 50));

    expect(question).toContain(`${"x".repeat(MAX_QUERY_CHARS)}…`);
    expect(question).not.toContain("x".repeat(MAX_QUERY_CHARS + 1));
  });
});

describe("createAttachmentExtractor", () => {
  it("passes the user's query to the vision model and widens the token budget", async () => {
    let input: Record<string, unknown> = {};
    const ai = {
      run: vi.fn(async (_model: string, args: Record<string, unknown>) => {
        input = args;
        return { result: { answer: "## Transcription\n…" } };
      }),
      toMarkdown: vi.fn(async () => [{ data: "wrong path" }]),
    };
    const { store } = fakeStore(row());

    await createAttachmentExtractor({ ai, bucket, store })("img1", "which port is it using?");

    const text = (input.messages as [{ content: [{ text: string }] }])[0].content[0].text;
    expect(text).toContain("which port is it using?");
    expect(text).toContain("## Transcription");
    expect(input.max_tokens).toBe(3072);
  });

  it("leaves documents on toMarkdown even when a query is present", async () => {
    const ai = {
      run: vi.fn(async () => ({ result: { answer: "wrong path" } })),
      toMarkdown: vi.fn(async () => [{ data: "# doc" }]),
    };
    const { store } = fakeStore(row({ mimeType: "application/pdf" }));

    const result = await createAttachmentExtractor({ ai, bucket, store })("img1", "summarise this");

    expect(result).toEqual({ text: "# doc", source: "workers-ai-tomarkdown" });
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("routes images to the chat vision model with an image_url OBJECT", async () => {
    const ai = {
      run: vi.fn(async () => ({ choices: [{ text: "a stack trace", finish_reason: "stop" }] })),
      toMarkdown: vi.fn(async () => [{ data: "wrong path" }]),
    };
    const { store } = fakeStore(row());

    const result = await createAttachmentExtractor({ ai, bucket, store })("img1");

    expect(result).toEqual({ text: "a stack trace", source: "workers-ai-llama-vision" });
    expect(ai.toMarkdown).not.toHaveBeenCalled();
    expect(ai.run).toHaveBeenCalledWith("@cf/meta/llama-4-scout-17b-16e-instruct", {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: expect.stringContaining("Transcribe") },
            // An image_url STRING is a validation error, and a top-level
            // `image` is ignored so silently the model hallucinates instead.
            { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
          ],
        },
      ],
      max_tokens: 2048,
    });
  });

  it("sends no sampling params: any extra field silently breaks image delivery", async () => {
    let input: Record<string, unknown> = {};
    const ai = {
      run: vi.fn(async (_m: string, args: Record<string, unknown>) => {
        input = args;
        return { choices: [{ text: "ok" }] };
      }),
      toMarkdown: vi.fn(async () => [{ data: "wrong path" }]),
    };
    const { store } = fakeStore(row());

    await createAttachmentExtractor({ ai, bucket, store })("img1");

    expect(Object.keys(input).sort()).toEqual(["max_tokens", "messages"]);
  });

  it("reads choices[0].message.content as well as choices[0].text", async () => {
    const ai = {
      run: vi.fn(async () => ({ choices: [{ message: { content: "nested text" } }] })),
      toMarkdown: vi.fn(async () => [{ data: "wrong path" }]),
    };
    const { store } = fakeStore(row());

    const result = await createAttachmentExtractor({ ai, bucket, store })("img1");

    expect(result).toEqual({ text: "nested text", source: "workers-ai-llama-vision" });
  });

  it("treats an empty answer as a failure so a reasoning stall is never cached", async () => {
    const ai = {
      // What kimi did live: whole budget spent in reasoning_content, empty content.
      run: vi.fn(async () => ({
        choices: [{ message: { content: "" }, finish_reason: "length" }],
      })),
      toMarkdown: vi.fn(async () => [{ data: "wrong path" }]),
    };
    const { store, state } = fakeStore(row());

    const result = await createAttachmentExtractor({ ai, bucket, store })("img1");

    expect(result).toEqual({ error: "vision model returned no content" });
    expect(state.failures).toEqual(["vision model returned no content"]);
  });

  it("routes PDFs to toMarkdown", async () => {
    const ai = {
      run: vi.fn(async () => ({ result: { answer: "wrong path" } })),
      toMarkdown: vi.fn(async () => [{ data: "# Report" }]),
    };
    const { store } = fakeStore(row({ mimeType: "application/pdf", filename: "r.pdf" }));

    const result = await createAttachmentExtractor({ ai, bucket, store })("img1");

    expect(result).toEqual({ text: "# Report", source: "workers-ai-tomarkdown" });
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("passes the row's real mime type on the blob, even when filename is null", async () => {
    const seen: { name: string; type: string }[] = [];
    const ai = {
      run: vi.fn(async () => ({ result: { answer: "wrong path" } })),
      toMarkdown: async (files: { name: string; blob: Blob }[]) => {
        for (const f of files) seen.push({ name: f.name, type: f.blob.type });
        return [{ data: "# Report" }];
      },
    };
    const { store } = fakeStore(row({ mimeType: "application/pdf", filename: null }));

    await createAttachmentExtractor({ ai, bucket, store })("img1");

    // Without the real mime type toMarkdown must sniff the extension — and the
    // name falls back to a UUID, which has none.
    expect(seen).toEqual([{ name: "img1", type: "application/pdf" }]);
  });

  it("treats empty toMarkdown output as a failure", async () => {
    const ai = {
      run: vi.fn(async () => ({ result: { answer: "wrong path" } })),
      toMarkdown: async () => [{ data: "" }],
    };
    const { store, state } = fakeStore(row({ mimeType: "application/pdf", filename: "r.pdf" }));

    const result = await createAttachmentExtractor({ ai, bucket, store })("img1");

    expect(result).toEqual({ error: "toMarkdown returned no content" });
    expect(state.failures).toEqual(["toMarkdown returned no content"]);
  });

  it("returns null for a non-extractable type without touching the AI binding", async () => {
    let calls = 0;
    const ai = {
      run: vi.fn(async () => ({ result: { answer: "wrong path" } })),
      toMarkdown: async () => {
        calls += 1;
        return [];
      },
    };
    const { store } = fakeStore(row({ mimeType: "text/plain" }));

    expect(await createAttachmentExtractor({ ai, bucket, store })("img1")).toBeNull();
    expect(calls).toBe(0);
  });

  it("serves the cached extraction without calling the AI binding", async () => {
    let calls = 0;
    const ai = {
      run: vi.fn(async () => ({ result: { answer: "wrong path" } })),
      toMarkdown: async () => {
        calls += 1;
        return [{ data: "fresh" }];
      },
    };
    const { store } = fakeStore(
      row({ extractedText: "cached text", extractedSource: "workers-ai-tomarkdown" }),
    );

    expect(await createAttachmentExtractor({ ai, bucket, store })("img1")).toEqual({
      text: "cached text",
      source: "workers-ai-tomarkdown",
    });
    expect(calls).toBe(0);
  });

  it("stops calling the AI binding after MAX_ATTEMPTS failures", async () => {
    let calls = 0;
    const ai = {
      run: vi.fn(async () => ({ result: { answer: "wrong path" } })),
      toMarkdown: async () => {
        calls += 1;
        throw new Error("workers ai 500");
      },
    };
    const { store } = fakeStore(row({ extractedAttempts: 2, extractedError: "workers ai 500" }));

    expect(await createAttachmentExtractor({ ai, bucket, store })("img1")).toEqual({
      error: "workers ai 500",
    });
    expect(calls).toBe(0);
  });

  it("records a failure and returns an error result when the AI call throws", async () => {
    const ai = {
      run: async () => {
        throw new Error("boom");
      },
      toMarkdown: async () => [{ data: "wrong path" }],
    };
    const { store, state } = fakeStore(row());

    expect(await createAttachmentExtractor({ ai, bucket, store })("img1")).toEqual({
      error: "boom",
    });
    expect(state.failures).toEqual(["boom"]);
    expect(state.attempts).toBe(1);
  });

  it("increments the attempt counter before calling the AI binding", async () => {
    const order: string[] = [];
    const ai = {
      run: async () => {
        order.push("ai");
        return { result: { answer: "ok" } };
      },
      toMarkdown: async () => [{ data: "wrong path" }],
    };
    const { store } = fakeStore(row());
    const wrapped: ExtractionStore = {
      ...store,
      beginAttempt: async (id) => {
        order.push("beginAttempt");
        await store.beginAttempt(id);
      },
    };

    await createAttachmentExtractor({ ai, bucket, store: wrapped })("img1");

    expect(order).toEqual(["beginAttempt", "ai"]);
  });

  it("caps concurrent extractions", async () => {
    let inFlight = 0;
    let peak = 0;
    const ai = {
      run: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { result: { answer: "ok" } };
      },
      toMarkdown: async () => [{ data: "wrong path" }],
    };
    const store: ExtractionStore = {
      load: async (id) => row({ id }),
      beginAttempt: async () => {},
      saveSuccess: async () => {},
      saveFailure: async () => {},
    };
    const extract = createAttachmentExtractor({ ai, bucket, store });

    await Promise.all(Array.from({ length: 12 }, (_, i) => extract(`img${i}`)));

    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_EXTRACTIONS);
  });
});
