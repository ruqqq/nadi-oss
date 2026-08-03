/**
 * Display name for this deployment. Used as the OAuth `client_name` when
 * registering with MCP servers (and anywhere else the product should identify
 * itself to a third party). Self-hosters set `APP_NAME` in wrangler vars;
 * unset/blank falls back to Nadi so a missing var never registers as empty.
 */
export const DEFAULT_APP_NAME = "Nadi";

/** Accepts an explicit `undefined` as well as an absent key: under
 *  `exactOptionalPropertyTypes` those are distinct types, and an unset wrangler
 *  var reaches this as the former. */
export function resolveAppName(env: { APP_NAME?: string | undefined }): string {
  const name = env.APP_NAME?.trim();
  return name ? name : DEFAULT_APP_NAME;
}
