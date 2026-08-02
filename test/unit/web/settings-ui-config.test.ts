import { describe, expect, it } from "vitest";
import {
  AGENT_SETTINGS_TITLE,
  GENERAL_SETTINGS_SHOW_WORKSPACE_SECTION,
  PROVIDER_SECRET_NAME_FIELD_READ_ONLY,
  SETTINGS_PROVIDER_OPTIONS,
} from "../../../web/src/settings-ui-config";

describe("settings UI config", () => {
  it("keeps the tuned settings copy and provider order", () => {
    expect(GENERAL_SETTINGS_SHOW_WORKSPACE_SECTION).toBe(false);
    expect(AGENT_SETTINGS_TITLE).toBe("Configure agent");
    expect(SETTINGS_PROVIDER_OPTIONS.map((option) => option.label)).toEqual([
      "OpenAI",
      "OpenAI OAuth",
      "Anthropic",
      "Cloudflare Workers AI",
      "OpenRouter",
      "DeepSeek",
      "Z.AI GLM",
      "Qwen / DashScope",
      "OpenCode Go",
      "OpenCode Zen",
      "OpenAI Compatible",
    ]);
    expect(PROVIDER_SECRET_NAME_FIELD_READ_ONLY).toBe(true);
  });

  it("exposes the skills management hint", async () => {
    const mod = await import("../../../web/src/settings-ui-config");
    expect(mod.SKILLS_SETTINGS_HINT).toMatch(/agent/i);
  });

  it("exposes the memory management hint", async () => {
    const mod = await import("../../../web/src/settings-ui-config");
    expect(mod.MEMORY_SETTINGS_HINT).toMatch(/agent/i);
  });
});
