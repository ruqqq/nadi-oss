import { beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { resetRegistryState } from "./helpers/reset";

beforeEach(async () => {
  await resetRegistryState(env.REGISTRY_DB);
});
