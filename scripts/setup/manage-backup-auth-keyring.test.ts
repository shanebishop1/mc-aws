import { GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import { describe, expect, it, vi } from "vitest";
import {
  BACKUP_AUTH_KEYRING_PARAMETER,
  createBackupAuthKeyring,
  parseBackupAuthKeyring,
  provisionBackupAuthKeyring,
  rotateBackupAuthKeyring,
  rotateStoredBackupAuthKeyring,
} from "./manage-backup-auth-keyring";

describe("backup authentication keyring provisioning and rotation", () => {
  it("provisions one generated SecureString without returning or logging key material", async () => {
    const send = vi.fn(async (command: GetParameterCommand | PutParameterCommand) => {
      if (command instanceof GetParameterCommand) {
        const error = new Error("missing");
        error.name = "ParameterNotFound";
        throw error;
      }
      return { Version: 1 };
    });

    await expect(provisionBackupAuthKeyring(send, "initial-2026-09")).resolves.toBe("created");
    const put = send.mock.calls.map(([command]) => command).find((command) => command instanceof PutParameterCommand);
    expect(put?.input).toMatchObject({
      Name: BACKUP_AUTH_KEYRING_PARAMETER,
      Type: "SecureString",
      Overwrite: false,
    });
    expect(parseBackupAuthKeyring(String(put?.input.Value)).currentKeyId).toBe("initial-2026-09");
  });

  it("does not decrypt or retrieve an existing keyring during ordinary deployment provisioning", async () => {
    const send = vi.fn(async (command: GetParameterCommand | PutParameterCommand) => {
      if (command instanceof PutParameterCommand)
        throw Object.assign(new Error("exists"), { name: "ParameterAlreadyExists" });
      return { Parameter: { Type: "SecureString", Value: JSON.stringify(createBackupAuthKeyring("existing")) } };
    });

    await expect(provisionBackupAuthKeyring(send, "unused-new-key")).resolves.toBe("existing");

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ Name: BACKUP_AUTH_KEYRING_PARAMETER }) })
    );
  });

  it("keeps the previous key verify-only and makes only the new key active", () => {
    const current = createBackupAuthKeyring("key-old", Buffer.alloc(32, 1));
    const rotated = rotateBackupAuthKeyring(current, "key-new", Buffer.alloc(32, 2));

    expect(rotated).toMatchObject({ currentKeyId: "key-new" });
    expect(rotated.keys).toEqual([
      expect.objectContaining({ keyId: "key-new", status: "active" }),
      expect.objectContaining({ keyId: "key-old", status: "verify-only" }),
    ]);
  });

  it("reads with decryption and writes the complete rotated keyring as SecureString", async () => {
    const current = createBackupAuthKeyring("key-old", Buffer.alloc(32, 1));
    let keyringVersion = 3;
    const send = vi.fn(async (command: GetParameterCommand | PutParameterCommand) => {
      if (command instanceof GetParameterCommand) {
        return { Parameter: { Type: "SecureString", Value: JSON.stringify(current), Version: keyringVersion } };
      }
      if (command instanceof PutParameterCommand && command.input.Name === BACKUP_AUTH_KEYRING_PARAMETER) {
        keyringVersion += 1;
        return { Version: keyringVersion };
      }
      return { Version: 2 };
    });

    await rotateStoredBackupAuthKeyring(send, "key-new");

    const keyringRead = send.mock.calls.find(
      ([command]) => command instanceof GetParameterCommand && command.input.Name === BACKUP_AUTH_KEYRING_PARAMETER
    )?.[0];
    expect(keyringRead?.input).toEqual({ Name: BACKUP_AUTH_KEYRING_PARAMETER, WithDecryption: true });
    const put = send.mock.calls.find(
      ([command]) => command instanceof PutParameterCommand && command.input.Name === BACKUP_AUTH_KEYRING_PARAMETER
    )?.[0] as PutParameterCommand;
    expect(put.input).toMatchObject({ Name: BACKUP_AUTH_KEYRING_PARAMETER, Type: "SecureString", Overwrite: true });
    expect(parseBackupAuthKeyring(String(put.input.Value)).keys.map((key) => key.status)).toEqual([
      "active",
      "verify-only",
    ]);
  });

  it("rejects unknown fields, duplicate keys, malformed material, and a second active key", () => {
    const valid = createBackupAuthKeyring("key-old", Buffer.alloc(32, 1));
    expect(() => parseBackupAuthKeyring(JSON.stringify({ ...valid, extra: true }))).toThrow(/schema/);
    expect(() =>
      parseBackupAuthKeyring(
        JSON.stringify(valid).replace('"schemaVersion":1,', '"schemaVersion":1,"schemaVersion":1,')
      )
    ).toThrow(/canonical/);
    expect(() => parseBackupAuthKeyring(JSON.stringify({ ...valid, keys: [...valid.keys, valid.keys[0]] }))).toThrow(
      /entry/
    );
    expect(() =>
      parseBackupAuthKeyring(JSON.stringify({ ...valid, keys: [{ ...valid.keys[0], secretBase64: "bad" }] }))
    ).toThrow(/material/);
    expect(() =>
      parseBackupAuthKeyring(
        JSON.stringify({
          ...valid,
          keys: [
            ...valid.keys,
            { keyId: "key-new", secretBase64: Buffer.alloc(32, 2).toString("base64"), status: "active" },
          ],
        })
      )
    ).toThrow(/one matching active/);
  });
});
