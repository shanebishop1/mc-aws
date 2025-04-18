#!/usr/bin/env bash
# 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
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
curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip
unzip /tmp/awscliv2.zip -d /tmp
/tmp/aws/install

# 3. Create minecraft user & dirs
useradd -m -r minecraft
mkdir -p /opt/minecraft/server
chown -R minecraft:minecraft /opt/minecraft

# 4. Clone this repo

# Fetch token
GITHUB_TOKEN=$(aws ssm get-parameter \
  --name /minecraft/github-pat \
  --with-decryption \
  --query Parameter.Value --output text)

# Clone via HTTPS with token (note: no spaces!)
sudo -u minecraft git clone \
  https://shanebishop1:${GITHUB_TOKEN}@github.com/shanebishop1/mc_aws.git \
  /opt/setup

# 5. Download Paper jar
sudo -u minecraft bash -c '
  cd /opt/minecraft/server
  wget https://api.papermc.io/v2/projects/paper/versions/1.21.4/builds/226/downloads/paper-1.21.4-226.jar -O paper.jar
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
