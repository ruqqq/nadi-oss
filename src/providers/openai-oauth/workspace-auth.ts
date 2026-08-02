import { createWorkspaceSecretsServices } from "../../secrets";
import type { Env } from "../../env";
import { OpenAIOAuthAuthManager } from "./auth";

export function createWorkspaceOpenAIOAuthManager(input: {
  env: Env;
  workspaceId: string;
  secretName: string;
}): OpenAIOAuthAuthManager {
  const { store, writer } = createWorkspaceSecretsServices(input.env);
  return new OpenAIOAuthAuthManager({
    load: () => store.get(input.workspaceId, input.secretName),
    save: (value) => writer.set(input.workspaceId, input.secretName, value),
  });
}
