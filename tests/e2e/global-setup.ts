/**
 * Playwright global setup file
 * Resets mock state before all tests
 */

import { getMockStateStore, resetMockStateStore } from "@/lib/aws/mock-state-store";

export default async function globalSetup() {
  console.log("[PLAYWRIGHT] Global setup: Resetting mock state store");
  resetMockStateStore();

  // Clear any server action locks
  const stateStore = getMockStateStore();
  await stateStore.resetState();
  console.log("[PLAYWRIGHT] Global setup: Cleared server action locks");
}
