import { appFetch } from "./lib/app-fetch";
import { errorFromResponse } from "./lib/http-error";

type FetchLike = typeof fetch;

export interface UserPreferences {
  /** Whether to display the model's thinking. Does not change how hard it thinks. */
  showReasoning: boolean;
}

export async function getUserPreferences(
  fetchImpl: FetchLike = appFetch,
): Promise<UserPreferences> {
  const res = await fetchImpl("/api/settings/preferences", { credentials: "include" });
  if (!res.ok) {
    throw await errorFromResponse(res, "load display preferences");
  }
  return (await res.json()) as UserPreferences;
}

export async function saveUserPreferences(
  showReasoning: boolean,
  fetchImpl: FetchLike = appFetch,
): Promise<UserPreferences> {
  const res = await fetchImpl("/api/settings/preferences", {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ showReasoning }),
  });
  if (!res.ok) {
    throw await errorFromResponse(res, "save your display preferences");
  }
  return (await res.json()) as UserPreferences;
}
