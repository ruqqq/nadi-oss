// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadSummary } from "../../threads-api";
import { ThreadReadOnlyNotice } from "./ThreadReadOnlyNotice";

afterEach(cleanup);

const thread = (overrides: Partial<ThreadSummary> = {}): ThreadSummary => ({
  threadId: "thr_1",
  kind: "regular",
  workspaceId: "ws_1",
  agentId: "ag_1",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  modelInputModalities: ["text"],
  reasoningEffort: "medium",
  modelSupportsReasoning: true,
  runtime: "think",
  title: "A chat",
  source: "manual",
  lastMessagePreview: "",
  archivedAt: null,
  readOnly: true,
  status: "active",
  projectId: null,
  projectName: null,
  agentName: null,
  resourceProfile: "small",
  automatonId: null,
  automatonName: null,
  automatonNotifyMode: null,
  outcomeDismissedAt: null,
  recentDismissedAt: null,
  repositoryCount: 0,
  lastContextTokens: null,
  lastContextWindow: null,
  lastCompactAfterTokens: null,
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

describe("ThreadReadOnlyNotice", () => {
  it("names the deleted agent and says the chat survives", () => {
    render(<ThreadReadOnlyNotice thread={thread({ readOnlyReason: "agent_deleted" })} />);

    expect(screen.getByTestId("thread-read-only-notice")).toHaveTextContent(
      "This chat's agent was deleted. The chat stays here to read.",
    );
  });

  it("points a disabled agent at the setting that turns it back on", () => {
    render(<ThreadReadOnlyNotice thread={thread({ readOnlyReason: "agent_disabled" })} />);

    expect(screen.getByTestId("thread-read-only-notice")).toHaveTextContent(
      "This chat's agent is turned off. Turn it back on in Settings → Agents to keep working here.",
    );
  });

  it("keeps today's wording for an archived thread", () => {
    const notice = render(
      <ThreadReadOnlyNotice
        thread={thread({ readOnlyReason: "thread_archived", archivedAt: 5, status: "archived" })}
      />,
    );

    expect(screen.getByTestId("thread-read-only-notice")).toHaveTextContent("Archived thread");
    // The fix clause is genuinely ABSENT, not empty: there is nothing for the
    // reader to do, and an empty second span would leave a stray gap.
    expect(notice.container.querySelectorAll("span")).toHaveLength(1);
  });

  it("falls back to today's wording when the payload carries no reason", () => {
    // A tab still holding a payload from before `readOnlyReason` existed. It
    // must render, not blank out.
    render(<ThreadReadOnlyNotice thread={thread({ archivedAt: 5, status: "archived" })} />);

    expect(screen.getByTestId("thread-read-only-notice")).toHaveTextContent("Archived thread");
  });
});
