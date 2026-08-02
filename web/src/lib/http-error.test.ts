import { describe, expect, test } from "vitest";
import { errorFromResponse } from "./http-error";

describe("errorFromResponse", () => {
  test("uses a short server text body", async () => {
    const err = await errorFromResponse(
      new Response("Workspace not found", { status: 404 }),
      "load projects",
    );
    expect(err.message).toBe("Workspace not found");
  });

  test("extracts a JSON error field", async () => {
    const body = JSON.stringify({ error: "Name is already taken" });
    const err = await errorFromResponse(new Response(body, { status: 409 }), "create the project");
    expect(err.message).toBe("Name is already taken");
  });

  test("401 always uses the friendly session message, not the body", async () => {
    const err = await errorFromResponse(
      new Response("Unauthorized", { status: 401 }),
      "save the project",
    );
    expect(err.message).toBe("Your session expired. Refresh the page and sign in again.");
  });

  test("empty body falls back to a friendly status message", async () => {
    const err = await errorFromResponse(new Response("", { status: 500 }), "create the repository");
    expect(err.message).toBe(
      "Something went wrong while trying to create the repository. Please try again.",
    );
  });

  test("HTML error page body is ignored in favour of the fallback", async () => {
    const err = await errorFromResponse(
      new Response("<!doctype html><title>502</title>", { status: 502 }),
      "archive the project",
    );
    expect(err.message).toBe(
      "Something went wrong while trying to archive the project. Please try again.",
    );
  });

  test("403 fallback names the action", async () => {
    const err = await errorFromResponse(new Response("", { status: 403 }), "delete the thread");
    expect(err.message).toBe("You don't have permission to delete the thread.");
  });

  test("oversized body is ignored", async () => {
    const err = await errorFromResponse(
      new Response("x".repeat(400), { status: 400 }),
      "update the repository",
    );
    expect(err.message).toBe("Couldn't update the repository. Please try again.");
  });
});
