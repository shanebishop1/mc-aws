import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());
const canonical = (value) =>
  JSON.stringify(value, (_key, child) => {
    if (!child || typeof child !== "object" || Array.isArray(child)) return child;
    return Object.fromEntries(Object.entries(child).sort(([left], [right]) => left.localeCompare(right)));
  });
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: class {
    send = send;
  },
  GetParameterCommand: class {
    input;
    kind = "ssm-get";
    constructor(input) {
      this.input = input;
    }
  },
  PutParameterCommand: class {
    input;
    kind = "ssm-put";
    constructor(input) {
      this.input = input;
    }
  },
  DeleteParameterCommand: class {
    input;
    kind = "ssm-delete";
    constructor(input) {
      this.input = input;
    }
  },
}));
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {
    send = send;
  },
  PutItemCommand: class {
    input;
    kind = "dynamodb-put-item";
    constructor(input) {
      this.input = input;
    }
  },
  UpdateItemCommand: class {
    input;
    kind = "dynamodb-update-item";
    constructor(input) {
      this.input = input;
    }
  },
}));
import { handler } from "./index.js";

describe("DNS SecureString adoption custom resource", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it("verifies type without decrypting or receiving a secret value", async () => {
    send.mockResolvedValue({ Parameter: { Type: "SecureString" } });
    const event = {
      RequestType: "Update",
      PhysicalResourceId: "old-physical-id",
      ResourceProperties: { ParameterName: "/minecraft/cloudflare-api-token" },
    };
    await expect(handler(event)).resolves.toEqual({ PhysicalResourceId: "old-physical-id" });
    expect(send.mock.calls[0][0].input).toEqual({
      Name: "/minecraft/cloudflare-api-token",
      WithDecryption: false,
    });
  });

  it("makes replacement/delete a non-destructive no-op", async () => {
    await expect(
      handler({
        RequestType: "Delete",
        PhysicalResourceId: "old-physical-id",
        OldResourceProperties: { ParameterName: "/minecraft/cloudflare-api-token" },
      })
    ).resolves.toEqual({ PhysicalResourceId: "old-physical-id" });
    expect(send).not.toHaveBeenCalled();
  });

  it("creates missing mutable state once without overwriting future runtime values", async () => {
    vi.stubEnv("MC_OPERATION_STATE_TABLE_NAME", "test-operation-state");
    let targetValue = null;
    let targetVersion = 0;
    let targetReads = 0;
    let claimOwner = "";
    let parameterPuts = 0;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this mock models the SSM lock and parameter state machine.
    send.mockImplementation(async (command) => {
      if (command.kind === "dynamodb-put-item") {
        if (claimOwner) throw Object.assign(new Error("claim exists"), { name: "ConditionalCheckFailedException" });
        claimOwner = command.input.Item.lockOwner.S;
        return {};
      }
      if (command.kind === "dynamodb-update-item") {
        expect(command.input.ExpressionAttributeValues[":owner"].S).toBe(claimOwner);
        claimOwner = "";
        return {};
      }
      if (command.kind === "ssm-get" && command.input.Name === "/minecraft/restore-generation-floor") {
        if (targetValue === null && targetReads++ < 2) throw { name: "ParameterNotFound" };
        if (targetValue === null) throw { name: "ParameterNotFound" };
        return { Parameter: { Type: "String", Value: targetValue, Version: targetVersion } };
      }
      if (command.kind === "ssm-put" && command.input.Name === "/minecraft/restore-generation-floor") {
        if (targetValue !== null) throw Object.assign(new Error("exists"), { name: "ParameterAlreadyExists" });
        targetValue = command.input.Value;
        targetVersion = 1;
        parameterPuts += 1;
        return { Version: targetVersion };
      }
      return {};
    });
    await expect(
      handler({
        RequestType: "Create",
        ResourceProperties: {
          ParameterName: "/minecraft/restore-generation-floor",
          ParameterType: "String",
          InitialValue: "UNINITIALIZED",
        },
      })
    ).resolves.toEqual({ PhysicalResourceId: "/minecraft/restore-generation-floor" });
    targetValue = "future-runtime-state";
    targetVersion = 2;
    await expect(
      handler({
        RequestType: "Update",
        ResourceProperties: {
          ParameterName: "/minecraft/restore-generation-floor",
          ParameterType: "String",
          InitialValue: "UNINITIALIZED",
        },
      })
    ).resolves.toEqual({ PhysicalResourceId: "/minecraft/restore-generation-floor" });
    const put = send.mock.calls.find(
      ([command]) => command.input.Name === "/minecraft/restore-generation-floor" && command.input.Value
    );
    expect(put?.[0].input).toEqual({
      Name: "/minecraft/restore-generation-floor",
      Type: "String",
      Value: "UNINITIALIZED",
      Overwrite: false,
    });
    expect(parameterPuts).toBe(1);
    expect(targetValue).toBe("future-runtime-state");
    const claim = send.mock.calls.find(([command]) => command.kind === "dynamodb-put-item")?.[0];
    expect(claim?.input).toMatchObject({
      TableName: "test-operation-state",
      Item: {
        operationId: { S: "mc-aws-backup-recovery-migration" },
        lockOwner: { S: expect.any(String) },
        leaseExpiresAt: { N: expect.any(String) },
      },
      ConditionExpression: "attribute_not_exists(operationId) OR leaseExpiresAt < :now",
    });
    expect(send.mock.calls.filter(([command]) => command.kind === "dynamodb-put-item")).toHaveLength(1);
  });

  it("rejects a migration claim conflict before creating missing retained state", async () => {
    vi.stubEnv("MC_OPERATION_STATE_TABLE_NAME", "test-operation-state");
    send.mockImplementation(async (command) => {
      if (command.kind === "dynamodb-put-item") {
        throw Object.assign(new Error("claim exists"), { name: "ConditionalCheckFailedException" });
      }
      if (command.kind === "ssm-get" && command.input.Name === "/minecraft/restore-generation-floor") {
        throw { name: "ParameterNotFound" };
      }
      return {};
    });
    await expect(
      handler({
        RequestType: "Create",
        ResourceProperties: {
          ParameterName: "/minecraft/restore-generation-floor",
          ParameterType: "String",
          InitialValue: "UNINITIALIZED",
        },
      })
    ).rejects.toThrow("MIGRATION_LOCK_BUSY");
    expect(send.mock.calls.some(([command]) => command.kind === "ssm-put")).toBe(false);
  });

  it("leaves an existing mutable state value untouched", async () => {
    send.mockResolvedValue({ Parameter: { Type: "String", Value: "authenticated-runtime-state" } });
    await handler({
      RequestType: "Update",
      ResourceProperties: {
        ParameterName: "/minecraft/backup-generation-checkpoint",
        ParameterType: "String",
        InitialValue: "UNINITIALIZED",
      },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("returns a fixed CloudFormation response without reflecting legacy secret properties", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    send.mockResolvedValue({ Parameter: { Type: "SecureString" } });
    const secretSentinel = "legacy-plaintext-token-sentinel";
    await handler(
      {
        RequestType: "Update",
        ResponseURL: "https://cloudformation-response.example.invalid",
        StackId: "stack-id",
        RequestId: "request-id",
        LogicalResourceId: "CloudflareTokenSecureParam",
        PhysicalResourceId: "old-physical-id",
        ResourceProperties: { ParameterName: "/minecraft/cloudflare-api-token" },
        OldResourceProperties: { Value: secretSentinel },
      },
      { logStreamName: "stream" }
    );
    const responseBody = fetchMock.mock.calls[0][1].body;
    expect(responseBody).not.toContain(secretSentinel);
    expect(JSON.parse(responseBody)).toMatchObject({ Status: "SUCCESS", NoEcho: true });
    vi.unstubAllGlobals();
  });

  it("verifies complete adopted keyring material, identity, verifier metadata, and monotonic floors", async () => {
    vi.stubEnv("MC_OPERATION_STATE_TABLE_NAME", "test-operation-state");
    const responseMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", responseMock);
    const keyring = JSON.stringify({
      currentKeyId: "key-old",
      keys: [{ keyId: "key-old", secretBase64: Buffer.alloc(32, 7).toString("base64"), status: "active" }],
      schemaVersion: 1,
    });
    const verifier = JSON.stringify({
      algorithm: "HMAC-SHA256",
      keyIds: ["key-old"],
      manifestFormat: "mc-aws-drive-backup",
      manifestSchemaVersion: 3,
      stateFormat: "mc-aws-backup-state",
      stateSchemaVersion: 3,
    });
    const stateDocument = (kind, generation, backupId) => {
      const payload = {
        format: "mc-aws-backup-state",
        schemaVersion: 3,
        source: { serverId: "arn:aws:cloudformation:us-west-1:111111111111:stack/MinecraftStack/stable-id" },
        state: { backupId, generation, kind, updatedAt: "2026-09-04T00:00:00Z" },
      };
      const tag = createHmac("sha256", Buffer.alloc(32, 7)).update(canonical(payload)).digest("hex");
      return canonical({ ...payload, authentication: { algorithm: "HMAC-SHA256", keyId: "key-old", tag } });
    };
    let verifierValue = "UNINITIALIZED";
    let verifierVersion = 1;
    let claimOwner = "";
    let recoveryClaimReads = 0;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this mock models the complete recovery SSM state machine.
    send.mockImplementation(async (command) => {
      if (command.kind === "dynamodb-put-item") {
        if (claimOwner) throw Object.assign(new Error("claim exists"), { name: "ConditionalCheckFailedException" });
        claimOwner = command.input.Item.lockOwner.S;
        return {};
      }
      if (command.kind === "dynamodb-update-item") {
        expect(command.input.ExpressionAttributeValues[":owner"].S).toBe(claimOwner);
        claimOwner = "";
        return {};
      }
      if (command.kind === "ssm-get" && command.input.Name === "/minecraft/backup-recovery-adoption-lock") {
        recoveryClaimReads += 1;
      }
      if (command.kind === "ssm-put" && command.input.Name === "/minecraft/backup-verifier-metadata") {
        verifierValue = command.input.Value;
        verifierVersion += 1;
        return { Version: verifierVersion };
      }
      const values = {
        "/minecraft/backup-recovery-adoption-lock": {
          Type: "String",
          Value: canonical({
            capsuleDigest: "c".repeat(64),
            checkpointGeneration: 7,
            floorGeneration: 5,
            format: "mc-aws-recovery-adoption-lock",
            keyIds: ["key-old"],
            schemaVersion: 3,
            scope: { account: "111111111111", region: "us-west-1", stack: "MinecraftStack" },
            serverId: "arn:aws:cloudformation:us-west-1:111111111111:stack/MinecraftStack/stable-id",
          }),
        },
        "/minecraft/backup-auth-keyring": { Type: "SecureString", Value: keyring },
        "/minecraft/backup-server-identity": {
          Type: "String",
          Value: "arn:aws:cloudformation:us-west-1:111111111111:stack/MinecraftStack/stable-id",
        },
        "/minecraft/backup-verifier-metadata": { Type: "String", Value: verifierValue },
        "/minecraft/backup-generation-checkpoint": {
          Type: "String",
          Value: stateDocument("backup-generation", 7, "7".repeat(32)),
        },
        "/minecraft/restore-generation-floor": {
          Type: "String",
          Value: stateDocument("restore-floor", 5, "5".repeat(32)),
        },
      };
      const value = values[command.input.Name];
      return {
        Parameter: value
          ? {
              ...value,
              ...(command.input.Name === "/minecraft/backup-verifier-metadata"
                ? { Version: verifierVersion }
                : { Version: 1 }),
            }
          : undefined,
      };
    });
    const event = {
      RequestType: "Update",
      ResponseURL: "https://cloudformation-response.example.invalid",
      StackId: "stack-id",
      RequestId: "request-id",
      LogicalResourceId: "BackupRecoveryCapsuleAdoption",
      PhysicalResourceId: "/minecraft/backup-auth-keyring",
      ResourceProperties: {
        ParameterName: "/minecraft/backup-auth-keyring",
        RecoveryCapsuleAdoption: "true",
        ExpectedServerIdentity: "arn:aws:cloudformation:us-west-1:111111111111:stack/MinecraftStack/stable-id",
        ExpectedKeyIds: ["key-old"],
        ExpectedKeyringSha256: createHash("sha256").update(keyring).digest("hex"),
        ExpectedVerifierSha256: createHash("sha256").update(verifier).digest("hex"),
        ExpectedVerifierMetadata: verifier,
        ExpectedCapsuleDigest: "c".repeat(64),
        ExpectedCheckpointGeneration: "7",
        ExpectedRestoreFloorGeneration: "5",
        ExpectedAccountId: "111111111111",
        ExpectedRegion: "us-west-1",
        ExpectedStackName: "MinecraftStack",
        RecoveryLockParameter: "/minecraft/backup-recovery-adoption-lock",
      },
    };
    // Both response attempts from the first invocation are lost. CloudFormation retries;
    // the second invocation must verify the same retained claim and state.
    await expect(handler(event)).rejects.toThrow("response lost");
    await expect(handler(event)).resolves.toEqual({ PhysicalResourceId: "/minecraft/backup-auth-keyring" });
    expect(responseMock).toHaveBeenCalledTimes(3);
    expect(recoveryClaimReads).toBeGreaterThanOrEqual(2);
    vi.unstubAllGlobals();
  });

  it("rejects recovery when the retained verifier version changes before its CAS write", async () => {
    vi.stubEnv("MC_OPERATION_STATE_TABLE_NAME", "test-operation-state");
    const keyring = JSON.stringify({
      currentKeyId: "key-old",
      keys: [{ keyId: "key-old", secretBase64: Buffer.alloc(32, 7).toString("base64"), status: "active" }],
      schemaVersion: 1,
    });
    const verifier = JSON.stringify({
      algorithm: "HMAC-SHA256",
      keyIds: ["key-old"],
      manifestFormat: "mc-aws-drive-backup",
      manifestSchemaVersion: 3,
      stateFormat: "mc-aws-backup-state",
      stateSchemaVersion: 3,
    });
    const serverIdentity = "arn:aws:cloudformation:us-west-1:111111111111:stack/MinecraftStack/stable-id";
    const recoveryLock = canonical({
      capsuleDigest: "c".repeat(64),
      checkpointGeneration: 0,
      floorGeneration: 0,
      format: "mc-aws-recovery-adoption-lock",
      keyIds: ["key-old"],
      schemaVersion: 3,
      scope: { account: "111111111111", region: "us-west-1", stack: "MinecraftStack" },
      serverId: serverIdentity,
    });
    let claimOwner = "";
    let verifierReads = 0;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this mock models the retained SSM CAS state machine.
    send.mockImplementation(async (command) => {
      if (command.kind === "dynamodb-put-item") {
        claimOwner = command.input.Item.lockOwner.S;
        return {};
      }
      if (command.kind === "dynamodb-update-item") {
        expect(command.input.ExpressionAttributeValues[":owner"].S).toBe(claimOwner);
        return {};
      }
      if (command.kind !== "ssm-get") return {};
      const values = {
        "/minecraft/backup-recovery-adoption-lock": { Type: "String", Value: recoveryLock, Version: 1 },
        "/minecraft/backup-auth-keyring": { Type: "SecureString", Value: keyring, Version: 1 },
        "/minecraft/backup-server-identity": { Type: "String", Value: serverIdentity, Version: 1 },
        "/minecraft/backup-generation-checkpoint": { Type: "String", Value: "UNINITIALIZED", Version: 1 },
        "/minecraft/restore-generation-floor": { Type: "String", Value: "UNINITIALIZED", Version: 1 },
      };
      if (command.input.Name === "/minecraft/backup-verifier-metadata") {
        verifierReads += 1;
        return {
          Parameter: { Type: "String", Value: "UNINITIALIZED", Version: verifierReads === 1 ? 1 : 2 },
        };
      }
      return { Parameter: values[command.input.Name] };
    });
    await expect(
      handler({
        RequestType: "Update",
        ResourceProperties: {
          ParameterName: "/minecraft/backup-auth-keyring",
          RecoveryCapsuleAdoption: "true",
          ExpectedServerIdentity: serverIdentity,
          ExpectedKeyIds: ["key-old"],
          ExpectedKeyringSha256: createHash("sha256").update(keyring).digest("hex"),
          ExpectedVerifierSha256: createHash("sha256").update(verifier).digest("hex"),
          ExpectedVerifierMetadata: verifier,
          ExpectedCapsuleDigest: "c".repeat(64),
          ExpectedCheckpointGeneration: "0",
          ExpectedRestoreFloorGeneration: "0",
          ExpectedAccountId: "111111111111",
          ExpectedRegion: "us-west-1",
          ExpectedStackName: "MinecraftStack",
        },
      })
    ).rejects.toThrow("RECOVERY_STATE_CHANGED_BEFORE_WRITE");
    expect(send.mock.calls.some(([command]) => command.kind === "ssm-put")).toBe(false);
  });

  it("rejects an external recovery lock conflict before reading recovery state", async () => {
    // Migration serialization is authoritative in DynamoDB; this seam only
    // models the retained recovery-lock conflict.
    send.mockImplementation(async () => {
      return { Parameter: { Type: "String", Value: "another-capsule", Version: 1 } };
    });
    await expect(
      handler({
        RequestType: "Update",
        ResourceProperties: {
          ParameterName: "/minecraft/backup-auth-keyring",
          RecoveryCapsuleAdoption: "true",
          RecoveryLockParameter: "/minecraft/backup-recovery-adoption-lock",
        },
      })
    ).rejects.toThrow("RECOVERY_LOCK_INVALID");
    expect(send.mock.calls.length).toBeGreaterThan(0);
  });

  it("atomically claims the stack ownership token and reconciles an idempotent retry", async () => {
    let claim = "";
    send.mockImplementation(async (command) => {
      if (command.input.Name !== "/minecraft/stack-ownership-claim") return {};
      if (command.input.Value) {
        if (claim) throw Object.assign(new Error("exists"), { name: "ParameterAlreadyExists" });
        claim = command.input.Value;
        return { Version: 1 };
      }
      if (!claim) throw Object.assign(new Error("missing"), { name: "ParameterNotFound" });
      return { Parameter: { Type: "String", Value: claim, Version: 1 } };
    });
    const event = {
      RequestType: "Create",
      ResourceProperties: {
        StackOwnershipClaim: "true",
        ClaimParameter: "/minecraft/stack-ownership-claim",
        ClaimToken: "11111111-2222-4333-8444-555555555555",
      },
    };
    await expect(handler(event)).resolves.toEqual({ PhysicalResourceId: "/minecraft/stack-ownership-claim" });
    await expect(handler(event)).resolves.toEqual({ PhysicalResourceId: "/minecraft/stack-ownership-claim" });
    expect(claim).toBe(event.ResourceProperties.ClaimToken);
    expect(send.mock.calls.some(([command]) => command.input.Overwrite === false)).toBe(true);
  });

  it("rejects a different stack ownership token instead of allowing a second owner", async () => {
    send.mockImplementation(async (command) => {
      if (command.input.Name === "/minecraft/stack-ownership-claim" && !command.input.Value) {
        return { Parameter: { Type: "String", Value: "22222222-3333-4444-8555-666666666666", Version: 1 } };
      }
      return {};
    });
    await expect(
      handler({
        RequestType: "Create",
        ResourceProperties: {
          StackOwnershipClaim: "true",
          ClaimParameter: "/minecraft/stack-ownership-claim",
          ClaimToken: "11111111-2222-4333-8444-555555555555",
        },
      })
    ).rejects.toThrow("STACK_CLAIM_CONFLICT");
  });
});
