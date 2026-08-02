// Static capability map. Conservative: a model must be explicitly listed to receive a type.
// Patterns are matched against the model id (case-insensitive substring).

type Capability = "image" | "pdf";

const IMAGE = new Set<string>(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const CAPABILITY_RULES: { provider: string; pattern: RegExp; caps: Capability[] }[] = [
  { provider: "anthropic", pattern: /claude-(opus|sonnet|haiku)/i, caps: ["image", "pdf"] },
  { provider: "openai", pattern: /gpt-4o|gpt-4\.1|gpt-5|o3|o4/i, caps: ["image", "pdf"] },
  { provider: "openai-oauth", pattern: /gpt-4o|gpt-4\.1|gpt-5|o3|o4/i, caps: ["image", "pdf"] },
  // OpenRouter ids are "vendor/model"; match the same families.
  {
    provider: "openrouter",
    pattern: /claude-(opus|sonnet|haiku)|gpt-4o|gpt-4\.1|gpt-5/i,
    caps: ["image", "pdf"],
  },
  // Workers AI ids are "@cf/vendor/model". Only the vision-capable ones, and
  // image only — none of them accept PDFs directly.
  {
    provider: "workers-ai",
    pattern: /kimi-k2|gemma-4|llama-4-scout/i,
    caps: ["image"],
  },
];

export function modelSupportsAttachment(
  provider: string,
  model: string,
  mimeType: string,
): boolean {
  const need: Capability | null = IMAGE.has(mimeType)
    ? "image"
    : mimeType === "application/pdf"
      ? "pdf"
      : null;
  if (!need) return false;
  return CAPABILITY_RULES.some(
    (rule) => rule.provider === provider && rule.pattern.test(model) && rule.caps.includes(need),
  );
}
