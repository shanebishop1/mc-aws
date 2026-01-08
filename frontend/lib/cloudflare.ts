/**
 * Cloudflare DNS utility for updating A records
 */

import { env } from "./env";

/**
 * Update Cloudflare DNS A record with the provided IP address
 */
export async function updateCloudflareDns(ip: string): Promise<void> {
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
