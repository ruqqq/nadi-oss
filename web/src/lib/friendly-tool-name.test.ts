import { describe, expect, it } from "vitest";
import { friendlyToolName } from "./friendly-tool-name";

describe("friendlyToolName", () => {
  it("maps curated built-in tools to human labels", () => {
    expect(friendlyToolName("confirm_work_saved")).toBe("Confirm work saved");
    expect(friendlyToolName("nameNewConversation")).toBe("Name conversation");
    expect(friendlyToolName("web_search")).toBe("Search the web");
    expect(friendlyToolName("read_file")).toBe("Read file");
    expect(friendlyToolName("write_file")).toBe("Write file");
    expect(friendlyToolName("apply_patch")).toBe("Apply patch");
  });

  it("humanizes an unmapped snake_case tool", () => {
    expect(friendlyToolName("some_new_tool")).toBe("Some new tool");
  });

  it("humanizes an unmapped camelCase tool", () => {
    expect(friendlyToolName("doSomethingClever")).toBe("Do something clever");
  });

  it("never leaves a raw underscore identifier as-is", () => {
    expect(friendlyToolName("x_y_z")).toBe("X y z");
  });
});
