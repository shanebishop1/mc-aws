const { EC2Client, DescribeInstancesCommand } = require("@aws-sdk/client-ec2");

const ec2 = new EC2Client({});
const MAX_POLL_ATTEMPTS = 300;
const POLL_INTERVAL_MS = 1000;

async function getPublicIp(instanceId) {
  let attempts = 0;
  while (attempts < MAX_POLL_ATTEMPTS) {
    attempts += 1;
    const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const inst = Reservations?.[0]?.Instances?.[0];
    const ip = inst?.PublicIpAddress;
    if (ip) return ip;
    const state = inst?.State?.Name;
    if (["stopping", "stopped", "terminated", "shutting-down"].includes(state)) {
      throw new Error(`Instance entered state ${state} while waiting for IP`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("Timed out waiting for public IP");
}

async function updateCloudflareDns({ zone, record, ip, domain, token }) {
  const url = `https://api.cloudflare.com/client/v4/zones/${zone}/dns_records/${record}`;
  const payload = {
    type: "A",
    name: domain,
    content: ip,
    ttl: 60,
    proxied: false,
  };
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cloudflare update failed: ${res.status} ${res.statusText} ${body}`);
  }
}

exports.handler = async (event) => {
  const requestType = event.RequestType;
  if (requestType === "Delete") {
    return { PhysicalResourceId: "UpdateDnsOnDeploy" };
  }

  const instanceId = process.env.INSTANCE_ID;
  const zone = process.env.CLOUDFLARE_ZONE_ID;
  const record = process.env.CLOUDFLARE_RECORD_ID;
  const domain = process.env.CLOUDFLARE_MC_DOMAIN;
  const token = process.env.CLOUDFLARE_DNS_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;

  if (!instanceId || !zone || !record || !domain || !token) {
    throw new Error("Missing Cloudflare or instance configuration");
  }

  const ip = await getPublicIp(instanceId);
  await updateCloudflareDns({ zone, record, ip, domain, token });

  return {
    PhysicalResourceId: "UpdateDnsOnDeploy",
    Data: { ip },
  };
};
