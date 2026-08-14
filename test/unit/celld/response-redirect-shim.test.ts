import { afterEach, describe, expect, it } from "vitest";
import { installResponseRedirectShim } from "../../../src/celld/response-redirect-shim";

const nativeRedirect = Response.redirect;

/** Reproduce celld: the static exists on no runtime we control, so remove it. */
function breakRedirect() {
  Object.defineProperty(Response, "redirect", {
    value: undefined,
    writable: true,
    configurable: true,
  });
}

afterEach(() => {
  Object.defineProperty(Response, "redirect", {
    value: nativeRedirect,
    writable: true,
    configurable: true,
  });
});

describe("installResponseRedirectShim", () => {
  it("does nothing when the runtime already implements it", () => {
    // Cloudflare. Installing over a working implementation would be a
    // needless divergence between the platforms.
    expect(installResponseRedirectShim()).toBe(false);
    expect(Response.redirect).toBe(nativeRedirect);
  });

  it("installs a working redirect when the runtime lacks it", () => {
    breakRedirect();
    expect(installResponseRedirectShim()).toBe(true);

    const res = Response.redirect("https://nadi-beta.ruqqq.sg/settings/mcp", 302);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://nadi-beta.ruqqq.sg/settings/mcp");
  });

  it("defaults to 302, as the platform does", () => {
    breakRedirect();
    installResponseRedirectShim();
    expect(Response.redirect("https://nadi-beta.ruqqq.sg/").status).toBe(302);
  });

  it("carries every redirect status the platform allows", () => {
    breakRedirect();
    installResponseRedirectShim();
    // 308 matters: the canonical-host redirect in src/index.ts uses it.
    for (const status of [301, 302, 303, 307, 308]) {
      expect(Response.redirect("https://nadi-beta.ruqqq.sg/", status).status).toBe(status);
    }
  });

  it("rejects a non-redirect status the same way the platform does", () => {
    // A caller that is wrong must stay wrong on both platforms, rather than
    // silently working on the shimmed one.
    breakRedirect();
    installResponseRedirectShim();
    expect(() => Response.redirect("https://nadi-beta.ruqqq.sg/", 200)).toThrow(RangeError);
  });

  it("rejects a relative URL the same way the platform does", () => {
    breakRedirect();
    installResponseRedirectShim();
    expect(() => Response.redirect("/settings/mcp", 302)).toThrow();
  });

  it("accepts a URL object", () => {
    breakRedirect();
    installResponseRedirectShim();
    const res = Response.redirect(new URL("https://nadi-beta.ruqqq.sg/a?b=c"), 303);
    expect(res.headers.get("location")).toBe("https://nadi-beta.ruqqq.sg/a?b=c");
  });

  it("is idempotent", () => {
    breakRedirect();
    expect(installResponseRedirectShim()).toBe(true);
    // The second call probes the shim it just installed, finds it working, and
    // declines — which is what stops a re-entrant install from stacking.
    expect(installResponseRedirectShim()).toBe(false);
    expect(Response.redirect("https://nadi-beta.ruqqq.sg/").status).toBe(302);
  });
});
