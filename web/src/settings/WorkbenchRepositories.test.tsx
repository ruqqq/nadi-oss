// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

// Mock the GitHub API layer so we can assert exactly what id the picker uses.
const getGithubSettings = vi.fn();
const listInstallationRepositories = vi.fn();
vi.mock("../github-api", () => ({
  getGithubSettings: (...a: unknown[]) => getGithubSettings(...a),
  listInstallationRepositories: (...a: unknown[]) => listInstallationRepositories(...a),
}));

import { WorkbenchRepositories } from "./WorkbenchRepositories";

// A GitHub installation carries BOTH a string row id (`id`, the FK target for
// workbench_repositories.source_installation_id) and the numeric GitHub
// `installationId`. The list-repositories endpoint keys on the NUMERIC id.
const INSTALLATION = {
  id: "ghi_87df8deb-3739-4fee-bcc4-33a13b8c191e",
  installationId: 146654904,
  accountLogin: "ruqqq",
  accountType: "user" as const,
  repositorySelection: "all" as const,
  status: "active" as const,
  connectedByUserId: "u1",
  updatedAt: 1,
};
const REPO = {
  id: 555,
  fullName: "ruqqq/nadi",
  owner: "ruqqq",
  name: "nadi",
  defaultBranch: "main",
  cloneUrl: "https://github.com/ruqqq/nadi.git",
  private: true,
};

// cmdk / Radix rely on DOM APIs jsdom doesn't implement.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn() as never;
  Element.prototype.hasPointerCapture = vi.fn(() => false) as never;
  Element.prototype.setPointerCapture = vi.fn() as never;
  Element.prototype.releasePointerCapture = vi.fn() as never;
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;
  }
});

beforeEach(() => {
  window.matchMedia = (query: string) =>
    ({
      matches: false, // desktop path -> anchored Popover
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
  getGithubSettings.mockResolvedValue({ configured: true, installations: [INSTALLATION] });
  listInstallationRepositories.mockResolvedValue({ repositories: [REPO], hasNextPage: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkbenchRepositories add-repository picker", () => {
  it("lists installation repos by the NUMERIC installationId, not the string row id", async () => {
    render(<WorkbenchRepositories value={[]} onChange={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /add a repository/i }));

    await waitFor(() => expect(listInstallationRepositories).toHaveBeenCalled());
    // The backend endpoint coerces the :id param with Number() and matches on
    // the numeric installationId — passing the "ghi_..." row id yields NaN -> 404.
    expect(listInstallationRepositories).toHaveBeenCalledWith("146654904", 1);
    expect(listInstallationRepositories).not.toHaveBeenCalledWith(INSTALLATION.id, 1);

    // And the repo actually surfaces in the list.
    await waitFor(() => expect(screen.getByText("ruqqq/nadi")).toBeTruthy());
  });

  it("stages a selected GitHub repo with the string row id as sourceInstallationId", async () => {
    const onChange = vi.fn();
    render(<WorkbenchRepositories value={[]} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /add a repository/i }));
    await waitFor(() => expect(screen.getByText("ruqqq/nadi")).toBeTruthy());
    fireEvent.click(screen.getByText("ruqqq/nadi"));

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        source: "github",
        githubRepoId: REPO.id,
        // FK -> github_app_installations.id (the string row id), NOT the number.
        sourceInstallationId: INSTALLATION.id,
        name: REPO.fullName,
        url: REPO.cloneUrl,
        checkoutPathName: REPO.name,
        defaultBranch: REPO.defaultBranch,
      }),
    ]);
  });

  // GitHub caps `/installation/repositories` at 100 per page. Reading only the
  // first page silently truncates the picker, so a repo on page 2 is unfindable
  // by search — the Command filter only sees what we loaded.
  it("follows hasNextPage so repos beyond the first page are searchable", async () => {
    const PAGE_TWO_REPO = { ...REPO, id: 999, fullName: "ruqqq/late", name: "late" };
    listInstallationRepositories.mockImplementation((_id: string, page: number) =>
      Promise.resolve(
        page === 1
          ? { repositories: [REPO], hasNextPage: true }
          : { repositories: [PAGE_TWO_REPO], hasNextPage: false },
      ),
    );

    render(<WorkbenchRepositories value={[]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /add a repository/i }));

    await waitFor(() => expect(screen.getByText("ruqqq/late")).toBeTruthy());
    expect(screen.getByText("ruqqq/nadi")).toBeTruthy();
    expect(listInstallationRepositories).toHaveBeenCalledWith("146654904", 2);
  });
});
