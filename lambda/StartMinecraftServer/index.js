import fetch from "node-fetch";
import { EC2Client, StartInstancesCommand, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { SES } from "aws-sdk";

const ec2 = new EC2Client({ region: "us-west-1" });
const ses = new SES({ apiVersion: "2010-12-01", region: "us-west-1" });

export const handler = async (event) => {
  const instanceId = process.env.INSTANCE_ID;
  // 1. Start EC2
  await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));  

  // 2. Wait for Public IP
  let publicIp;
  while (!publicIp) {
    const { Reservations } = await ec2.send(
      new DescribeInstancesCommand({ InstanceIds: [instanceId] })
    );
    const inst = Reservations[0].Instances[0];
    publicIp = inst.PublicIpAddress;
    if (!publicIp) await new Promise(r => setTimeout(r, 3000));
  }

  // 3. Update Cloudflare A record
  const zone = process.env.CLOUDFLARE_ZONE_ID;
  const record = process.env.CLOUDFLARE_RECORD_ID;
  await fetch(
    `https://api.cloudflare.com/client/v4/zones/${zone}/dns_records/${record}`,
    {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        type: "A",
        name: process.env.CLOUDFLARE_MC_DOMAIN,
        content: publicIp,
        ttl: 300,
        proxied: false
      })
    }
  );  

  // 4. Reply with the IP
  const fromAddr = process.env.VERIFIED_SENDER;
  const toAddr   = event.mail.commonHeaders.from[0];
  await ses.sendEmail({
    Source: fromAddr,
    Destination: { ToAddresses: [toAddr] },
    Message: {
      Subject: { Data: "Your Minecraft Server IP" },
      Body: { Text: { Data: `Server is up at ${publicIp}` } }
    }
  }).promise();  
};
