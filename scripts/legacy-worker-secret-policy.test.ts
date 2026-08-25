import { describe, expect, it } from "vitest";
import {
  buildObsoleteWorkerSecretDeletionPatch,
  obsoleteWorkerSecretNames,
  parseWorkerSecretInventory,
} from "./legacy-worker-secret-policy";

describe("legacy Worker secret policy", () => {
  it("defines exactly the explicitly approved obsolete names", () => {
    expect(obsoleteWorkerSecretNames).toEqual([
      "CDK_DEFAULT_ACCOUNT",
      "CDK_DEFAULT_REGION",
      "GITHUB_USER",
      "GITHUB_REPO",
      "GITHUB_TOKEN",
      "KEY_PAIR_NAME",
      "VERIFIED_SENDER",
      "START_KEYWORD",
    ]);
  });

  it("builds one merge patch from only obsolete names present in inventory", () => {
    const inventory = parseWorkerSecretInventory(
      JSON.stringify([
        { name: "UNKNOWN_SECRET", type: "secret_text" },
        { name: "NOTIFICATION_EMAIL", type: "secret_text" },
        { name: "AUTH_SECRET", type: "secret_text" },
        { name: "AWS_ACCESS_KEY_ID", type: "secret_text" },
        { name: "AWS_SECRET_ACCESS_KEY", type: "secret_text" },
        { name: "AWS_SESSION_TOKEN", type: "secret_text" },
        { name: "MC_AWS_RUNTIME_CANDIDATE_ACCESS_KEY_ID", type: "secret_text" },
        { name: "MC_AWS_RUNTIME_CANDIDATE_SECRET_ACCESS_KEY", type: "secret_text" },
        { name: "MC_AWS_RUNTIME_CREDENTIAL_PROBE_TOKEN", type: "secret_text" },
        { name: "GITHUB_TOKEN", type: "secret_text" },
        { name: "VERIFIED_SENDER", type: "secret_text" },
      ])
    );

    expect(buildObsoleteWorkerSecretDeletionPatch(inventory)).toEqual({
      GITHUB_TOKEN: null,
      VERIFIED_SENDER: null,
    });
  });

  it("tolerates an inventory with no obsolete secrets", () => {
    expect(
      buildObsoleteWorkerSecretDeletionPatch(
        parseWorkerSecretInventory(JSON.stringify([{ name: "NOTIFICATION_EMAIL" }, { name: "ARBITRARY" }]))
      )
    ).toEqual({});
  });

  it("rejects malformed inventory instead of broadening deletion behavior", () => {
    expect(() => parseWorkerSecretInventory('{"GITHUB_TOKEN":"secret"}')).toThrow(
      "Worker secret inventory must be a JSON array with string names"
    );
    expect(() => parseWorkerSecretInventory('[{"name":null}]')).toThrow(
      "Worker secret inventory must be a JSON array with string names"
    );
  });
});
