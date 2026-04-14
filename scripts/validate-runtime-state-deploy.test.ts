import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateRuntimeStateDeploySetup } from "./validate-runtime-state-deploy";

const createTempProject = (): string => {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-aws-runtime-state-"));
};

const withCwd = async (cwd: string, callback: () => void | Promise<void>): Promise<void> => {
  const previous = process.cwd();
  process.chdir(cwd);

  try {
    await callback();
  } finally {
    process.chdir(previous);
  }
};

describe("scripts/validate-runtime-state-deploy", () => {
  it("passes when wrangler runtime-state config can be resolved from env", async () => {
    const tempDir = createTempProject();

    fs.writeFileSync(
      path.join(tempDir, "wrangler.jsonc"),
      `${JSON.stringify(
        {
          durable_objects: {
            bindings: [
              {
                name: "RUNTIME_STATE_DURABLE_OBJECT",
                class_name: "RuntimeStateDurableObject",
              },
            ],
          },
          kv_namespaces: [
            {
              binding: "RUNTIME_STATE_SNAPSHOT_KV",
              id: "",
              preview_id: "",
            },
          ],
          migrations: [
            {
              tag: "v1-runtime-state-durable-object",
              new_sqlite_classes: ["RuntimeStateDurableObject"],
            },
          ],
        },
        null,
        2
      )}\n`
    );

    fs.writeFileSync(
      path.join(tempDir, ".env.production"),
      [
        "RUNTIME_STATE_SNAPSHOT_KV_ID=0123456789abcdef0123456789abcdef",
        "RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID=fedcba9876543210fedcba9876543210",
      ].join("\n")
    );

    await withCwd(tempDir, async () => {
      expect(() =>
        validateRuntimeStateDeploySetup({
          envFile: ".env.production",
          wranglerConfig: "wrangler.jsonc",
        })
      ).not.toThrow();
    });
  });

  it("fails with actionable errors when runtime-state config is incomplete", async () => {
    const tempDir = createTempProject();

    fs.writeFileSync(path.join(tempDir, "wrangler.jsonc"), `${JSON.stringify({ kv_namespaces: [] }, null, 2)}\n`);
    fs.writeFileSync(path.join(tempDir, ".env.production"), "RUNTIME_STATE_SNAPSHOT_KV_ID=your-runtime-state-kv-id\n");

    await withCwd(tempDir, async () => {
      expect(() =>
        validateRuntimeStateDeploySetup({
          envFile: ".env.production",
          wranglerConfig: "wrangler.jsonc",
        })
      ).toThrow("Runtime-state deploy setup is incomplete.");
    });
  });
});
