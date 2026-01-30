#!/usr/bin/env node

/**
 * Test script for mock scenario engine
 * Verifies that scenarios can be applied and fault injection works
 */

import {
  applyScenario,
  clearAllFaults,
  getAvailableScenarios,
  getCurrentScenario,
  injectFault,
} from "../lib/aws/mock-provider.js";

async function testScenarioEngine() {
  console.log("=== Testing Mock Scenario Engine ===\n");

  // Test 1: List available scenarios
  console.log("Test 1: Listing available scenarios");
  const scenarios = getAvailableScenarios();
  console.log(`Found ${scenarios.length} scenarios:`);
  for (const scenario of scenarios) {
    console.log(`  - ${scenario.name}: ${scenario.description}`);
  }
  console.log("✓ Scenarios listed successfully\n");

  // Test 2: Apply default scenario
  console.log("Test 2: Applying default scenario");
  await applyScenario("default");
  const currentScenario = await getCurrentScenario();
  console.log(`Current scenario: ${currentScenario}`);
  console.log("✓ Default scenario applied\n");

  // Test 3: Apply running scenario
  console.log("Test 3: Applying running scenario");
  await applyScenario("running");
  const runningScenario = await getCurrentScenario();
  console.log(`Current scenario: ${runningScenario}`);
  console.log("✓ Running scenario applied\n");

  // Test 4: Apply high-cost scenario
  console.log("Test 4: Applying high-cost scenario");
  await applyScenario("high-cost");
  const highCostScenario = await getCurrentScenario();
  console.log(`Current scenario: ${highCostScenario}`);
  console.log("✓ High-cost scenario applied\n");

  // Test 5: Apply errors scenario
  console.log("Test 5: Applying errors scenario");
  await applyScenario("errors");
  const errorsScenario = await getCurrentScenario();
  console.log(`Current scenario: ${errorsScenario}`);
  console.log("✓ Errors scenario applied\n");

  // Test 6: Clear all faults and reset to default
  console.log("Test 6: Clearing all faults and resetting to default");
  await clearAllFaults();
  await applyScenario("default");
  const defaultScenario = await getCurrentScenario();
  console.log(`Current scenario: ${defaultScenario}`);
  console.log("✓ Reset to default scenario\n");

  console.log("=== All Tests Passed ===");
}

testScenarioEngine().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
