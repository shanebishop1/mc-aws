# Tasks - Ec 2 Dns Migration

## In Progress

- [ ] 6.1: Deploy CDK stack

## To Do

- [ ] 6.2: Test fresh instance start
- [ ] 6.3: Test manual EC2 start
- [ ] 6.4: Test reboot
- [ ] 6.5: Test restore

## Backlog


## Done

- [x] 1.1: Add SSM parameters to CDK stack (Cloudflare creds + SNS topic ARN)
- [x] 1.2: Grant EC2 IAM role SSM read permissions for cloudflare/notification params
- [x] 1.3: Grant EC2 IAM role SNS publish permission for notification topic
- [x] 2.1: Create update-dns.sh script (with SNS notification on update)
- [x] 2.2: Create minecraft-dns.service systemd unit
- [x] 3.1: Update user_data.sh to install DNS service
- [x] 4.1: Delete cloudflare.js from Lambda
- [x] 4.2: Remove DNS calls from index.js and restore.js
- [x] 4.3: Remove Cloudflare env vars from Lambda CDK config
- [x] 5.1: Review frontend lib/cloudflare.ts

## Functional Requirement

- [ ] --

## Current State

- [ ] **Lambda** (`infra/src/lambda/StartMinecraftServer/`):
- [ ] `cloudflare.js` - exports `updateCloudflareDns(publicIp)`
- [ ] Cloudflare creds passed as Lambda env vars: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_RECORD_NAME`
- [ ] Called from: `index.js` (start/resume), `handlers/restore.js`
- [ ] **EC2**: No DNS awareness
- [ ] **CDK** (`infra/lib/minecraft-stack.ts`):
- [ ] Lambda environment includes Cloudflare vars
- [ ] EC2 IAM role has SSM access for other parameters
- [ ] --

## Target State

- [ ] **SSM Parameter Store**: Cloudflare credentials stored securely
- [ ] **EC2**: Runs DNS update script on every boot via systemd oneshot
- [ ] **Lambda**: No Cloudflare logic, no Cloudflare env vars
- [ ] --

## Tasks

- [ ] --
- [ ] -name "$1" \
- [ ] -with-decryption \
- [ ] -query 'Parameter.Value' \
- [ ] -output text \
- [ ] -region "$REGION"
- [ ] H "Authorization: Bearer ${CF_API_TOKEN}" \
- [ ] H "Content-Type: application/json")
- [ ] H "Authorization: Bearer ${CF_API_TOKEN}" \
- [ ] H "Content-Type: application/json" \
- [ ] -data "{\"type\":\"A\",\"name\":\"${CF_DOMAIN}\",\"content\":\"${PUBLIC_IP}\",\"ttl\":60,\"proxied\":false}")
- [ ] -topic-arn "$SNS_TOPIC_ARN" \
- [ ] -subject "$SUBJECT" \
- [ ] -message "$MESSAGE" \
- [ ] -region "$REGION" > /dev/null 2>&1; then
- [ ] Token only held in memory during script execution
- [ ] No logging of token value
- [ ] Script runs as root (systemd default), credentials not accessible to minecraft user
- [ ] --
- [ ] `infra/src/ec2/update-dns.sh`
- [ ] `infra/src/ec2/minecraft-dns.service`
- [ ] --
- [ ] `import { updateCloudflareDns } from "./cloudflare.js"` (or require)
- [ ] All calls to `updateCloudflareDns(publicIp)` in `handleStartCommand` and `handleResumeCommand`
- [ ] Any related logging about DNS updates
- [ ] Import of `updateCloudflareDns`
- [ ] Call to `updateCloudflareDns` (around lines 52-65)
- [ ] Related logging
- [ ] `CLOUDFLARE_API_TOKEN`
- [ ] `CLOUDFLARE_ZONE_ID`
- [ ] `CLOUDFLARE_RECORD_NAME`
- [ ] --
- [ ] --
- [ ] Create SSM parameters
- [ ] Update Lambda (remove Cloudflare logic)
- [ ] Update EC2 launch template with new user_data.sh
- [ ] `minecraft-dns.service` runs successfully
- [ ] DNS record updated
- [ ] --

## Rollback Plan

- [ ] --

## Security Summary

- [ ] Token never logged
- [ ] Token only in memory during script execution
- [ ] EC2 IAM role scoped to specific parameter paths
- [ ] EC2 IAM role has SNS publish permission (scoped to notification topic only)
- [ ] Lambda no longer has Cloudflare credentials
- [ ] --

## Files Changed Summary

- [ ] --

## Task Checklist

- [ ] 1.1: Add SSM parameters to CDK stack (Cloudflare creds + SNS topic ARN + notification email)
- [ ] 2.1: Create `update-dns.sh` script (with SNS notification on update)
- [ ] 2.2: Create `minecraft-dns.service` systemd unit
- [ ] 3.1: Update `user_data.sh` to install DNS service
- [ ] 4.1: Delete `cloudflare.js` from Lambda
- [ ] 4.2: Remove DNS calls from `index.js` and `restore.js`
- [ ] 5.1: Review frontend `lib/cloudflare.ts` (likely no changes)
- [ ] 6.2: Test fresh instance start (verify DNS + email notification)
