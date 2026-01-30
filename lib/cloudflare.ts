/**
 * Cloudflare DNS utility for updating A records
 *
 * Supports both AWS mode (real Cloudflare API) and mock mode (simulated updates).
 */

import { getMockStateStore } from "./aws/mock-state-store";
import { env, isMockMode } from "./env";

/**
 * Mock DNS record information
 */
export interface MockDnsRecord {
  domain: string;
  ip: string;
  updatedAt: string;
}

/**
 * Update Cloudflare DNS A record with the provided IP address
 *
 * In AWS mode: Makes a real API call to Cloudflare
 * In mock mode: Logs the update and stores it in the mock state store
 */
export async function updateCloudflareDns(ip: string): Promise<void> {
  if (isMockMode()) {
    return updateCloudflareDnsMock(ip);
  }

  return updateCloudflareDnsReal(ip);
}

/**
 * Real Cloudflare DNS update (AWS mode)
 */
async function updateCloudflareDnsReal(ip: string): Promise<void> {
  console.log(`Updating Cloudflare DNS for ${env.CLOUDFLARE_MC_DOMAIN} to IP ${ip}`);

  const cfUrl = `https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/dns_records/${env.CLOUDFLARE_RECORD_ID}`;
  const cfPayload = {
    type: "A",
    name: env.CLOUDFLARE_MC_DOMAIN,
    content: ip,
    ttl: 60,
    proxied: false,
  };

  try {
    const response = await fetch(cfUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(cfPayload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`Cloudflare API error: ${response.status} ${response.statusText}`, errorBody);
      throw new Error(`Failed to update Cloudflare DNS record. Status: ${response.status}`);
    }

    console.log("Successfully updated Cloudflare DNS record.");
  } catch (error) {
    console.error("Error updating Cloudflare DNS:", error);
    throw error;
  }
}

/**
 * Mock Cloudflare DNS update (mock mode)
 *
 * Simulates a DNS update by logging the action and storing the record
 * in the mock state store. No actual API call is made.
 */
async function updateCloudflareDnsMock(ip: string): Promise<void> {
  const domain = env.CLOUDFLARE_MC_DOMAIN || "mc.example.com";

  console.log(`[MOCK-CLOUDFLARE] Simulating DNS update for ${domain} to IP ${ip}`);
  console.log(`[MOCK-CLOUDFLARE] Zone ID: ${env.CLOUDFLARE_ZONE_ID || "mock-zone-id"}`);
  console.log(`[MOCK-CLOUDFLARE] Record ID: ${env.CLOUDFLARE_RECORD_ID || "mock-record-id"}`);

  try {
    // Store the mock DNS record in the state store
    const stateStore = getMockStateStore();
    const mockRecord: MockDnsRecord = {
      domain,
      ip,
      updatedAt: new Date().toISOString(),
    };

    // Store as a custom parameter in SSM for consistency with other mock data
    await stateStore.setParameter("/minecraft/cloudflare-dns", JSON.stringify(mockRecord), "String");

    console.log("[MOCK-CLOUDFLARE] DNS update simulated successfully. Record stored in mock state.");
  } catch (error) {
    console.error("[MOCK-CLOUDFLARE] Error storing mock DNS record:", error);
    // Don't throw - mock mode should be resilient
  }
}

/**
 * Get the current mock DNS record (mock mode only)
 *
 * Returns the last simulated DNS update from the mock state store.
 * Returns null if no record exists or in AWS mode.
 */
export async function getMockDnsRecord(): Promise<MockDnsRecord | null> {
  if (!isMockMode()) {
    return null;
  }

  try {
    const stateStore = getMockStateStore();
    const recordJson = await stateStore.getParameter("/minecraft/cloudflare-dns");

    if (!recordJson) {
      return null;
    }

    return JSON.parse(recordJson) as MockDnsRecord;
  } catch (error) {
    console.error("[MOCK-CLOUDFLARE] Error retrieving mock DNS record:", error);
    return null;
  }
}
