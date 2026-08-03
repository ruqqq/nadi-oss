import type { Env } from "../env";
import { registryDb } from "../db/client";
import type { ThreadIndex } from "../db/schema";
import { ThreadSearchProjectionRepository } from "../db/repositories/thread-search-projection";
import type { SearchProjectionDocument } from "../db/repositories/thread-search-projection";
import { ThreadRepository } from "../db/repositories/threads";
import { sha256Hex } from "../compute/files/hash";
import { log } from "../log";
import { normalizeProseMessage } from "./prose-normalizer";
import { activeTranscriptRpc } from "./adapters/active-transcript";
import { hasLiveTranscript } from "../agent/thread-runtime";
import {
  THREAD_LAST_MESSAGE_PREVIEW_CHARS,
  THREAD_PROJECTION_DIGEST_PAGE,
  THREAD_PROJECTION_DOCUMENT_BATCH,
  THREAD_PROJECTION_MAX_BYTES,
  THREAD_PROJECTION_MAX_MESSAGES,
  type ActiveTranscriptRpc,
  type ThreadProseMessage,
  type ThreadSearchDigest,
  type ThreadSearchDocument,
} from "./types";

const textEncoder = new TextEncoder();

export async function reconcileThreadSearchProjection(
  env: Env,
  threadId: string,
): Promise<"indexed" | "skipped"> {
  const thread = await loadProjectableThread(env, threadId);
  if (!thread) return "skipped";
  // No live DO to walk on the retired runtime; the archive path projects those.
  if (!hasLiveTranscript(thread)) return "skipped";

  const source = await activeTranscriptRpc(env, { id: thread.id });
  await reconcileThreadSearchProjectionFromSource(env, thread, source);
  return "indexed";
}

export async function reconcileThreadSearchProjectionFromMessages(
  env: Env,
  input: {
    threadId: string;
    messages: unknown[];
    observedUpdatedAt: number;
  },
): Promise<void> {
  const thread = await loadProjectableThread(env, input.threadId);
  if (!thread) return;

  const changedDocuments: SearchProjectionDocument[] = [];
  let lastMessagePreview = "";
  for (const raw of input.messages) {
    const normalized = normalizeProseMessage(raw);
    if (normalized.message === null) continue;
    lastMessagePreview = previewText(normalized.message.text);
    changedDocuments.push(
      await searchProjectionDocument(normalized.message, {
        sourceHash: await hashJson(raw),
      }),
    );
  }

  await new ThreadSearchProjectionRepository(env.REGISTRY_DB).reconcile({
    workspaceId: thread.workspaceId,
    threadId: thread.id,
    observedUpdatedAt: input.observedUpdatedAt,
    currentMessageIds: changedDocuments.map((document) => document.messageId),
    changedDocuments,
    lastMessagePreview,
  });
}

export function scheduleLocalThreadSearchProjection(input: {
  env: Env;
  threadId: string;
  waitUntil: (promise: Promise<unknown>) => void;
  source: () => Promise<ActiveTranscriptRpc>;
}): void {
  input.waitUntil(
    (async () => {
      const thread = await loadProjectableThread(input.env, input.threadId);
      if (!thread) return;
      const source = await input.source();
      await reconcileThreadSearchProjectionFromSource(input.env, thread, source);
    })(),
  );
}

async function reconcileThreadSearchProjectionFromSource(
  env: Env,
  thread: ThreadIndex,
  source: ActiveTranscriptRpc,
): Promise<void> {
  const startedAt = Date.now();
  const observedUpdatedAt = thread.updatedAt;
  const projection = new ThreadSearchProjectionRepository(env.REGISTRY_DB);
  const currentState = new Map(
    (await projection.listState(thread.id)).map((row) => [row.messageId, row.sourceHash]),
  );
  const scan = await scanSourceDigests(source, currentState);
  const fetched = await fetchChangedDocuments(source, scan.changedDigests);

  await projection.reconcile({
    workspaceId: thread.workspaceId,
    threadId: thread.id,
    observedUpdatedAt,
    currentMessageIds: scan.currentMessageIds,
    changedDocuments: fetched.documents,
    lastMessagePreview: scan.lastMessagePreview,
  });

  log.info("thread_search_projector.reconciled", {
    threadId: thread.id,
    workspaceId: thread.workspaceId,
    observedUpdatedAt,
    currentMessageCount: scan.currentMessageIds.length,
    changedDocumentCount: fetched.documents.length,
    transferredBytes: fetched.transferredBytes,
    durationMs: Date.now() - startedAt,
  });
}

async function scanSourceDigests(
  source: ActiveTranscriptRpc,
  currentState: Map<string, string>,
): Promise<{
  currentMessageIds: string[];
  changedDigests: ThreadSearchDigest[];
  lastMessagePreview: string;
}> {
  const currentMessageIds: string[] = [];
  const changedDigests: ThreadSearchDigest[] = [];
  let lastMessagePreview = "";
  let afterPosition: number | undefined;

  for (;;) {
    const page = await source.listThreadSearchDigests({
      ...(afterPosition === undefined ? {} : { afterPosition }),
      limit: THREAD_PROJECTION_DIGEST_PAGE,
    });

    if (page.lastMessagePreview !== "") {
      lastMessagePreview = previewText(page.lastMessagePreview);
    }

    for (const digest of page.digests) {
      if (!digest.indexable) continue;
      currentMessageIds.push(digest.messageId);
      if (currentMessageIds.length > THREAD_PROJECTION_MAX_MESSAGES) {
        throw new Error("thread_search_projection_message_budget_exceeded");
      }
      if (currentState.get(digest.messageId) !== digest.sourceHash) {
        changedDigests.push(digest);
      }
    }

    if (page.nextPosition === undefined) break;
    if (page.nextPosition === afterPosition) {
      throw new Error("thread_search_projection_digest_cursor_stalled");
    }
    afterPosition = page.nextPosition;
  }

  return {
    currentMessageIds,
    changedDigests,
    lastMessagePreview,
  };
}

async function fetchChangedDocuments(
  source: ActiveTranscriptRpc,
  changedDigests: ThreadSearchDigest[],
): Promise<{ documents: SearchProjectionDocument[]; transferredBytes: number }> {
  const changedDocuments: SearchProjectionDocument[] = [];
  let transferredBytes = 0;

  for (let index = 0; index < changedDigests.length; index += THREAD_PROJECTION_DOCUMENT_BATCH) {
    const batch = changedDigests.slice(index, index + THREAD_PROJECTION_DOCUMENT_BATCH);
    const requested = new Map(batch.map((digest) => [digest.messageId, digest]));
    const documents = await source.getThreadSearchDocuments(
      batch.map((digest) => digest.messageId),
    );
    const byId = new Map(documents.map((document) => [document.message.id, document]));

    for (const [messageId, digest] of requested) {
      const document = byId.get(messageId);
      if (!document) {
        throw new Error(`thread_search_projection_document_missing:${messageId}`);
      }
      if (document.sourceHash !== digest.sourceHash) {
        throw new Error(`thread_search_projection_source_changed:${messageId}`);
      }
      transferredBytes += textEncoder.encode(document.message.text).byteLength;
      if (transferredBytes > THREAD_PROJECTION_MAX_BYTES) {
        throw new Error("thread_search_projection_byte_budget_exceeded");
      }
      changedDocuments.push(await searchProjectionDocument(document.message, document));
    }
  }

  return { documents: changedDocuments, transferredBytes };
}

async function searchProjectionDocument(
  message: ThreadProseMessage,
  document: Pick<ThreadSearchDocument, "sourceHash">,
): Promise<SearchProjectionDocument> {
  return {
    messageId: message.id,
    role: message.role,
    createdAt: message.createdAt,
    content: message.text,
    contentHash: await hashJson({
      role: message.role,
      createdAt: message.createdAt,
      text: message.text,
    }),
    sourceHash: document.sourceHash,
  };
}

async function loadProjectableThread(env: Env, threadId: string): Promise<ThreadIndex | null> {
  const thread = await new ThreadRepository(registryDb(env)).getById(threadId);
  if (!thread || thread.kind === "feedback") return null;
  return thread;
}

function previewText(text: string): string {
  return text.slice(0, THREAD_LAST_MESSAGE_PREVIEW_CHARS);
}

async function hashJson(value: unknown): Promise<string> {
  return sha256Hex(textEncoder.encode(JSON.stringify(value)).buffer);
}
