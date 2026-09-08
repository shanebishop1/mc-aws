import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAuthSecret } from "./manage-auth-secret";

const validSecret = "jyp8kdTmswhaH5xy5NaoA3tcHpTyqGDTx-WbFKgm8Nk";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const environmentFiles = (contents = `AUTH_SECRET=${validSecret}\n`): [string, string] => {
  const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-auth-rotation-"));
  temporaryDirectories.push(directory);
  const production = path.join(directory, ".env.production");
  const local = path.join(directory, ".env.local");
  writeFileSync(production, contents, { mode: 0o600 });
  writeFileSync(local, contents, { mode: 0o600 });
  return [production, local];
};

describe("crash-safe AUTH_SECRET rotation", () => {
  it("rotates a currently valid secret when the explicit flag is set", () => {
    const [production, local] = environmentFiles();
    let randomCalls = 0;
    ensureAuthSecret({
      envFile: production,
      secondaryEnvFile: local,
      rotate: true,
      randomBytes: (size) => {
        randomCalls += 1;
        return randomBytes(size);
      },
    });

    const rotated = readFileSync(production, "utf8").trim().replace("AUTH_SECRET=", "");
    expect(randomCalls).toBe(1);
    expect(rotated).not.toBe(validSecret);
    expect(readFileSync(local, "utf8")).toContain(`AUTH_SECRET=${rotated}`);
  });

  it("repairs an interrupted file write from the journal without generating again", () => {
    const [production, local] = environmentFiles();
    ensureAuthSecret({ envFile: production, secondaryEnvFile: local, rotate: true });
    const rotated = readFileSync(production, "utf8").trim().replace("AUTH_SECRET=", "");

    // Model a crash after the journal was written but before the selected file
    // was durably updated. The rerun must use the journaled candidate.
    writeFileSync(production, `AUTH_SECRET=${validSecret}\n`, { mode: 0o600 });
    let randomCalls = 0;
    ensureAuthSecret({
      envFile: production,
      secondaryEnvFile: local,
      rotate: true,
      randomBytes: () => {
        randomCalls += 1;
        throw new Error("a second random value would violate rotation recovery");
      },
    });

    expect(randomCalls).toBe(0);
    expect(readFileSync(production, "utf8")).toContain(`AUTH_SECRET=${rotated}`);
    expect(readFileSync(local, "utf8")).toContain(`AUTH_SECRET=${rotated}`);
  });

  it("does not print the generated candidate", () => {
    const [production, local] = environmentFiles();
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/setup/manage-auth-secret.ts",
        "ensure",
        "--env-file",
        production,
        "--secondary-env-file",
        local,
        "--rotate",
        "1",
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );

    const generated = readFileSync(production, "utf8").trim().replace("AUTH_SECRET=", "");
    expect(output).toBe("");
    expect(generated).not.toBe(validSecret);
    expect(output).not.toContain(generated);
  });
});
