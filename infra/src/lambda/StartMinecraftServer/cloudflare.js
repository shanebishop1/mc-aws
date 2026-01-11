/**
 * Update Cloudflare DNS A record with the provided IP address
 * @param {string} zone - Cloudflare zone ID
 * @param {string} record - Cloudflare record ID
 * @param {string} ip - The IP address to set
 * @param {string} domain - The domain name
 * @param {string} cfToken - Cloudflare API token
 * @returns {Promise<void>}
 */
export async function updateCloudflareDns(zone, record, ip, domain, cfToken) {
  console.log(`Updating Cloudflare DNS record ${record} in zone ${zone} for domain ${domain} to IP ${ip}`);
  const cfUrl = `https://api.cloudflare.com/client/v4/zones/${zone}/dns_records/${record}`;
  const cfPayload = {
    type: "A",
    name: domain,
    content: ip,
    ttl: 60,
    proxied: false,
  };

  try {
    const response = await fetch(cfUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${cfToken}`,
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
  } catch (fetchError) {
    console.error("Error updating Cloudflare DNS:", fetchError);
    throw fetchError;
  }
}
