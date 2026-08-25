import { describe, expect, it } from "vitest";

import { isValidEmail } from "./email-validation";

describe("isValidEmail", () => {
  it("preserves the route's basic email validation behavior", () => {
    expect(isValidEmail("user@example.com")).toBe(true);
    expect(isValidEmail("user@sub.example.com")).toBe(true);
    expect(isValidEmail("user@a..b")).toBe(true);
    expect(isValidEmail("user@example")).toBe(false);
    expect(isValidEmail("user@.example")).toBe(false);
    expect(isValidEmail("user@example.")).toBe(false);
    expect(isValidEmail("user@@example.com")).toBe(false);
    expect(isValidEmail("user name@example.com")).toBe(false);
  });

  it("rejects a long adversarial address without regex backtracking", () => {
    const address = `${"a".repeat(100_000)}@${"a".repeat(100_000)}`;

    expect(isValidEmail(address)).toBe(false);
  });
});
