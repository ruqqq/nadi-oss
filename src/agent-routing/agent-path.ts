export interface ThreadAgentPath {
  agentClass: "thread-agent" | "think-thread-agent";
  threadId: string;
}

export function parseThreadAgentPath(url: URL): ThreadAgentPath | null {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3) return null;
  const [agentsPrefix, agentClass, rawThreadId] = parts;
  const isLegacyThreadAgent = agentsPrefix === "agents" && agentClass === "thread-agent";
  const isThinkThreadAgent = agentsPrefix === "think-agents" && agentClass === "think-thread-agent";
  if ((!isLegacyThreadAgent && !isThinkThreadAgent) || !rawThreadId) {
    return null;
  }
  return { agentClass, threadId: decodeURIComponent(rawThreadId) };
}
