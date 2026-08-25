import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Cloudflare legacy secret pruning deployment contract", () => {
  const source = readFileSync(path.resolve(process.cwd(), "scripts/deploy-cloudflare.sh"), "utf8");

  const helperBody = (name: string): string => {
    const match = source.match(new RegExp(`${name}\\(\\) \\{([\\s\\S]*?)\\n\\}`));
    expect(match, `missing shell helper: ${name}`).not.toBeNull();
    return match?.[1] ?? "";
  };

  it("uses one Wrangler v4 bulk merge patch based on the live inventory", () => {
    expect(source).toContain('wrangler secret list --config "$WRANGLER_DEPLOY_CONFIG_FILE"');
    expect(source).toContain("legacy-worker-secret-policy.ts merge-patch");
    expect(source).toContain('wrangler secret bulk --config "$WRANGLER_DEPLOY_CONFIG_FILE"');
    expect(source).not.toContain("wrangler secret delete --config");
    expect(source).toContain('if [[ "$LEGACY_SECRET_DELETION_PATCH" == "{}" ]]');
  });

  it("prunes only after approved uploads and before binding restoration and runtime rotation", () => {
    const approvedUploadComplete = source.indexOf('echo "✅ Secrets uploaded ($SECRET_COUNT secrets)"');
    const prune = source.indexOf('echo "🧹 Pruning explicitly obsolete Worker secrets..."');
    const bindingRestore = source.indexOf('echo "🔁 Restoring non-secret Worker bindings after secret upload..."');
    const runtimeRotation = source.indexOf(
      'echo "🔐 Provisioning dedicated least-privilege AWS runtime credentials..."'
    );

    expect(approvedUploadComplete).toBeGreaterThan(-1);
    expect(prune).toBeGreaterThan(approvedUploadComplete);
    expect(bindingRestore).toBeGreaterThan(prune);
    expect(runtimeRotation).toBeGreaterThan(bindingRestore);
  });

  it.each([
    ["put_secret", "wrangler secret put"],
    ["put_secret_base64", "wrangler secret put"],
    ["prune_obsolete_worker_secrets_bulk", "wrangler secret bulk"],
  ])("does not let successful identity recording mask a failed mutation in %s", (helperName, mutationCommand) => {
    const body = helperBody(helperName);
    const mutation = body.indexOf(mutationCommand);
    const failurePropagation = body.indexOf("|| return 1", mutation);
    const identityRecording = body.indexOf("record_worker_deployment_identity");

    expect(mutation).toBeGreaterThan(-1);
    expect(failurePropagation).toBeGreaterThan(mutation);
    expect(identityRecording).toBeGreaterThan(failurePropagation);
  });
});
