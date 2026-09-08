import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXECUTOR_JOURNAL_CREDENTIAL_NAME,
  readExactSystemdCredential,
  readExecutorJournalAuthenticationKey,
} from "./protected-input";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function credentialDirectory(): Promise<{ directory: string; secret: Buffer }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mc-aws-executor-credentials-"));
  roots.push(directory);
  const secret = Buffer.from("executor-journal-hmac-test-value-32", "utf8").subarray(0, 32);
  const credentialPath = path.join(directory, EXECUTOR_JOURNAL_CREDENTIAL_NAME);
  await writeFile(credentialPath, secret, { mode: 0o400 });
  await chmod(credentialPath, 0o400);
  return { directory, secret };
}

describe("executor CLI credential startup", () => {
  it("reads the simulated LoadCredential value before sandbox startup without exposing it in errors", async () => {
    const { directory, secret } = await credentialDirectory();
    const credential = await readExactSystemdCredential(EXECUTOR_JOURNAL_CREDENTIAL_NAME, 32, {
      CREDENTIALS_DIRECTORY: directory,
    });
    expect(credential.path).toBe(path.join(directory, EXECUTOR_JOURNAL_CREDENTIAL_NAME));
    expect(credential.value).toEqual(secret);
    credential.value.fill(0);

    await expect(readExecutorJournalAuthenticationKey({ CREDENTIALS_DIRECTORY: directory })).rejects.toThrow(
      /systemd credentials are unavailable/i
    );
    try {
      await readExactSystemdCredential("unexpected-credential", 32, { CREDENTIALS_DIRECTORY: directory });
    } catch (error) {
      expect(String(error)).not.toContain(secret.toString("utf8"));
    }
  });

  it("fails closed when LoadCredential exposes an unexpected second credential", async () => {
    const { directory } = await credentialDirectory();
    await writeFile(path.join(directory, "unexpected-credential"), Buffer.alloc(32, 7), { mode: 0o400 });
    await expect(
      readExactSystemdCredential(EXECUTOR_JOURNAL_CREDENTIAL_NAME, 32, { CREDENTIALS_DIRECTORY: directory })
    ).rejects.toThrow(/unexpected credential/i);
  });
});
