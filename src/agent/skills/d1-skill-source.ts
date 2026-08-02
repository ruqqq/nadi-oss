import type { SkillContent, SkillDescriptor, SkillResource, SkillSource } from "agents/skills";
import type { Env } from "../../env";
import { registryDb } from "../../db/client";
import { AgentSkillRepository } from "../../db/repositories/agent-skills";
import { log } from "../../log";

interface RuntimeSkillScope {
  workspaceId: string;
  agentId: string;
}

export function createD1SkillSource(input: {
  env: Env;
  threadId: string;
  resolveRuntimeConfig: () => Promise<RuntimeSkillScope>;
}): SkillSource {
  const id = "nadi-agent-skills";

  async function resolveRepo() {
    const scope = await input.resolveRuntimeConfig();
    return {
      scope,
      repo: new AgentSkillRepository(registryDb(input.env)),
    };
  }

  async function fetchList(): Promise<SkillDescriptor[]> {
    try {
      const { scope, repo } = await resolveRepo();
      const rows = await repo.listActive(scope);
      return rows.map((row) => ({
        name: row.name,
        description: row.description,
        sourceId: id,
      }));
    } catch (error) {
      log.warn("agent_skills.list_failed", {
        threadId: input.threadId,
        error: String(error),
      });
      return [];
    }
  }

  // The SDK calls `list()` during registry.load(), i.e. AFTER getSkills() has
  // already awaited the script-runner gate — making this D1 read its own
  // sequential wave (~260ms) on the cold-wake path. Start it at construction so
  // it overlaps that gate instead.
  //
  // Deliberately a ONE-SHOT prefetch, not a cache: only the first `list()`
  // consumes it. Later calls (the SDK's skills-changed refresh) re-query, so a
  // skill edit is still picked up. `fetchList` never rejects, so the unconsumed
  // promise can't surface as an unhandled rejection.
  let prefetched: Promise<SkillDescriptor[]> | null = fetchList();

  return {
    id,
    fingerprint: "nadi-d1-agent-skills-v1",
    async list(): Promise<SkillDescriptor[]> {
      if (prefetched) {
        const inFlight = prefetched;
        prefetched = null;
        return inFlight;
      }
      return fetchList();
    },
    async load(name: string): Promise<SkillContent | null> {
      try {
        const { scope, repo } = await resolveRepo();
        const row = await repo.getActiveByName({ ...scope, name });
        // Enforce the runtime invariant at the source boundary: a skill is
        // available to the model only when enabled AND not archived.
        // (getActiveByName is intentionally not enabled-filtered — chat CRUD
        // still needs to reach disabled skills to edit/archive them.)
        if (!row || !row.enabled) return null;
        const descriptors = await repo.listResourceDescriptors(row.id);
        return {
          name: row.name,
          description: row.description,
          body: row.body,
          resources: descriptors.map((d) => ({
            path: d.path,
            kind: d.kind as "script" | "reference" | "asset" | "file",
            encoding: d.encoding,
            ...(d.mimeType === null ? {} : { mimeType: d.mimeType }),
            size: d.size,
          })),
          sourceId: id,
        };
      } catch (error) {
        log.warn("agent_skills.load_failed", {
          threadId: input.threadId,
          name,
          error: String(error),
        });
        return null;
      }
    },
    async readResource(name: string, path: string): Promise<SkillResource | null> {
      try {
        const { scope, repo } = await resolveRepo();
        const row = await repo.getActiveByName({ ...scope, name });
        // Same enabled+active gate as load(): disabled/archived skills are invisible.
        if (!row || !row.enabled) return null;
        const res = await repo.getResource(row.id, path);
        if (!res) return null;
        return {
          path: res.path,
          kind: res.kind as "script" | "reference" | "asset" | "file",
          encoding: res.encoding,
          ...(res.mimeType === null ? {} : { mimeType: res.mimeType }),
          content: res.content,
          size: res.content.length,
        };
      } catch (error) {
        log.warn("agent_skills.read_resource_failed", {
          threadId: input.threadId,
          name,
          path,
          error: String(error),
        });
        return null;
      }
    },
  };
}
