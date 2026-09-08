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
    expect(source).toContain("durableReplaceFile(path, `${JSON.stringify(record, null, 2)}\\n`)");
    expect(source).toContain('RECOVERY_STATE_DIRECTORY="${MC_AWS_CLOUDFLARE_RECOVERY_STATE_DIRECTORY:-.mc-aws-state}"');
    expect(source).toContain("durableRenameFile");
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

  it("journals publicly reconcilable create identities before POST and never recreates routes in recovery", () => {
    const dnsJournal = source.indexOf('journal_creation_intent dns "$operation_id"');
    const dnsPost = source.indexOf('cf_api POST "/zones/${CF_ZONE_ID}/dns_records"');
    const routeJournal = source.indexOf('journal_creation_intent route "$operation_id"');
    const routePost = source.indexOf('cf_api POST "/zones/${CF_ZONE_ID}/workers/routes"');
    expect(dnsJournal).toBeGreaterThan(-1);
    expect(dnsJournal).toBeLessThan(dnsPost);
    expect(routeJournal).toBeGreaterThan(-1);
    expect(routeJournal).toBeLessThan(routePost);
    expect(source).toContain("mc-aws-dns-operation:${operation_id}");
    const routeRecovery = source.slice(
      source.indexOf("restore_recorded_routes()"),
      source.indexOf("restore_recorded_dns()")
    );
    expect(routeRecovery).not.toContain('cf_api POST "/zones/${CF_ZONE_ID}/workers/routes"');
    expect(routeRecovery).toContain(
      "No durable route-create intent exists; this transaction deterministically created no route"
    );
  });

  it("attaches final evidence only to the transaction-journaled active Worker version", () => {
    expect(source).toContain("worker-version-evidence");
    expect(source).toContain("cloudflare.applied.workerVersionId");
    expect(source).toContain("cloudflare.applied.workerScriptEtag");
    expect(source).toContain("Active Worker changed after the transaction journaled its final version");
    expect(source).toContain("--artifact-merkle-sha256");
    expect(source).toContain("--script-etag");
    const finalizationHelper = source.slice(
      source.indexOf("finalize_runtime_rotation_and_attest()"),
      source.indexOf("assert_lifecycle_recovery_unblocked()")
    );
    const finalRotation = finalizationHelper.indexOf("run_runtime_rotation finalize");
    const finalObservation = finalizationHelper.indexOf("record_worker_deployment_identity ||", finalRotation);
    const attestation = finalizationHelper.indexOf("record_worker_deployment_identity true", finalObservation);
    expect(finalObservation).toBeGreaterThan(finalRotation);
    expect(attestation).toBeGreaterThan(finalObservation);
    expect(source).toContain("final_deployments_json");
    expect(source).toContain("final_receipt");
    expect(source).toContain("refusing manifest update");
  });

  it("stages, scans, hashes, seals, and deploys the immutable Wrangler tree", () => {
    const stage = source.indexOf("stage-worker-assets");
    const scan = source.indexOf("scan-artifacts", stage);
    const seal = source.indexOf("seal-worker-upload", scan);
    const deployConfig = source.indexOf(
      'WRANGLER_DEPLOY_CONFIG_FILE="$WRANGLER_UPLOAD_FINAL_DIR/wrangler.jsonc"',
      seal
    );
    const deploy = source.indexOf('wrangler "${WRANGLER_DEPLOY_ARGS[@]}"', deployConfig);
    expect(stage).toBeGreaterThan(-1);
    expect(scan).toBeGreaterThan(stage);
    expect(seal).toBeGreaterThan(scan);
    expect(deployConfig).toBeGreaterThan(seal);
    expect(deploy).toBeGreaterThan(deployConfig);
    expect(source).toContain('--path "$WRANGLER_UPLOAD_FINAL_DIR/artifact"');
    expect(source).toContain("stage-final-worker-upload");
    expect(source).toContain("immutable Wrangler upload stage");
    const sealedRehash = source.indexOf("verify_sealed_worker_upload", seal);
    const providerUpload = source.indexOf('wrangler "${WRANGLER_DEPLOY_ARGS[@]}"', sealedRehash);
    const uploadedRehash = source.indexOf("verify_sealed_worker_upload", providerUpload);
    expect(sealedRehash).toBeGreaterThan(seal);
    expect(providerUpload).toBeGreaterThan(sealedRehash);
    expect(uploadedRehash).toBeGreaterThan(providerUpload);
  });

  it("CAS-checks transaction deployment B before restoring baseline A and refuses concurrent C", () => {
    const rollback = source.slice(
      source.indexOf("rollback_from_recovery_record()"),
      source.indexOf("recover_pending_deployment()")
    );
    const statusRead = rollback.indexOf('deployments status --name "$WORKER_NAME" --json');
    const cas = rollback.indexOf("worker-rollback-decision", statusRead);
    const restore = rollback.indexOf('wrangler versions deploy "${version_specs[@]}"', cas);
    expect(statusRead).toBeGreaterThan(-1);
    expect(cas).toBeGreaterThan(statusRead);
    expect(restore).toBeGreaterThan(cas);
    expect(rollback).toContain("refusing to overwrite concurrent deployment C");
  });

  it("treats missing create intent as deterministic no-create evidence", () => {
    expect(source).toContain(
      "No durable route-create intent exists; this transaction deterministically created no route"
    );
    expect(source).toContain(
      "No durable DNS-create intent exists; this transaction deterministically created no DNS record"
    );
  });

  it("verifies secret/binding inventory and runtime identity before finalizing", () => {
    const secretBindingVerification = source.lastIndexOf("verify_deployed_secret_and_binding_inventory");
    const runtimeVerification = source.lastIndexOf("finalize_runtime_rotation_and_attest");
    const finalized = source.lastIndexOf('finalize_recovery_record "succeeded"');
    expect(secretBindingVerification).toBeGreaterThan(-1);
    expect(runtimeVerification).toBeGreaterThan(secretBindingVerification);
    expect(finalized).toBeGreaterThan(runtimeVerification);
    expect(source).toContain("Every previously valid runtime IAM key remains available for rollback.");
  });

  it("records applied DNS TTL separately from the original pre-proxy TTL", () => {
    expect(source).toContain("dns-observe");
    expect(source).toContain("--original-ttl");
    expect(source).toContain("record_ttl record_proxied");
    expect(source).toContain('original: parse("RECOVERY_DNS_JSON")');
    expect(source).toContain("applied: null");
    expect(source).toContain("mutationIntent: null");
    expect(source).toContain("record_dns_mutation_intent");
    expect(source).toContain("record_dns_applied");
    expect(source).toContain('cf_api PUT "/zones/${CF_ZONE_ID}/dns_records/${record_id}"');
  });

  it("journals DNS intent before PATCH and only journals applied identity after canonical provider observation", () => {
    const dnsMutation = source.slice(source.indexOf("ensure_panel_dns()"), source.indexOf("cf_parse_worker_route()"));
    const intent = dnsMutation.indexOf("record_dns_mutation_intent");
    const patch = dnsMutation.indexOf('cf_api PATCH "/zones/${CF_ZONE_ID}/dns_records/${record_id}"');
    const observed = dnsMutation.indexOf("dns-observe", patch);
    const applied = dnsMutation.indexOf('record_dns_applied "$applied_json"', observed);
    expect(intent).toBeGreaterThan(-1);
    expect(intent).toBeLessThan(patch);
    expect(observed).toBeGreaterThan(patch);
    expect(applied).toBeGreaterThan(observed);
  });

  it("hard-stops intent-only DNS journals after PATCH response loss", () => {
    const recovery = source.slice(
      source.indexOf("restore_recorded_dns()"),
      source.indexOf("rollback_from_recovery_record()")
    );
    expect(recovery).toContain("mutation intent has no observed applied identity");
    expect(recovery).toContain("requiring reconciliation");
    expect(recovery).toContain("Applied DNS identity is not the exact journaled TTL/proxy state");
  });

  it.each([
    "preflight-recorded",
    "kv-mutation",
    "dns-mutation",
    "worker-mutation",
    "worker-deployed",
    "route-verified",
    "secrets-mutation",
    "secrets-mutated",
    "bindings-mutation",
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
      source.lastIndexOf("PREFLIGHT_SECRET_NAMES_OUTPUT")
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
    expect(source).toContain('ln -s "$$" "$DEPLOY_LOCK_DIR"');
    expect(source).toContain('readlink "$DEPLOY_LOCK_DIR"');
    expect(source).toContain("A stale Cloudflare deployment lock remains");
    expect(source).toContain("release_deployment_lock");
  });

  it("opens an immutable dotenv snapshot before any provider mutation", () => {
    const snapshot = source.indexOf("open_deployment_env_snapshot\nfi\nrecover_pending_deployment");
    const firstProviderMutation = source.lastIndexOf("ensure_runtime_state_kv_namespace_ids\n");
    expect(snapshot).toBeGreaterThan(-1);
    expect(snapshot).toBeLessThan(firstProviderMutation);
    expect(source).toContain('DEPLOY_ENV_SOURCE="/proc/self/fd/$DEPLOY_ENV_FD"');
    expect(source).toContain('RUNTIME_STATE_SNAPSHOT_KV_ID="$runtime_state_snapshot_kv_id"');
    expect(source.indexOf("pnpm clean:build")).toBeLessThan(firstProviderMutation);
    expect(source.indexOf("Next.js route-import build passed before provider mutation")).toBeLessThan(
      firstProviderMutation
    );
    expect(source).toContain("next-build-isolation.ts stage");
    expect(source).toContain("next-build-isolation.ts recover");
    const isolatedBuildWrapper = source.slice(
      source.indexOf("run_isolated_build_child()"),
      source.indexOf("cleanup_deploy_artifacts()")
    );
    const closeFd = isolatedBuildWrapper.indexOf("exec {DEPLOY_ENV_FD}<&-");
    expect(closeFd).toBeGreaterThan(-1);
    expect(closeFd).toBeLessThan(isolatedBuildWrapper.indexOf("build-child-isolation-cli.ts run"));
    expect(source).toContain('run_isolated_build_child "$TMPDIR" -- pnpm clean:build');
  });

  it("consults the durable recovery journal before mutable dotenv", () => {
    const recoveryBranch = source.indexOf('if [[ "$RECOVERY_PENDING_EARLY" == "1" ]]');
    const journalRead = source.indexOf("EARLY_RECOVERY_CONTEXT=", recoveryBranch);
    const dotenvSnapshot = source.indexOf("open_deployment_env_snapshot false", journalRead);
    expect(recoveryBranch).toBeGreaterThan(-1);
    expect(journalRead).toBeGreaterThan(recoveryBranch);
    expect(dotenvSnapshot).toBeGreaterThan(journalRead);
    expect(source).not.toContain("$NODE_BIN");
  });

  it("uses the immutable snapshot for post-mutation secret and config reads", () => {
    const mutation = source.lastIndexOf("ensure_runtime_state_kv_namespace_ids\n");
    const upload = source.indexOf("put_secret_from_selected_env()", mutation);
    expect(upload).toBeGreaterThan(mutation);
    expect(source.slice(upload)).toContain('--env-fd "$DEPLOY_ENV_FD"');
    expect(source.slice(upload)).toContain('worker-secret-names --env-fd "$DEPLOY_ENV_FD"');
    expect(source.slice(upload)).toContain('get_env_value "MC_CONNECTION_MODE"');
    expect(source.slice(upload)).not.toContain('worker-secret-value \\\n      --env-file "$ENV_FILE"');
  });
});
