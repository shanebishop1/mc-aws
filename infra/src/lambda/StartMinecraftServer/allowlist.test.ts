import { describe, expect, it } from "vitest";

import { extractEmails } from "./allowlist.js";

describe("extractEmails", () => {
  it("extracts and normalizes addresses using the existing permissive syntax", () => {
    expect(extractEmails("Add USER.Name+tag@Sub.Example.com and second@test.io.")).toEqual([
      "user.name+tag@sub.example.com",
      "second@test.io",
    ]);
    expect(extractEmails("odd@example.co.x and unusual@..example.com")).toEqual([
      "odd@example.co",
      "unusual@..example.com",
    ]);
  });

  it("returns promptly for a long domain with no valid suffix", () => {
    const text = `admin@${"a".repeat(200_000)}`;

    expect(extractEmails(text)).toEqual([]);
  });
});
