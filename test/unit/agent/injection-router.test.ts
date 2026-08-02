import type { ModelMessage, UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createMemoryInjectionBuffer } from "../../../src/agent/injection-buffer";
import { assembleStepMessages, routeInjection } from "../../../src/agent/injection-router";

const msg = (id: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text: id }] });
const mm = (t: string): ModelMessage => ({ role: "user", content: t });

describe("routeInjection", () => {
  it("busy: enqueues and does NOT kick", () => {
    const buffer = createMemoryInjectionBuffer();
    const kick = vi.fn();
    routeInjection({
      buffer,
      isTurnActive: () => true,
      kick,
      now: 1,
      entry: { dedupeKey: "a", kind: "watcher-completion", message: msg("a") },
    });
    expect(buffer.isEmpty()).toBe(false);
    expect(kick).not.toHaveBeenCalled();
  });

  it("idle: enqueues and kicks", () => {
    const buffer = createMemoryInjectionBuffer();
    const kick = vi.fn();
    routeInjection({
      buffer,
      isTurnActive: () => false,
      kick,
      now: 1,
      entry: { dedupeKey: "a", kind: "watcher-completion", message: msg("a") },
    });
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it("deduped enqueue: neither kicks nor re-adds", () => {
    const buffer = createMemoryInjectionBuffer();
    buffer.enqueue({ dedupeKey: "a", kind: "watcher-completion", message: msg("a"), now: 0 });
    const kick = vi.fn();
    routeInjection({
      buffer,
      isTurnActive: () => false,
      kick,
      now: 1,
      entry: { dedupeKey: "a", kind: "watcher-completion", message: msg("a2") },
    });
    expect(kick).not.toHaveBeenCalled();
  });
});

describe("assembleStepMessages", () => {
  it("appends injections AFTER the in-flight event messages (newest last)", () => {
    const out = assembleStepMessages([mm("base"), mm("assistant-step")], [mm("injected")]);
    expect(out.map((m) => m.content)).toEqual(["base", "assistant-step", "injected"]);
  });
  it("returns the event messages unchanged when there are no injections", () => {
    const eventMessages = [mm("base")];
    expect(assembleStepMessages(eventMessages, [])).toEqual(eventMessages);
  });
});
