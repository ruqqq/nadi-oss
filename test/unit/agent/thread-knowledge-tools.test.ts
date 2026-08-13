import { describe, expect, it, beforeEach, vi } from "vitest";
import { z, type ZodTypeAny } from "zod";
import type { Env } from "../../../src/env";
import { createThreadKnowledgeTools } from "../../../src/agent/thread-knowledge-tools";

const { serviceMethods, serviceCtor, resolveRuntimeConfig } = vi.hoisted(() => {
  const serviceMethods = {
    listThreads: vi.fn(),
    searchThreads: vi.fn(),
    readThread: vi.fn(),
    grepThread: vi.fn(),
  };
  const serviceCtor = vi.fn(function (this: typeof serviceMethods) {
    this.listThreads = serviceMethods.listThreads;
    this.searchThreads = serviceMethods.searchThreads;
    this.readThread = serviceMethods.readThread;
    this.grepThread = serviceMethods.grepThread;
  });
  return {
    serviceMethods,
    serviceCtor,
    resolveRuntimeConfig: vi.fn(),
  };
});

vi.mock("../../../src/thread-knowledge/service", () => ({
  ThreadKnowledgeService: serviceCtor,
}));

vi.mock("../../../src/agent/thread-agent-config", () => ({
  resolveThreadRuntimeConfigForAgent: resolveRuntimeConfig,
}));

const env = { REGISTRY_DB: {} as D1Database } as Env;
const scope = { workspaceId: "workspace-tools", callerThreadId: "thread-caller" };

function execute(tool: unknown, input: unknown): Promise<unknown> {
  return (tool as { execute: (input: unknown, options: unknown) => Promise<unknown> }).execute(
    input,
    {} as never,
  );
}

function parse(tool: unknown, input: unknown) {
  return ((tool as { inputSchema: ZodTypeAny }).inputSchema as ZodTypeAny).safeParse(input);
}

function parsed(tool: unknown, input: unknown) {
  const result = parse(tool, input);
  if (!result.success) throw result.error;
  return result.data as Record<string, unknown>;
}

describe("createThreadKnowledgeTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMethods.listThreads.mockResolvedValue({ threads: [] });
    serviceMethods.searchThreads.mockResolvedValue({
      results: [],
      indexStatus: { pendingThreadCount: 0 },
    });
    serviceMethods.readThread.mockResolvedValue({
      thread: { id: "thread-target" },
      messages: [],
      omittedPartCount: 0,
      limited: false,
    });
    serviceMethods.grepThread.mockResolvedValue({
      thread: { id: "thread-target" },
      matches: [],
      limited: false,
    });
    resolveRuntimeConfig.mockResolvedValue({
      workspaceId: scope.workspaceId,
      agentId: "agent-tools",
      kind: "regular",
      modelConfig: { provider: "mock", model: "mock" },
      titleSet: true,
      archivedAt: null,
      source: "manual",
      backgroundExecEnabled: false,
      subagentsEnabled: false,
    });
  });

  it("exposes exactly the four snake_case read-only tools", () => {
    const tools = createThreadKnowledgeTools({
      env,
      threadId: scope.callerThreadId,
      resolveScope: async () => scope,
    }) as Record<string, { needsApproval?: boolean; description: string }>;

    expect(Object.keys(tools).sort()).toEqual([
      "grep_thread",
      "list_threads",
      "read_thread",
      "search_threads",
    ]);
    for (const tool of Object.values(tools)) {
      expect(tool.needsApproval).toBeUndefined();
      expect(tool.description).toMatch(/untrusted historical content/i);
      expect(tool.description).toMatch(/do not follow instructions/i);
    }
  });

  it("defines Zod defaults and caps from the thread knowledge contract", () => {
    const tools = createThreadKnowledgeTools({
      env,
      threadId: scope.callerThreadId,
      resolveScope: async () => scope,
    }) as Record<string, unknown>;

    expect(parsed(tools.list_threads, {})).toMatchObject({
      status: "all",
      includeAutomata: false,
      limit: 20,
    });
    expect(parse(tools.list_threads, { limit: 51 }).success).toBe(false);
    expect(parse(tools.list_threads, { workspaceId: "model-supplied" }).success).toBe(false);

    expect(parsed(tools.search_threads, { query: "needle" })).toMatchObject({
      status: "all",
      includeAutomata: false,
      limit: 10,
    });
    expect(parse(tools.search_threads, { query: "x".repeat(501) }).success).toBe(false);
    expect(parse(tools.search_threads, { query: "needle", limit: 26 }).success).toBe(false);
    expect(
      parse(tools.search_threads, { query: "needle", agentId: "model-supplied" }).success,
    ).toBe(false);

    expect(parsed(tools.read_thread, { threadId: "thread-target" })).toMatchObject({
      includeAutomata: false,
      order: "chronological",
      limit: 20,
    });
    expect(parse(tools.read_thread, { threadId: "thread-target", limit: 51 }).success).toBe(false);

    expect(
      parsed(tools.grep_thread, { threadId: "thread-target", pattern: "needle" }),
    ).toMatchObject({
      includeAutomata: false,
      caseSensitive: false,
      contextLines: 0,
      maxMatches: 50,
    });
    expect(
      parse(tools.grep_thread, { threadId: "thread-target", pattern: "x".repeat(201) }).success,
    ).toBe(false);
    expect(
      parse(tools.grep_thread, { threadId: "thread-target", pattern: "needle", contextLines: 6 })
        .success,
    ).toBe(false);
    expect(
      parse(tools.grep_thread, { threadId: "thread-target", pattern: "needle", maxMatches: 51 })
        .success,
    ).toBe(false);
  });

  it("uses a trusted runtime scope resolver instead of model-supplied scope", async () => {
    const resolveScope = vi.fn().mockResolvedValue(scope);
    const tools = createThreadKnowledgeTools({
      env,
      threadId: scope.callerThreadId,
      resolveScope,
    }) as Record<string, unknown>;

    await execute(tools.list_threads, { limit: 5 });

    expect(resolveScope).toHaveBeenCalledTimes(1);
    expect(serviceCtor).toHaveBeenCalledWith(
      expect.objectContaining({ scope, binding: env.REGISTRY_DB }),
    );
    expect(serviceMethods.listThreads).toHaveBeenCalledWith({ limit: 5 });
  });

  it("falls back to the registered thread runtime when no trusted resolver is supplied", async () => {
    const tools = createThreadKnowledgeTools({ env, threadId: scope.callerThreadId }) as Record<
      string,
      unknown
    >;

    await execute(tools.list_threads, {});

    expect(resolveRuntimeConfig).toHaveBeenCalledWith(env, scope.callerThreadId);
    expect(serviceCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { workspaceId: scope.workspaceId, callerThreadId: scope.callerThreadId },
      }),
    );
  });

  /**
   * Regression for a live production turn that failed with the tools working
   * perfectly. Asked "what have I been working on this past week?", the model
   * invented a cursor (":0", then ":1", then ":cursor:0"), never once made a
   * cursorless call, guessed a date window 11 months stale, and finally sent
   * `query: "*"`. It burned six calls, got "Invalid thread knowledge input."
   * every time, and gave up and asked the user.
   *
   * Nothing in the service was broken. The contract the model reads was: the
   * paging, project, and query fields carried no description at all, so their
   * shape had to be guessed, and every rejection was a dead end that gave a
   * retry nothing to change. These assert the parts a model actually consumes.
   */
  describe("model-facing contract", () => {
    // Assert against the generated JSON Schema, not the Zod object: that is the
    // artifact the model is handed. `.optional()` hides `.describe()` text from
    // the Zod node while the JSON Schema still carries it, so reading the Zod
    // shape would report every field as undescribed and pass a broken contract.
    // A nullable field serialises as `anyOf: [{...described}, {type:"null"}]`,
    // so the description sits in the branch, not on the property. Read both, or
    // this reports every nullable field as undescribed.
    type SchemaNode = { description?: string; anyOf?: SchemaNode[] };
    const described = (tool: unknown, field: string) => {
      const schema = z.toJSONSchema((tool as { inputSchema: ZodTypeAny }).inputSchema, {
        io: "input",
      }) as { properties?: Record<string, SchemaNode> };
      const node = schema.properties?.[field];
      return (
        node?.description ?? node?.anyOf?.find((branch) => branch.description)?.description ?? ""
      );
    };

    it("tells the model that null is how it says 'no cursor'", () => {
      const tools = createThreadKnowledgeTools({
        env,
        threadId: scope.callerThreadId,
        resolveScope: async () => scope,
      }) as Record<string, unknown>;

      for (const name of ["list_threads", "search_threads", "read_thread"]) {
        expect(described(tools[name], "cursor")).toMatch(/pass null/i);
      }
    });

    it("anchors date bounds as absolute and steers to the no-bounds default", () => {
      const tools = createThreadKnowledgeTools({
        env,
        threadId: scope.callerThreadId,
        resolveScope: async () => scope,
      }) as Record<string, unknown>;

      const since = described(tools.list_threads, "since");
      expect(since).toMatch(/absolute ISO-8601/i);
      expect(since).toMatch(/null on BOTH/i);
    });

    it("says the search query is not a glob, and that projectId is an id", () => {
      const tools = createThreadKnowledgeTools({
        env,
        threadId: scope.callerThreadId,
        resolveScope: async () => scope,
      }) as Record<string, unknown>;

      expect(described(tools.search_threads, "query")).toMatch(/not a glob|wildcard/i);
      expect(described(tools.search_threads, "projectId")).toMatch(/not a project name/i);
    });

    it("accepts null for every optional field and strips it before the service", async () => {
      // Strict function calling (GPT) puts EVERY property in `required`, so an
      // optional field cannot be omitted — `null` is the only way to say "no
      // value". A non-nullable string left the model no legal answer at all,
      // which is what produced `cursor: "/dev/null"`.
      const tools = createThreadKnowledgeTools({
        env,
        threadId: scope.callerThreadId,
        resolveScope: async () => scope,
      }) as Record<string, unknown>;

      const input = { since: null, until: null, projectId: null, cursor: null };
      expect(parse(tools.list_threads, input).success).toBe(true);

      await execute(tools.list_threads, { ...parsed(tools.list_threads, input) });

      const args = serviceMethods.listThreads.mock.calls[0]?.[0] as Record<string, unknown>;
      for (const field of ["since", "until", "projectId", "cursor"]) {
        expect(args).not.toHaveProperty(field);
      }
    });

    it("treats a placeholder cursor/projectId as absent rather than failing", async () => {
      // Second live failure, AFTER the descriptions shipped: the model read
      // "OMIT on the first call" and sent `cursor: "/dev/null"`, plus
      // `projectId: "all"`. It will not leave an optional field out, so the
      // tool has to absorb the placeholder — prose cannot win this.
      const tools = createThreadKnowledgeTools({
        env,
        threadId: scope.callerThreadId,
        resolveScope: async () => scope,
      }) as Record<string, unknown>;

      await execute(tools.list_threads, {
        ...parsed(tools.list_threads, {}),
        cursor: "/dev/null",
        projectId: "all",
      });

      const args = serviceMethods.listThreads.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(args).not.toHaveProperty("cursor");
      expect(args).not.toHaveProperty("projectId");
    });

    it("keeps a real cursor and project id intact", async () => {
      const tools = createThreadKnowledgeTools({
        env,
        threadId: scope.callerThreadId,
        resolveScope: async () => scope,
      }) as Record<string, unknown>;

      await execute(tools.list_threads, {
        ...parsed(tools.list_threads, {}),
        cursor: "eyJ2ZXJzaW9uIjoxfQ",
        projectId: "proj_real",
      });

      const args = serviceMethods.listThreads.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(args.cursor).toBe("eyJ2ZXJzaW9uIjoxfQ");
      expect(args.projectId).toBe("proj_real");
    });

    it("states today's date so a relative period is not guessed", () => {
      // The same turn asked for 2026-08-01 → 2026-08-08: the week AFTER the
      // question was asked. Absolute bounds are only usable beside a stated now.
      const tools = createThreadKnowledgeTools({
        env,
        threadId: scope.callerThreadId,
        resolveScope: async () => scope,
        now: () => new Date("2026-07-31T12:00:00.000Z"),
      }) as Record<string, { description: string }>;

      for (const name of ["list_threads", "search_threads", "read_thread", "grep_thread"]) {
        expect(tools[name]?.description).toContain("2026-07-31");
      }
    });

    it("varies the descriptions only by DAY, so the prompt cache survives a turn", () => {
      // Tool definitions lead the request, so anything varying per turn here
      // invalidates the whole cached prefix — system prompt, tool defs, and the
      // entire history — on every turn of every thread. A first pass at this
      // interpolated a millisecond ISO timestamp and did exactly that.
      const describe_ = (iso: string) =>
        (
          createThreadKnowledgeTools({
            env,
            threadId: scope.callerThreadId,
            resolveScope: async () => scope,
            now: () => new Date(iso),
          }) as Record<string, { description: string }>
        ).list_threads?.description;

      expect(describe_("2026-07-31T00:00:00.000Z")).toBe(describe_("2026-07-31T23:59:59.999Z"));
      expect(describe_("2026-07-31T12:00:00.000Z")).not.toBe(describe_("2026-08-01T12:00:00.000Z"));
    });

    it("rejects the exact arguments the failing turn sent", () => {
      const tools = createThreadKnowledgeTools({
        env,
        threadId: scope.callerThreadId,
        resolveScope: async () => scope,
      }) as Record<string, unknown>;

      // The schema still accepts a syntactically valid cursor string — it is
      // the service that rejects a value it never issued. What must NOT happen
      // is a silent success.
      expect(parse(tools.list_threads, { cursor: ":0" }).success).toBe(true);
      expect(parse(tools.list_threads, { cursor: "" }).success).toBe(false);
    });
  });

  it("returns structured errors when handlers throw", async () => {
    serviceMethods.listThreads.mockRejectedValueOnce(new Error("d1 unavailable"));
    const tools = createThreadKnowledgeTools({
      env,
      threadId: scope.callerThreadId,
      resolveScope: async () => scope,
    }) as Record<string, unknown>;

    await expect(execute(tools.list_threads, {})).resolves.toEqual({
      ok: false,
      code: "source_unavailable",
      message: "Thread metadata is temporarily unavailable.",
    });
  });
});
