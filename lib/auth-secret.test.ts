import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateProductionAuthSecret } from "./auth-secret";
import { validateWorkerStartupEnvironment } from "./worker-startup";

describe("production AUTH_SECRET policy", () => {
  it.each([
    ["short", "N7!short-secret"],
    ["repeated", "abcd".repeat(20)],
    ["dictionary", "correct-horse-battery-staple-correct-horse-battery-staple"],
    ["common", "P@ssw0rd-P@ssw0rd-P@ssw0rd-P@ssw0rd-P@ssw0rd"],
    ["low-entropy 32-character", "0123456789abcdef0123456789abcdef"],
    ["placeholder", "dev-secret-change-in-production"],
    ["audit ordered string", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"],
    ["long ordered string", "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_"],
    ["padded base64", `${randomBytes(48).toString("base64")}=`],
    ["strict hex", randomBytes(48).toString("hex")],
    ["arbitrary high-complexity text", "vQ7!mZ2@pL9#xR4$kT8%wN3^cF6&hJ1*eD5-sA0_gY"],
  ])("rejects %s values", (_kind, secret) => {
    expect(validateProductionAuthSecret(secret).valid).toBe(false);
  });

  it("accepts only canonical generated base64url material of at least 32 bytes", () => {
    const candidates = [randomBytes(32).toString("base64url"), randomBytes(48).toString("base64url")];

    for (const secret of candidates) {
      expect(validateProductionAuthSecret(secret), secret).toEqual({ valid: true, reason: "valid" });
    }
  });

  it("rejects encoded repeated and dictionary material despite sufficient encoded length", () => {
    expect(validateProductionAuthSecret(Buffer.from("a".repeat(32)).toString("base64url")).valid).toBe(false);
    expect(
      validateProductionAuthSecret(Buffer.from("correct-horse-battery-staple!!!!").toString("base64url")).valid
    ).toBe(false);
  });

  it("fails Worker startup closed for an unsafe secret", () => {
    expect(() => validateWorkerStartupEnvironment({ MC_BACKEND_MODE: "aws", AUTH_SECRET: "x".repeat(64) })).toThrow(
      "at least 32 cryptographically random bytes"
    );
    expect(() =>
      validateWorkerStartupEnvironment({
        MC_BACKEND_MODE: "aws",
        AUTH_SECRET: randomBytes(48).toString("base64url"),
      })
    ).not.toThrow();
  });

  it("fails Worker startup closed when the runtime binding is missing", () => {
    expect(() => validateWorkerStartupEnvironment({ MC_BACKEND_MODE: "aws" })).toThrow("AUTH_SECRET is required");
  });

  it.each([undefined, "mock", "AWS", "invalid"])("fails Worker startup closed for backend mode %s", (mode) => {
    expect(() =>
      validateWorkerStartupEnvironment({ MC_BACKEND_MODE: mode, AUTH_SECRET: randomBytes(48).toString("base64url") })
    ).toThrow("MC_BACKEND_MODE");
  });
});
