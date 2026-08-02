import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  markUpdateApplied,
  showAppliedUpdateToast,
  watchForServiceWorkerUpdate,
} from "./sw-update-toast";

vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(),
    success: vi.fn(),
    dismiss: vi.fn(),
  },
}));

/** A ServiceWorker whose state is settable, so tests can drive statechange. */
class FakeWorker extends EventTarget {
  state: ServiceWorkerState = "installing";
  setState(state: ServiceWorkerState) {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

/** A registration whose updatefound tests can fire, with a settable active worker. */
class FakeRegistration extends EventTarget {
  active: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  updateFound(installing: FakeWorker | null) {
    this.installing = installing;
    this.dispatchEvent(new Event("updatefound"));
  }
}

const asRegistration = (r: FakeRegistration) => r as unknown as ServiceWorkerRegistration;

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

/** Storage that throws on every access (Safari private mode). */
const throwingStorage = (): Storage =>
  ({
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  }) as unknown as Storage;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("watchForServiceWorkerUpdate", () => {
  it("shows the downloading toast when a worker installs over an active one", () => {
    const reg = new FakeRegistration();
    reg.active = new FakeWorker();
    watchForServiceWorkerUpdate(asRegistration(reg));

    reg.updateFound(new FakeWorker());

    expect(toast.loading).toHaveBeenCalledWith("Downloading update…", { id: "sw-update" });
  });

  it("stays silent on the first-ever install (no active worker)", () => {
    const reg = new FakeRegistration();
    reg.active = null;
    watchForServiceWorkerUpdate(asRegistration(reg));

    reg.updateFound(new FakeWorker());

    expect(toast.loading).not.toHaveBeenCalled();
  });

  it("dismisses the toast without an error when the install goes redundant", () => {
    const reg = new FakeRegistration();
    reg.active = new FakeWorker();
    const installing = new FakeWorker();
    watchForServiceWorkerUpdate(asRegistration(reg));
    reg.updateFound(installing);

    installing.setState("redundant");

    expect(toast.dismiss).toHaveBeenCalledWith("sw-update");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("leaves the toast up while the install progresses", () => {
    const reg = new FakeRegistration();
    reg.active = new FakeWorker();
    const installing = new FakeWorker();
    watchForServiceWorkerUpdate(asRegistration(reg));
    reg.updateFound(installing);

    installing.setState("installed");

    expect(toast.dismiss).not.toHaveBeenCalled();
  });
});

describe("showAppliedUpdateToast", () => {
  it("reports an update marked by the previous load", () => {
    const storage = fakeStorage();
    markUpdateApplied(storage);

    showAppliedUpdateToast(storage);

    expect(toast.success).toHaveBeenCalledWith("Updated to the latest version");
  });

  it("stays silent when no update was applied", () => {
    showAppliedUpdateToast(fakeStorage());

    expect(toast.success).not.toHaveBeenCalled();
  });

  it("consumes the flag, so a repeat call cannot double-toast", () => {
    const storage = fakeStorage();
    markUpdateApplied(storage);

    showAppliedUpdateToast(storage);
    showAppliedUpdateToast(storage);

    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("survives storage that throws", () => {
    expect(() => markUpdateApplied(throwingStorage())).not.toThrow();
    expect(() => showAppliedUpdateToast(throwingStorage())).not.toThrow();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
