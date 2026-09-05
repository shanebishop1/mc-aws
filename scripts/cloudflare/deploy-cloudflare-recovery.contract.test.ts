import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Cloudflare deployment recovery contract", () => {
  const source = readFileSync(path.resolve(process.cwd(), "scripts/cloudflare/deploy-cloudflare.sh"), "utf8");

  it("records all recoverable identities before the first provider mutation", () => {
    const routeInventory = source.lastIndexOf("capture_panel_route_before_deploy\n");
    const dnsInventory = source.lastIndexOf("capture_panel_dns_before_deploy\n");
    const workerInventory = source.lastIndexOf("capture_worker_bindings_and_secrets\n");
    const runtimeInventory = source.lastIndexOf("capture_runtime_key_identity\n");
    const durableRecord = source.lastIndexOf("write_recovery_record\n");
    const firstMutation = source.lastIndexOf("ensure_runtime_state_kv_namespace_ids\n");

    for (const inventory of [routeInventory, dnsInventory, workerInventory, runtimeInventory]) {
      expect(inventory).toBeGreaterThan(-1);
      expect(inventory).toBeLessThan(durableRecord);
    }
    expect(durableRecord).toBeLessThan(firstMutation);
    expect(source).toContain("fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\\n`, { mode: 0o600");
    expect(source).toContain("Cloudflare secret values are write-only");
  });

  it("refuses unsupported pre-existing route replacement before any mutation", () => {
    const refusal = source.indexOf("Refusing unsupported pre-existing route replacement before any provider mutation");
    const durableRecord = source.lastIndexOf("write_recovery_record\n");
    const dnsMutation = source.lastIndexOf("ensure_panel_dns\n");
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(durableRecord);
    expect(durableRecord).toBeLessThan(dnsMutation);
  });

  it("detects an active record on the next run and restores supported provider state", () => {
    expect(source).toContain("recover_pending_deployment");
    expect(source).toContain('wrangler versions deploy "${version_specs[@]}"');
    expect(source).toContain('wrangler delete "$WORKER_NAME" --config /dev/null --force');
    expect(source).toContain('cf_api DELETE "/zones/${CF_ZONE_ID}/workers/routes/${route_id}"');
    expect(source).toContain('cf_api PATCH "/zones/${CF_ZONE_ID}/dns_records/${record_id}"');
    expect(source).toContain('finalize_recovery_record "rolled_back"');
  });

  it("verifies secret/binding inventory and runtime identity before finalizing", () => {
    const secretBindingVerification = source.lastIndexOf("verify_deployed_secret_and_binding_inventory");
    const runtimeVerification = source.lastIndexOf("run_runtime_rotation finalize");
    const finalized = source.lastIndexOf('finalize_recovery_record "succeeded"');
    expect(secretBindingVerification).toBeGreaterThan(-1);
    expect(runtimeVerification).toBeGreaterThan(secretBindingVerification);
    expect(finalized).toBeGreaterThan(runtimeVerification);
    expect(source).toContain("Every previously valid runtime IAM key remains available for rollback.");
  });

  it.each([
    "preflight-recorded",
    "kv-mutation",
    "dns-mutation",
    "worker-mutation",
    "worker-deployed",
    "route-verified",
    "secrets-mutated",
    "bindings-verified",
    "runtime-key-verification",
    "runtime-key-prepared",
    "commit-decided",
    "runtime-key-finalized",
  ])("provides a rollback-triggering failure injection point for %s", (stage) => {
    expect(source).toContain(`deployment_stage ${stage} || exit 1`);
    expect(source).toContain('if [[ "${MC_AWS_DEPLOY_FAIL_STAGE:-}" == "$CURRENT_DEPLOYMENT_STAGE" ]]');
    expect(source).toContain("recover_after_deploy_failure || {");
  });

  it("recovers backward before commit and resumes forward cleanup after commit", () => {
    expect(source).toContain('update_recovery_progress "$CURRENT_DEPLOYMENT_STAGE" commit');
    expect(source).toContain('if [[ "$decision" == "commit" ]]');
    expect(source).toContain("recover_after_deploy_failure || {");
    expect(source).toContain("run_runtime_rotation finalize");
    expect(source).toContain("run_runtime_rotation rollback");
    expect(source).not.toContain("reactivate recorded runtime key");
    expect(source.indexOf("recover_pending_deployment")).toBeLessThan(
      source.lastIndexOf("PREFLIGHT_SECRET_ENTRIES_OUTPUT")
    );
  });

  it("bounds interrupted local build scratch files to fixed recoverable slots", () => {
    expect(source).toContain('NEXT_BUILD_ENV_BACKUP_FILE="${NEXT_BUILD_ENV_FILE}.mc-aws-backup"');
    expect(source).toContain('NEXT_BUILD_ENV_MARKER_FILE="${NEXT_BUILD_ENV_FILE}.mc-aws-generated"');
    expect(source).toContain("recover_interrupted_next_build_env_file");
    expect(source).toContain('WRANGLER_DEPLOY_CONFIG_FILE=".wrangler.deploy.jsonc"');
    expect(source).not.toContain('mktemp "${NEXT_BUILD_ENV_FILE}.backup.XXXXXX"');
    expect(source).not.toContain('mktemp "wrangler.deploy.XXXXXX.jsonc"');
  });

  it("excludes concurrent deploys before recovering fixed local or provider state", () => {
    const lock = source.indexOf("acquire_deployment_lock || exit 1");
    const localRecovery = source.indexOf("recover_interrupted_next_build_env_file", lock);
    const providerRecovery = source.lastIndexOf("recover_pending_deployment");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(localRecovery);
    expect(lock).toBeLessThan(providerRecovery);
    expect(source).toContain('kill -0 "$owner_pid"');
    expect(source).toContain('ln -s "/proc/$$" "$DEPLOY_LOCK_DIR"');
    expect(source).toContain('readlink "$DEPLOY_LOCK_DIR"');
    expect(source).toContain('owner_pid="${owner_target#/proc/}"');
    expect(source).toContain("A stale Cloudflare deployment lock remains");
    expect(source).toContain("release_deployment_lock");
  });

  it("accepts the AWS CLI's empty successful response for an absent lifecycle row", () => {
    expect(source).toContain('const item=input ? JSON.parse(input).Item : undefined;');
  });
});
