import { describe, expect, it, vi } from "vitest";
import { archiveSkill, listSkills, restoreSkill, setSkillEnabled } from "../../../web/src/skills-api";

const skill = {
  id: "sk1",
  name: "review",
  description: "Review",
  body: "Body",
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
  archivedAt: null,
};

describe("skills api helpers", () => {
  it("lists active skills", async () => {
    const fetch = vi.fn(async () => Response.json({ skills: [skill] }));
    await expect(listSkills(false, fetch)).resolves.toEqual([skill]);
    expect(fetch).toHaveBeenCalledWith("/api/skills", { credentials: "include" });
  });

  it("lists archived skills", async () => {
    const fetch = vi.fn(async () => Response.json({ skills: [] }));
    await expect(listSkills(true, fetch)).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledWith("/api/skills?archived=1", { credentials: "include" });
  });

  it("toggles enabled", async () => {
    const fetch = vi.fn(async () => Response.json({ skill: { ...skill, enabled: false } }));
    await expect(setSkillEnabled("sk1", false, fetch)).resolves.toEqual({ ...skill, enabled: false });
    expect(fetch).toHaveBeenCalledWith("/api/skills/sk1/enabled", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
  });

  it("archives and restores", async () => {
    const fetch = vi.fn(async () => Response.json({ skill }));
    await expect(archiveSkill("sk1", fetch)).resolves.toEqual(skill);
    expect(fetch).toHaveBeenCalledWith("/api/skills/sk1/archive", {
      method: "POST",
      credentials: "include",
    });
    await expect(restoreSkill("sk1", fetch)).resolves.toEqual(skill);
    expect(fetch).toHaveBeenCalledWith("/api/skills/sk1/restore", {
      method: "POST",
      credentials: "include",
    });
  });

  it("surfaces the server's message on a non-ok response", async () => {
    const fetch = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(listSkills(false, fetch)).rejects.toThrow("nope");
  });
});
