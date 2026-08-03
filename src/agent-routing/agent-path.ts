export interface ThreadAgentPath {
  agentClass: "think-thread-agent";
  threadId: string;
}

export function parseThreadAgentPath(url: URL): ThreadAgentPath | null {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3) return null;
  const [agentsPrefix, agentClass, rawThreadId] = parts;
  if (agentsPrefix !== "think-agents" || agentClass !== "think-thread-agent" || !rawThreadId) {
    return null;
  }
  return { agentClass, threadId: decodeURIComponent(rawThreadId) };
}
