export function buildBackfillStatements(
  input?: Partial<{
    workspaceId: string;
    workspaceName: string;
    agentId: string;
    agentName: string;
    provider: string;
    model: string;
    threadId: string;
    threadTitle: string;
    createdAt: number;
  }>,
): string[];

export function buildOrphanCountQuery(): string;

export function parseOrphanCounts(raw: string): {
  workspaceOrphans: number;
  agentOrphans: number;
};

export function parseArgs(argv: string[]): {
  local: boolean;
};
