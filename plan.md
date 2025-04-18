This project lets you run a fully automated, pay‑as‑you‑play Minecraft server on AWS by keeping only “glue” code (boot‑strapping scripts, systemd units, IAM policies, plugin configs, and a start‑server Lambda) in a GitHub repo, while never tracking your world data or JARs. When an EC2 instance boots, its user‑data script installs Java & the AWS CLI, clones your repo, downloads the PaperMC server jar, deploys the minecraft.service unit and the stop-ec2.sh helper, and starts the game. An EmptyServerStop plugin watches for 15 minutes of no players and invokes your IAM‑authorized shutdown script so the instance stops itself—and you only pay for the seconds it’s actually running (plus a few cents of EBS storage). Optionally, an SES‑triggered Lambda lets you start the server by sending a secret email, completing a seamless GitOps‑style workflow that tracks every piece of infrastructure and code around your Minecraft world.

Here’s a complete, end‑to‑end guide for your “pay‑as‑you‑play” Minecraft server on AWS, with exactly what code lives in your local Git repo, how to push it to GitHub, and how EC2 will pull & run it.

⸻

📦 1. Project Overview & Structure

Your GitHub repo will contain only the “glue” around Minecraft—no world data, JARs, or logs. When an EC2 instance boots, it:
	1.	Clones this repo
	2.	Installs Java & AWS CLI
	3.	Downloads Paper.jar
	4.	Deploys systemd unit, stop‑script & plugin config
	5.	Starts the server
	6.	Auto‑stops itself when idle

minecraft-aws-setup/
├── .gitignore
├── README.md
│
├── ec2/                     # EC2 bootstrap & service files
│   ├── user_data.sh        # cloud-init script
│   ├── minecraft.service   # systemd unit
│   └── stop-ec2.sh         # self‑shutdown helper
│
├── iam/
│   └── self-stop-policy.json  # IAM inline policy for EC2 role
│
├── lambda/
│   ├── index.js            # SES‑triggered “start server” Lambda
│   └── package.json        # for any Node deps
│
└── plugin/
    └── EmptyServerStop/
        └── config.yml      # idle‑shutdown plugin config



⸻

🔧 2. Local Code to Write

2.1 .gitignore

# Don’t track binaries or server data
/opt/minecraft/server/
/var/log/minecraft/
/**/*.jar

2.2 ec2/user_data.sh

This is run by EC2 at first boot (Cloud‑Init). It will:
	•	Install Java & AWS CLI
	•	Clone your repo
	•	Download PaperMC
	•	Copy service, script & plugin files
	•	Enable & start systemd

#!/usr/bin/env bash
# 1. Update & install prerequisites
yum update -y
rpm --import https://yum.corretto.aws/corretto.key
cat <<EOF > /etc/yum.repos.d/corretto.repo
[corretto-17]
name=Amazon Corretto 17 repo
baseurl=https://yum.corretto.aws/amazon-corretto-17.repo
gpgcheck=1
gpgkey=https://yum.corretto.aws/corretto.key
EOF
yum install -y java-17-amazon-corretto-devel unzip git

# 2. Install AWS CLI v2
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip /tmp/awscliv2.zip -d /tmp
/tmp/aws/install

# 3. Create minecraft user & dirs
useradd -m -r minecraft
mkdir -p /opt/minecraft/server
chown -R minecraft:minecraft /opt/minecraft

# 4. Clone this repo
git clone https://github.com/<YOUR_USER>/minecraft-aws-setup.git /opt/setup

# 5. Download Paper jar
sudo -u minecraft bash -c '
  cd /opt/minecraft/server
  wget https://api.papermc.io/v2/projects/paper/versions/1.20.1/builds/146/downloads/paper-1.20.1-146.jar -O paper.jar
  echo "eula=true" > eula.txt
'

# 6. Deploy service & scripts
cp /opt/setup/ec2/minecraft.service /etc/systemd/system/
cp /opt/setup/ec2/stop-ec2.sh /usr/local/bin/
chown root:root /usr/local/bin/stop-ec2.sh && chmod +x /usr/local/bin/stop-ec2.sh

# 7. Deploy plugin config
mkdir -p /opt/minecraft/server/plugins/EmptyServerStop
cp /opt/setup/plugin/EmptyServerStop/config.yml /opt/minecraft/server/plugins/EmptyServerStop/
chown -R minecraft:minecraft /opt/minecraft/server/plugins

# 8. Enable & start
systemctl daemon-reload
systemctl enable minecraft.service
systemctl start minecraft.service

2.3 ec2/minecraft.service

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

2.4 ec2/stop-ec2.sh

#!/usr/bin/env bash
INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
aws ec2 stop-instances --instance-ids $INSTANCE_ID

2.5 iam/self-stop-policy.json

{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["ec2:StopInstances"],
    "Resource": "arn:aws:ec2:<REGION>:<ACCOUNT_ID>:instance/<INSTANCE_ID>"
  }]
}

2.6 plugin/EmptyServerStop/config.yml

idleMinutes: 15
onIdleCommand:
  - "/usr/local/bin/stop-ec2.sh"

2.7 lambda/index.js

const AWS = require("aws-sdk");
const ec2 = new AWS.EC2({ region: process.env.AWS_REGION });

exports.handler = async () => {
  await ec2.startInstances({ InstanceIds: [process.env.INSTANCE_ID] }).promise();
  return { statusCode: 200, body: "Server starting…" };
};

// lambda/package.json
{
  "name": "minecraft-starter",
  "version": "1.0.0",
  "dependencies": {
    "aws-sdk": "^2.1354.0"
  }
}



⸻

🚀 3. Push to GitHub

cd minecraft-aws-setup
git init
git add .
git commit -m "Initial glue-code for AWS Minecraft server"
git remote add origin git@github.com:<YOUR_USER>/minecraft-aws-setup.git
git push -u origin main



⸻

☁️ 4. Bootstrapping on AWS
	1.	Create IAM role (EC2)
	•	Attach the inline policy from iam/self-stop-policy.json.
	2.	Launch EC2 (Amazon Linux 2, t3.small):
	•	User Data: paste the full contents of ec2/user_data.sh.
	•	IAM Role: choose the one you created.
	•	Security Group: allow TCP 22 (SSH) from your IP, TCP 25565 (Minecraft) from 0.0.0.0/0 (or your friends).
	3.	Verify: SSH in & check systemctl status minecraft.service.
	4.	Test idle‑stop: Join → leave → wait 15 min → instance should stop.
	5.	Start via SES+Lambda (if set up): email start@… → SES invokes Lambda → instance starts automatically.

⸻

🎯 TL;DR
	•	Local repo holds only scripts, configs & policies—no JARs or world data.
	•	Push to GitHub.
	•	EC2 User Data clones your repo and bootstraps everything.
	•	Idle plugin + IAM role let the server stop itself when empty.
	•	SES+Lambda can start it via a secret email.

You’re now set up to track all your infrastructure “glue” in GitHub, spin up a server in minutes, and pay only for the minutes you actually play!
