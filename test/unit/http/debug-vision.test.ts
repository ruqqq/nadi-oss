import { describe, expect, it } from "vitest";
import {
  analyzeAnswer,
  answerFromVision,
  buildVisionInput,
  DEFAULT_VISION_PARAMS,
  substituteImage,
} from "../../../src/http/debug-vision";
import type { VisionProbeConfig } from "../../../src/http/debug-vision";

const buffer = new Uint8Array([1, 2, 3]).buffer;

function config(overrides: Partial<VisionProbeConfig> = {}): VisionProbeConfig {
  return {
    model: "@cf/moondream/moondream3.1-9B-A2B",
    question: "transcribe it",
    imageFormat: "dataUri",
    params: { ...DEFAULT_VISION_PARAMS },
    ...overrides,
  };
}

describe("buildVisionInput", () => {
  it("sends a base64 data URI by default", () => {
    const input = buildVisionInput(buffer, "image/png", config());

    expect(input.image).toBe("data:image/png;base64,AQID");
    expect(input.question).toBe("transcribe it");
    expect(input.prompt).toBe("transcribe it");
    expect(input.max_tokens).toBe(2048);
  });

  it("builds an OpenAI-shaped messages array for chat-style models", () => {
    const input = buildVisionInput(buffer, "image/png", config({ imageFormat: "chatMessages" }));

    expect(input.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "transcribe it" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
        ],
      },
    ]);
    expect(input.image).toBeUndefined();
    // moondream-only knobs would make a chat model reject the request outright.
    expect(input.task).toBeUndefined();
    expect(input.reasoning).toBeUndefined();
    expect(input.max_tokens).toBe(2048);
  });

  it("sends a plain byte array when the model wants one", () => {
    const input = buildVisionInput(buffer, "image/png", config({ imageFormat: "byteArray" }));

    expect(input.image).toEqual([1, 2, 3]);
  });

  it("lets an explicit param override a default, including stream", () => {
    const input = buildVisionInput(
      buffer,
      "image/png",
      config({ params: { ...DEFAULT_VISION_PARAMS, temperature: 0.7, stream: true } }),
    );

    expect(input.temperature).toBe(0.7);
    expect(input.stream).toBe(true);
  });

  it("carries an undocumented param through untouched", () => {
    const input = buildVisionInput(
      buffer,
      "image/png",
      config({ params: { ...DEFAULT_VISION_PARAMS, repetition_penalty: 1.2 } }),
    );

    expect(input.repetition_penalty).toBe(1.2);
  });
});

describe("answerFromVision", () => {
  it("reads the shapes different vision models return", () => {
    expect(answerFromVision({ result: { answer: "moondream" } })).toBe("moondream");
    // task:"caption" nulls `answer` and puts the text under `caption`.
    expect(answerFromVision({ result: { answer: null, caption: "a screenshot" } })).toBe(
      "a screenshot",
    );
    expect(answerFromVision({ description: "llava" })).toBe("llava");
    expect(answerFromVision({ result: { response: "generic" } })).toBe("generic");
    expect(answerFromVision("bare string")).toBe("bare string");
    expect(answerFromVision({ choices: [{ message: { content: "chat model reply" } }] })).toBe(
      "chat model reply",
    );
  });

  it("returns null when nothing usable is present", () => {
    expect(answerFromVision({ result: {} })).toBeNull();
    expect(answerFromVision({ answer: "" })).toBeNull();
    expect(answerFromVision(null)).toBeNull();
  });
});

describe("analyzeAnswer", () => {
  it("scores a degeneration tail separately from real content", () => {
    const analysis = analyzeAnswer("Lots to learn" + "😂".repeat(50), {
      result: { finish_reason: "length", usage: { completion_tokens: 2048 } },
    });

    expect(analysis.realChars).toBe("Lots to learn".length);
    expect(analysis.repetitionTailChars).toBe(100); // 50 surrogate pairs
    expect(analysis.repetitionRatio).toBeGreaterThan(0.8);
    expect(analysis.finishReason).toBe("length");
    expect(analysis.usage).toEqual({ completion_tokens: 2048 });
  });

  it("reports a clean answer as almost entirely real", () => {
    const analysis = analyzeAnswer("A tidy transcription.", { result: { finish_reason: "stop" } });

    expect(analysis.repetitionTailChars).toBe(1); // the trailing period
    expect(analysis.repetitionRatio).toBeLessThan(0.1);
  });

  it("catches a phrase loop the character-tail metric scores as clean", () => {
    const looped = "The top post shows marriagefamiliah. ".repeat(17);
    const analysis = analyzeAnswer(looped, {});

    // No emoji tail at all — the old metric called this pristine.
    expect(analysis.repetitionRatio).toBeLessThan(0.05);
    expect(analysis.uniqueNgramRatio).toBeLessThan(0.2);
  });

  it("scores varied prose as near-fully unique", () => {
    const analysis = analyzeAnswer(
      "Fourth is stonewalling. These are the Four Horsemen based on Gottman's method, discussed within the community.",
      {},
    );

    expect(analysis.uniqueNgramRatio).toBe(1);
  });

  it("survives a null answer without dividing by zero", () => {
    const analysis = analyzeAnswer(null, {});

    expect(analysis).toMatchObject({ chars: 0, realChars: 0, repetitionRatio: 0 });
  });

  it("finds finish_reason and usage at the top level too", () => {
    const analysis = analyzeAnswer("hi", { finish_reason: "stop", usage: { total_tokens: 5 } });

    expect(analysis.finishReason).toBe("stop");
    expect(analysis.usage).toEqual({ total_tokens: 5 });
  });
});

describe("substituteImage", () => {
  const parts = { dataUri: "data:image/png;base64,AQID", base64: "AQID", bytes: [1, 2, 3] };

  it("replaces placeholders anywhere in an arbitrary input tree", () => {
    const shape = {
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: "{{IMAGE_DATA_URI}}" }] },
      ],
      image: "{{IMAGE_BYTES}}",
      b64: "{{IMAGE_BASE64}}",
      untouched: "literal",
      max_tokens: 512,
    };

    expect(substituteImage(shape, parts)).toEqual({
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: "data:image/png;base64,AQID" }] },
      ],
      image: [1, 2, 3],
      b64: "AQID",
      untouched: "literal",
      max_tokens: 512,
    });
  });

  it("leaves a tree with no placeholders unchanged", () => {
    expect(substituteImage({ a: [1, "b", null] }, parts)).toEqual({ a: [1, "b", null] });
  });
});
