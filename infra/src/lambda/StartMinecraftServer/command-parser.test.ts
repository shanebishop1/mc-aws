import { describe, expect, it } from "vitest";

import { parseCommand } from "./command-parser.js";

describe("parseCommand", () => {
  it("parses valid commands with strict tokenization", () => {
    expect(parseCommand("start", "start")).toEqual({ command: "start", args: [] });
    expect(parseCommand("  START  ", "start")).toEqual({ command: "start", args: [] });
    expect(parseCommand("backup", "start")).toEqual({ command: "backup", args: [] });
    expect(parseCommand("backup nightly-2026", "start")).toEqual({ command: "backup", args: ["nightly-2026"] });
    expect(parseCommand("restore my-backup", "start")).toEqual({ command: "restore", args: ["my-backup"] });
    expect(parseCommand("hibernate", "start")).toEqual({ command: "hibernate", args: [] });
    expect(parseCommand("resume", "start")).toEqual({ command: "resume", args: [] });
  });

  it("rejects malformed command formats", () => {
    expect(parseCommand("resume now", "start")).toBeNull();
    expect(parseCommand("backup nightly extra", "start")).toBeNull();
    expect(parseCommand("restore one two", "start")).toBeNull();
  });

  it("rejects ambiguous or substring-based subjects", () => {
    expect(parseCommand("start backup", "start")).toBeNull();
    expect(parseCommand("backup restore", "start")).toBeNull();
    expect(parseCommand("please start", "start")).toBeNull();
    expect(parseCommand("restart", "start")).toBeNull();
  });

  it("supports custom start keyword while remaining strict", () => {
    expect(parseCommand("wake", "wake")).toEqual({ command: "start", args: [] });
    expect(parseCommand("wake now", "wake")).toBeNull();
  });
});
