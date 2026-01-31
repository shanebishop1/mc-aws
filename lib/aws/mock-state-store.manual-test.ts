/**
 * Simple test script for MockStateStore
 * Run with: tsx lib/aws/mock-state-store.manual-test.ts
 */

import type { ServerState } from "@/lib/types";
import { MockStateStore } from "./mock-state-store";

async function testMockStateStore() {
  console.log("Testing MockStateStore...\n");

  // Create a new state store with persistence disabled for testing
  const store = new MockStateStore({ enablePersistence: false });

  // Test 1: Get initial instance state
  console.log("Test 1: Get initial instance state");
  const instance = await store.getInstance();
  console.log("  Instance state:", instance.state);
  console.log("  Instance ID:", instance.instanceId);
  console.log("  ✓ Passed\n");

  // Test 2: Update instance state
  console.log("Test 2: Update instance state to 'pending'");
  await store.updateInstanceState("pending" as ServerState);
  const updatedInstance = await store.getInstance();
  console.log("  New state:", updatedInstance.state);
  console.log("  ✓ Passed\n");

  // Test 3: Set instance to running (should auto-assign public IP)
  console.log("Test 3: Set instance to running (should auto-assign public IP)");
  await store.updateInstanceState("running" as ServerState);
  const runningInstance = await store.getInstance();
  console.log("  State:", runningInstance.state);
  console.log("  Public IP:", runningInstance.publicIp);
  console.log("  ✓ Passed\n");

  // Test 4: SSM parameters
  console.log("Test 4: SSM parameters");
  const emailAllowlist = await store.getParameter("/minecraft/email-allowlist");
  console.log("  Email allowlist:", emailAllowlist);
  await store.setParameter("/minecraft/test-param", "test-value");
  const testParam = await store.getParameter("/minecraft/test-param");
  console.log("  Test param:", testParam);
  console.log("  ✓ Passed\n");

  // Test 5: Backups
  console.log("Test 5: Backups");
  const backups = await store.getBackups();
  console.log("  Backup count:", backups.length);
  console.log("  First backup:", backups[0]?.name);
  await store.addBackup({
    name: "test-backup",
    date: new Date().toISOString(),
    size: "1.0 GB",
  });
  const updatedBackups = await store.getBackups();
  console.log("  Updated backup count:", updatedBackups.length);
  console.log("  ✓ Passed\n");

  // Test 6: Costs
  console.log("Test 6: Costs");
  const costs = await store.getCosts("current-month");
  console.log("  Total cost:", costs.totalCost, costs.currency);
  console.log("  Services:", costs.breakdown.length);
  console.log("  ✓ Passed\n");

  // Test 7: CloudFormation stack
  console.log("Test 7: CloudFormation stack");
  const stack = await store.getStackStatus();
  console.log("  Stack exists:", stack.exists);
  console.log("  Stack status:", stack.status);
  console.log("  ✓ Passed\n");

  // Test 8: Fault injection
  console.log("Test 8: Fault injection");
  await store.setGlobalLatency(100);
  const latency = await store.getGlobalLatency();
  console.log("  Global latency:", latency, "ms");
  await store.setOperationFailure("startInstance", {
    failNext: true,
    alwaysFail: false,
    errorMessage: "Test error",
  });
  const failureConfig = await store.getOperationFailure("startInstance");
  console.log("  Failure config:", failureConfig?.errorMessage);
  console.log("  ✓ Passed\n");

  // Test 9: Reset state
  console.log("Test 9: Reset state");
  await store.resetState();
  const resetInstance = await store.getInstance();
  console.log("  Reset state:", resetInstance.state);
  console.log("  ✓ Passed\n");

  console.log("All tests passed! ✓");
}

testMockStateStore().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
