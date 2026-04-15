import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const stackSourcePath = path.resolve(process.cwd(), "infra/lib/minecraft-stack.ts");

describe("minecraft-stack SecureString/KMS policy contract", () => {
  it("uses StringLike encryption-context scoping for /minecraft/* parameters", () => {
    const source = readFileSync(stackSourcePath, "utf8");

    expect(source).toContain('actions: ["kms:Decrypt"]');
    expect(source).toContain('resources: [`arn:aws:kms:${this.region}:${this.account}:key/*`]');
    expect(source).toContain("StringLike");
    expect(source).toContain('"kms:EncryptionContext:PARAMETER_ARN": `arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/*`');
  });
});
