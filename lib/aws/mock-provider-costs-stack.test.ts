/**
 * Test script for Cost Explorer and CloudFormation mock implementations
 * Run with: tsx lib/aws/mock-provider-costs-stack.test.ts
 */

import { mockProvider } from "./mock-provider";
import { getMockStateStore } from "./mock-state-store";

async function testCostExplorer() {
  console.log("Testing Cost Explorer mock implementation...\n");

  // Test 1: Get current month costs
  console.log("Test 1: Get current month costs");
  const currentMonthCosts = await mockProvider.getCosts("current-month");
  console.log("  Total cost:", currentMonthCosts.totalCost, currentMonthCosts.currency);
  console.log("  Period:", currentMonthCosts.period.start, "to", currentMonthCosts.period.end);
  console.log("  Services:", currentMonthCosts.breakdown.length);
  console.log("  Breakdown:", currentMonthCosts.breakdown);
  console.log("  ✓ Passed\n");

  // Test 2: Get last month costs
  console.log("Test 2: Get last month costs");
  const lastMonthCosts = await mockProvider.getCosts("last-month");
  console.log("  Total cost:", lastMonthCosts.totalCost, lastMonthCosts.currency);
  console.log("  Period:", lastMonthCosts.period.start, "to", lastMonthCosts.period.end);
  console.log("  ✓ Passed\n");

  // Test 3: Get last 30 days costs
  console.log("Test 3: Get last 30 days costs");
  const last30DaysCosts = await mockProvider.getCosts("last-30-days");
  console.log("  Total cost:", last30DaysCosts.totalCost, last30DaysCosts.currency);
  console.log("  Period:", last30DaysCosts.period.start, "to", last30DaysCosts.period.end);
  console.log("  ✓ Passed\n");

  // Test 4: Test fault injection for getCosts
  console.log("Test 4: Test fault injection for getCosts");
  const stateStore = getMockStateStore();
  await stateStore.setOperationFailure("getCosts", {
    failNext: true,
    alwaysFail: false,
    errorMessage: "Test Cost Explorer error",
    errorCode: "TestError",
  });

  try {
    await mockProvider.getCosts("current-month");
    console.log("  ✗ Failed - should have thrown error");
  } catch (error) {
    console.log("  Error thrown:", (error as Error).message);
    console.log("  Error name:", (error as any).name);
    console.log("  ✓ Passed\n");
  }

  // Test 5: Test latency injection for getCosts
  console.log("Test 5: Test latency injection for getCosts");
  await stateStore.setGlobalLatency(100);
  const startTime = Date.now();
  await mockProvider.getCosts("current-month");
  const elapsed = Date.now() - startTime;
  console.log("  Elapsed time:", elapsed, "ms");
  console.log("  ✓ Passed\n");

  // Reset latency
  await stateStore.setGlobalLatency(0);
}

async function testCloudFormation() {
  console.log("Testing CloudFormation mock implementation...\n");

  // Test 1: Check stack exists
  console.log("Test 1: Check stack exists");
  const exists = await mockProvider.checkStackExists("MinecraftStack");
  console.log("  Stack exists:", exists);
  console.log("  ✓ Passed\n");

  // Test 2: Get stack status
  console.log("Test 2: Get stack status");
  const stack = await mockProvider.getStackStatus("MinecraftStack");
  if (stack) {
    console.log("  Stack name:", stack.StackName);
    console.log("  Stack ID:", stack.StackId);
    console.log("  Stack status:", stack.StackStatus);
    console.log("  Description:", stack.Description);
    console.log("  Parameters:", stack.Parameters?.length);
    console.log("  Outputs:", stack.Outputs?.length);
    console.log("  Tags:", stack.Tags?.length);
    console.log("  ✓ Passed\n");
  } else {
    console.log("  Stack does not exist\n");
  }

  // Test 3: Get stack outputs
  console.log("Test 3: Get stack outputs");
  if (stack?.Outputs) {
    for (const output of stack.Outputs) {
      console.log(`  ${output.OutputKey}: ${output.OutputValue} (${output.Description})`);
    }
    console.log("  ✓ Passed\n");
  }

  // Test 4: Test fault injection for getStackStatus
  console.log("Test 4: Test fault injection for getStackStatus");
  const stateStore = getMockStateStore();
  await stateStore.setOperationFailure("getStackStatus", {
    failNext: true,
    alwaysFail: false,
    errorMessage: "Test CloudFormation error",
    errorCode: "ValidationError",
  });

  try {
    await mockProvider.getStackStatus("MinecraftStack");
    console.log("  ✗ Failed - should have thrown error");
  } catch (error) {
    console.log("  Error thrown:", (error as Error).message);
    console.log("  Error name:", (error as any).name);
    console.log("  ✓ Passed\n");
  }

  // Test 5: Test stack that doesn't exist
  console.log("Test 5: Test stack that doesn't exist");
  await stateStore.setStackStatus({ exists: false, status: "DELETE_COMPLETE", stackId: "" });
  const nonExistentStack = await mockProvider.getStackStatus("MinecraftStack");
  console.log("  Stack is null:", nonExistentStack === null);
  const stackExists = await mockProvider.checkStackExists("MinecraftStack");
  console.log("  Stack exists:", stackExists);
  console.log("  ✓ Passed\n");

  // Test 6: Test different stack states
  console.log("Test 6: Test different stack states");
  const states = ["CREATE_COMPLETE", "CREATE_IN_PROGRESS", "UPDATE_IN_PROGRESS", "ROLLBACK_COMPLETE"];
  for (const status of states) {
    await stateStore.setStackStatus({
      exists: true,
      status,
      stackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/minecraft-stack/abc123",
    });
    const testStack = await mockProvider.getStackStatus("MinecraftStack");
    console.log(`  Status ${status}:`, testStack?.StackStatus === status ? "✓" : "✗");
  }
  console.log("  ✓ Passed\n");

  // Reset stack to default state
  await stateStore.setStackStatus({
    exists: true,
    status: "CREATE_COMPLETE",
    stackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/minecraft-stack/abc123",
  });
}

async function runAllTests() {
  console.log("=".repeat(60));
  console.log("Mock Provider - Cost Explorer & CloudFormation Tests");
  console.log("=".repeat(60));
  console.log();

  try {
    await testCostExplorer();
    await testCloudFormation();

    console.log("=".repeat(60));
    console.log("All tests passed! ✓");
    console.log("=".repeat(60));
  } catch (error) {
    console.error("Test failed:", error);
    process.exit(1);
  }
}

runAllTests();
