import { appFetch } from "./lib/app-fetch";
import { errorFromResponse } from "./lib/http-error";

type FetchLike = typeof fetch;

/** Nova-3's streaming languages — kept in sync with `VOICE_LANGUAGES` in
 *  `src/http/settings-routes.ts`. Malay, Indonesian, Thai, Vietnamese, and
 *  Tagalog are NOT supported by the model. */
export const VOICE_LANGUAGES = [
  "en",
  "es",
  "fr",
  "de",
  "hi",
  "ja",
  "pt",
  "it",
  "nl",
  "ru",
] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

export interface VoiceSettingsResponse {
  language: VoiceLanguage;
  supported: readonly VoiceLanguage[];
}

export async function getVoiceSettings(
  fetchImpl: FetchLike = appFetch,
): Promise<VoiceSettingsResponse> {
  const res = await fetchImpl("/api/settings/voice", { credentials: "include" });
  if (!res.ok) {
    throw await errorFromResponse(res, "load dictation settings");
  }
  return (await res.json()) as VoiceSettingsResponse;
}

export async function saveVoiceSettings(
  language: VoiceLanguage,
  fetchImpl: FetchLike = appFetch,
): Promise<VoiceSettingsResponse> {
  const res = await fetchImpl("/api/settings/voice", {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ language }),
  });
  if (!res.ok) {
    throw await errorFromResponse(res, "save the dictation language");
  }
  return (await res.json()) as VoiceSettingsResponse;
}
