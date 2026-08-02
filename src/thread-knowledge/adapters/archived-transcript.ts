import type { ArchivedMessageRepository } from "../../db/repositories/archived-messages";
import type { RawTranscriptStat, ThreadOrder, TranscriptSource } from "../types";

export class ArchivedTranscriptAdapter implements TranscriptSource {
  private readonly idToSeq = new Map<string, number>();

  constructor(
    private readonly repository: ArchivedMessageRepository,
    private readonly threadId: string,
  ) {}

  async listStats(input: {
    afterPosition?: number;
    order: ThreadOrder;
    limit: number;
  }): Promise<{ stats: RawTranscriptStat[]; nextPosition?: number }> {
    const result = await this.repository.listStatsForThread({
      threadId: this.threadId,
      ...(input.afterPosition === undefined ? {} : { afterSeq: input.afterPosition }),
      order: input.order,
      limit: input.limit,
    });
    for (const stat of result.stats) {
      this.idToSeq.set(stat.id, stat.position);
    }
    return result;
  }

  async getMessage(id: string): Promise<unknown | null> {
    const seq = this.idToSeq.get(id) ?? seqFromFallbackId(id);
    if (seq === null) return null;
    return this.repository.getBySeq(this.threadId, seq);
  }
}

function seqFromFallbackId(id: string): number | null {
  const match = /^archived:(\d+)$/.exec(id);
  if (match === null) return null;
  const seq = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(seq) ? seq : null;
}
