// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvitesSection } from "./InvitesSection";
import type { InvitesResponse } from "../../invites-api";

vi.mock("../../invites-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../invites-api")>();
  return {
    ...actual,
    listInvites: vi.fn(),
    createInviteLink: vi.fn(),
    inviteEmail: vi.fn(),
    revokeInvite: vi.fn(),
  };
});

const api = await import("../../invites-api");
const listInvites = vi.mocked(api.listInvites);
const createInviteLink = vi.mocked(api.createInviteLink);
const inviteEmail = vi.mocked(api.inviteEmail);

const response = (over: Partial<InvitesResponse> = {}): InvitesResponse => ({
  invites: [],
  quota: { used: 0, limit: 5 },
  isSuperuser: false,
  waitingList: [],
  ...over,
});

afterEach(cleanup);

describe("InvitesSection", () => {
  it("shows the quota and an empty state", async () => {
    listInvites.mockResolvedValue(response({ quota: { used: 2, limit: 5 } }));
    render(<InvitesSection />);

    expect(await screen.findByText(/3\b/)).toBeInTheDocument();
    expect(screen.getByLabelText("3 of 5 invites left")).toBeInTheDocument();
    expect(screen.getByText("No invites yet")).toBeInTheDocument();
  });

  it("reports the quota upward so the sidebar count stays in step", async () => {
    listInvites.mockResolvedValue(response({ quota: { used: 3, limit: 5 } }));
    const onQuotaChange = vi.fn();
    render(<InvitesSection onQuotaChange={onQuotaChange} />);

    await waitFor(() => expect(onQuotaChange).toHaveBeenCalledWith({ used: 3, limit: 5 }));
  });

  it("shows unlimited for a superuser and lists the waiting list", async () => {
    listInvites.mockResolvedValue(
      response({
        isSuperuser: true,
        quota: { used: 9, limit: null },
        waitingList: [{ email: "hopeful@x.com", attempts: 2, createdAt: 1, updatedAt: 1 }],
      }),
    );
    render(<InvitesSection />);

    expect(await screen.findByText(/Unlimited invites/)).toBeInTheDocument();
    expect(screen.getByText("hopeful@x.com")).toBeInTheDocument();
    expect(screen.getByText(/2 attempts/)).toBeInTheDocument();
  });

  it("hides the waiting list from an ordinary user", async () => {
    listInvites.mockResolvedValue(response());
    render(<InvitesSection />);

    await screen.findByText("No invites yet");
    expect(screen.queryByText("Waiting list")).not.toBeInTheDocument();
  });

  it("creates a link and shows its URL", async () => {
    listInvites.mockResolvedValue(response());
    createInviteLink.mockResolvedValue({
      id: "i1",
      token: "tok-abc",
      email: null,
      status: "pending",
      createdAt: 1,
      claimedAt: null,
      acceptedAt: null,
    });
    render(<InvitesSection />);

    await screen.findByText("No invites yet");
    await userEvent.click(screen.getByRole("button", { name: /create invite link/i }));

    expect(await screen.findByText("Link not used yet")).toBeInTheDocument();
    expect(screen.getByText(/\/invite\/tok-abc$/)).toBeInTheDocument();
  });

  it("blocks creating a link once every slot is spent", async () => {
    listInvites.mockResolvedValue(response({ quota: { used: 5, limit: 5 } }));
    render(<InvitesSection />);

    expect(await screen.findByText(/used all 5 of your invites/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create invite link/i })).toBeDisabled();
  });

  it("an accepted invite cannot be revoked", async () => {
    listInvites.mockResolvedValue(
      response({
        quota: { used: 1, limit: 5 },
        invites: [
          {
            id: "i1",
            token: "tok-1",
            email: "joined@x.com",
            status: "accepted",
            createdAt: 1,
            claimedAt: 2,
            acceptedAt: 3,
          },
        ],
      }),
    );
    render(<InvitesSection />);

    expect(await screen.findByText("joined@x.com joined")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /revoke invite/i })).not.toBeInTheDocument();
  });

  it("lets a superuser invite someone off the waiting list", async () => {
    listInvites.mockResolvedValue(
      response({
        isSuperuser: true,
        quota: { used: 0, limit: null },
        waitingList: [{ email: "hopeful@x.com", attempts: 1, createdAt: 1, updatedAt: 1 }],
      }),
    );
    inviteEmail.mockResolvedValue({
      id: "i2",
      token: null,
      email: "hopeful@x.com",
      status: "claimed",
      createdAt: 1,
      claimedAt: 1,
      acceptedAt: null,
    });
    render(<InvitesSection />);

    await userEvent.click(await screen.findByRole("button", { name: "Invite" }));

    await waitFor(() => expect(inviteEmail).toHaveBeenCalledWith("hopeful@x.com"));
    // Off the waiting list, and now shown as an invite awaiting sign-in.
    await waitFor(() => expect(screen.queryByText("Nobody’s waiting")).toBeInTheDocument());
    expect(screen.getByText(/hopeful@x.com — not signed in yet/)).toBeInTheDocument();
  });
});
