import type { ThreadComputeStoreLike } from "../../../../src/compute/thread-service";
import type { ComputeProcessRecord, ComputeState } from "../../../../src/compute/thread-store";
import type { WatcherRow } from "../../../../src/compute/watchers";

export function createMemoryComputeStore(): ThreadComputeStoreLike {
  let state: ComputeState | null = null;
  const processes = new Map<string, ComputeProcessRecord>();
  const chunks: Array<{
    processId: string;
    stream: "stdout" | "stderr";
    text: string;
  }> = [];
  const watchers = new Map<string, WatcherRow>();
  const autoWatched = new Set<string>();

  const base = (now: number): ComputeState =>
    state ?? {
      id: "thread",
      status: "absent",
      provider: null,
      providerConfig: null,
      acquiredAllowedHosts: undefined,
      runtimeRef: null,
      recoveryRef: null,
      resourceProfile: "small",
      createdAt: now,
      lastUsedAt: now,
      releaseAt: null,
      recoveredAt: null,
      recoveryExpiresAt: null,
      errorCode: null,
      errorDetail: null,
      releaseReason: null,
      generation: null,
      generationAbsentAt: null,
    };

  return {
    getComputeState: () => state,
    markAcquiring: ({ provider, resourceProfile, allowedHosts, now, recoveryRef }) => {
      state = {
        ...base(now),
        status: "acquiring",
        provider,
        providerConfig: state?.providerConfig ?? null,
        acquiredAllowedHosts: allowedHosts,
        resourceProfile,
        runtimeRef: null,
        recoveryRef: recoveryRef ?? state?.recoveryRef ?? null,
        lastUsedAt: now,
        generation: null,
        generationAbsentAt: null,
      };
    },
    markActive: (runtimeRef, now) => {
      const previousRecovery = state?.recoveryRef;
      state = {
        ...base(now),
        status: "active",
        provider: runtimeRef.provider,
        providerConfig: state?.providerConfig ?? null,
        runtimeRef,
        recoveryRef: null,
        recoveredAt: previousRecovery ? now : (state?.recoveredAt ?? null),
        recoveryExpiresAt: null,
        lastUsedAt: now,
      };
    },
    markReleasing: (now) => {
      if (state) state = { ...state, status: "releasing", releaseAt: now };
    },
    markRecoverable: (recoveryRef, now, recoveryExpiresAt) => {
      state = {
        ...base(now),
        status: "recoverable",
        provider: recoveryRef.provider,
        providerConfig: state?.providerConfig ?? null,
        runtimeRef: null,
        recoveryRef,
        recoveryExpiresAt,
        lastUsedAt: now,
      };
    },
    // Both generation columns move together — mirrors ThreadComputeStore.
    markDiscarding: (now) => {
      if (state)
        state = {
          ...state,
          status: "discarding",
          releaseAt: now,
          generation: null,
          generationAbsentAt: null,
        };
    },
    markAbsent: (now) => {
      state = {
        ...base(now),
        status: "absent",
        provider: null,
        providerConfig: null,
        runtimeRef: null,
        recoveryRef: null,
        recoveryExpiresAt: null,
        lastUsedAt: now,
        generation: null,
        generationAbsentAt: null,
      };
    },
    touchLastUsed: (now) => {
      if (state) state = { ...state, lastUsedAt: now };
    },
    setResourceProfile: (resourceProfile, now) => {
      state = { ...base(now), resourceProfile };
    },
    markError: ({ code, detail }, now) => {
      state = { ...base(now), status: "error", errorCode: code, errorDetail: detail };
    },
    // `unknown` PRESERVES an existing absence — mirrors ThreadComputeStore.
    setGeneration: (generation, now) => {
      const previousAbsentAt = state?.generationAbsentAt ?? null;
      state = {
        ...base(now),
        generation: generation.kind === "known" ? generation.nonce : null,
        // Mirrors ThreadComputeStore.setGeneration exactly: `absent` is
        // write-ONCE (an absence already on record keeps its first
        // `observedAt`), and `unknown` preserves it. See that method for why.
        generationAbsentAt:
          generation.kind === "absent"
            ? (previousAbsentAt ?? generation.observedAt)
            : generation.kind === "known"
              ? null
              : previousAbsentAt,
      };
    },
    createProcess: (process) => void processes.set(process.id, process),
    updateProcess: (id, patch) => {
      const current = processes.get(id);
      // `id` and `threadId` are dropped, mirroring `ThreadComputeStore`'s own
      // column map: a process's OWNER is the routing stamp for its completion
      // reminder and its ledger row, and a row that changed hands would report
      // to a thread that never started it. A spread of the whole patch made
      // this fake ACCEPT a change the real store silently discards, so a future
      // caller would pass in unit tests and be dropped in production — the
      // exact divergence a fake is supposed to make impossible.
      if (!current) return;
      const { id: _id, threadId: _threadId, ...applicable } = patch;
      processes.set(id, { ...current, ...applicable });
    },
    listProcesses: (limit) => [...processes.values()].slice(0, limit),
    getProcess: (id) => processes.get(id) ?? null,
    appendOutput: (input) => void chunks.push(input),
    listOutputChunks: (processId, stream) => {
      let stdoutOffset = 0;
      let stderrOffset = 0;
      return chunks
        .filter((chunk) => chunk.processId === processId && (!stream || chunk.stream === stream))
        .map((chunk) => {
          const byteStart = chunk.stream === "stdout" ? stdoutOffset : stderrOffset;
          const byteEnd = byteStart + new TextEncoder().encode(chunk.text).byteLength;
          if (chunk.stream === "stdout") stdoutOffset = byteEnd;
          else stderrOffset = byteEnd;
          return {
            stream: chunk.stream,
            lineStart: 1,
            lineEnd: chunk.text.split("\n").length,
            byteStart,
            byteEnd,
            text: chunk.text,
          };
        });
    },
    upsertWatcher: (watcher) => void watchers.set(watcher.processId, watcher),
    deleteWatcher: (processId) => void watchers.delete(processId),
    listWatchers: () => [...watchers.values()],
    countWatchers: () => watchers.size,
    markProcessAutoWatched: (processId) => void autoWatched.add(processId),
    wasProcessAutoWatched: (processId) => autoWatched.has(processId),
  };
}
