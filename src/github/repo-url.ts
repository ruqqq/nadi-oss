export interface GithubRepoRef {
  owner: string;
  repo: string;
}

export function parseGithubRepoRef(url: string): GithubRepoRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repoRaw = parts[1];
  if (!owner || !repoRaw) return null;
  const repo = repoRaw.replace(/\.git$/, "");
  if (!repo) return null;
  return { owner, repo };
}
