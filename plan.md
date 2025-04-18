Here’s a step‑by‑step implementation plan—combining Sidoine’s <$3/month> AWS guide with the Idle‑Shutdown plugin approach so your EC2 instance halts itself whenever nobody’s online. Everything’s laid out in order, with the exact commands, IAM roles, and AWS Console clicks you’ll need.

⸻

Prerequisites
	•	An AWS account with permissions to create EC2, SES, Lambda, IAM, and CloudWatch resources.
	•	A domain (or subdomain) you can point MX records at for SES.
	•	A “secret” email address (e.g. start@minecraft.yourdomain.com) for yourself.

⸻

1. Launch & Configure Your EC2 Minecraft Server
	1.	Create (or reuse) an SSH key pair in EC2 → Key Pairs; download the .pem.
	2.	Launch Instance (EC2 → Instances → Launch):
	•	AMI: Amazon Linux 2.
	•	Instance type: t3.small (2 GB RAM) or t3.micro if you’re adventurous.
	•	Storage: 8–20 GB gp2 is fine.
	•	Security group:
	•	SSH (22) from your IP
	•	Minecraft (TCP 25565) from 0.0.0.0/0 (or friend‑only CIDRs)
	•	IAM role: Skip for now—we’ll attach one after we create it.
	3.	SSH in from your terminal:

chmod 400 ~/Downloads/your-key.pem
ssh -i ~/Downloads/your-key.pem ec2-user@<YOUR_PUBLIC_IP>


	4.	Install Java 17 (Corretto):  ￼

sudo rpm --import https://yum.corretto.aws/corretto.key
sudo curl -L -o /etc/yum.repos.d/corretto.repo \
     https://yum.corretto.aws/corretto.repo
sudo yum install -y java-17-amazon-corretto-devel.x86_64
java --version


	5.	Create a dedicated Minecraft user & directory:

sudo adduser minecraft
sudo mkdir -p /opt/minecraft/server
sudo chown -R minecraft:minecraft /opt/minecraft


	6.	Download & install the server jar (PaperMC recommended for plugins):

sudo su - minecraft
cd /opt/minecraft/server
wget https://api.papermc.io/v2/projects/paper/versions/1.20.1/builds/146/downloads/paper-1.20.1-146.jar \
     -O paper.jar
echo "eula=true" > eula.txt
exit



⸻

2. Configure systemd for Auto‑Restart

Create /etc/systemd/system/minecraft.service as root:

[Unit]
Description=Minecraft Server
After=network.target

[Service]
User=minecraft
WorkingDirectory=/opt/minecraft/server
ExecStart=/usr/bin/java -Xms1G -Xmx1G -jar paper.jar nogui
ExecStop=/bin/kill -SIGINT $MAINPID
Restart=on-failure

[Install]
WantedBy=multi-user.target

Then:

sudo chmod 664 /etc/systemd/system/minecraft.service
sudo systemctl daemon-reload
sudo systemctl enable minecraft.service
sudo systemctl start minecraft.service



⸻

3. IAM Role for Self‑Stop
	1.	In the AWS Console, go to IAM → Roles → Create role.
	2.	Select type: EC2.
	3.	Attach policy (inline):

{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["ec2:StopInstances"],
    "Resource": "arn:aws:ec2:<region>:<account-id>:instance/<your-instance-id>"
  }]
}


	4.	Name it MinecraftSelfStopRole, finish, and attach it to your EC2 instance.

⸻

4. Install AWS CLI & Idle‑Shutdown Script

SSH back into the instance and run:

# Install AWS CLI v2
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscli.zip
unzip awscli.zip && sudo ./aws/install

# Create stop script
sudo tee /usr/local/bin/stop-ec2.sh > /dev/null << 'EOF'
#!/bin/bash
INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
aws ec2 stop-instances --instance-ids $INSTANCE_ID
EOF

sudo chmod +x /usr/local/bin/stop-ec2.sh



⸻

5. Install & Configure EmptyServerStop Plugin
	1.	Download EmptyServerStop from SpigotMC and drop the .jar into /opt/minecraft/server/plugins/.
	2.	Edit its config (e.g. plugins/EmptyServerStop/config.yml):

idleMinutes: 15       # minutes with 0 players before shutdown
onIdleCommand: 
  - "/usr/local/bin/stop-ec2.sh"


	3.	Restart the Minecraft service:

sudo systemctl restart minecraft.service



Now if no one’s online for 15 minutes, the plugin will invoke your script and the EC2 instance will stop itself—so you pay only for active playtime.

⸻

6. “Start” via SES + Lambda

We’ll wire up SES to let you start the server with a secret email.

<details>
<summary>6.1. SES Setup</summary>


	1.	In us-west-2, verify your domain or subdomain for SES (Emails → Verified Identities).
	2.	Add an MX record pointing start.minecraft.yourdomain.com at inbound-smtp.us-west-2.amazonaws.com.
	3.	In SES → Email Receiving → Rule Sets → Edit default-rule-set → Create rule:
	•	Recipient: start@minecraft.yourdomain.com
	•	Action: Invoke Lambda mc_start
	•	Stop rule evaluation: Yes

</details>


<details>
<summary>6.2. Start Lambda</summary>


	1.	Lambda → Create function:
	•	Runtime: Node.js 16.x
	•	Role: New role with AWSLambdaBasicExecutionRole + inline policy allowing ec2:StartInstances on your instance.
	2.	Paste this in index.js (set INSTANCE_ID env var in Configuration → Environment variables):

const AWS = require("aws-sdk");
const ec2 = new AWS.EC2();
exports.handler = async () => {
  await ec2.startInstances({ InstanceIds: [process.env.INSTANCE_ID] }).promise();
  return { statusCode: 200, body: "started" };
};


	3.	Test by sending an email to start@minecraft.yourdomain.com—SES will fire the Lambda and your EC2 will boot.

</details>




⸻

7. Verify & Monitor
	•	Start test: send your secret email → EC2 instance goes pending → Minecraft service auto‑starts.
	•	Idle shutdown test: join server, log out, wait 15 minutes → EC2 instance stops.
	•	Billing: check Cost Explorer → EC2-Compute; you’ll see only the minutes you were live.

⸻

You’re done! With this, you’ll only incur:
	•	EBS storage (~$1/mo for 20 GB).
	•	Compute while the instance is running (≈$0.01–$0.03/hr).

Enjoy your dynamic, pay‑as‑you‑play Minecraft server!
