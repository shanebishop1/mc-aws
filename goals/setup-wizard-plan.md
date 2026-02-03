# MC-AWS Setup Wizard Implementation Plan

## Goal

Create a self-bootstrapping setup experience where a new user can clone the repo and run a single command to:
1. Install correct tool versions (Node 22, pnpm 10) via mise
2. Be guided through getting/entering all required credentials interactively
3. Deploy AWS infrastructure via CDK
4. Deploy Cloudflare Workers frontend

**End state:** `./setup.sh` → fully deployed application

---

## Phase 1: Mise Configuration

### Files to Create
- `mise.toml` - Project tool versions with auto-install hook

### Configuration
```toml
[tools]
node = "22"
pnpm = "10"

[hooks]
enter = "mise install --quiet"
```

### Behavior
- When user `cd`s into directory, mise auto-installs correct Node/pnpm
- Self-bootstrap: mise reads mise.toml and installs tools automatically
- No manual version management needed

---

## Phase 2: Setup Wizard Script

### File
`setup.sh` (root level - easy to find and run)

### Prerequisites Check
1. Check if mise is installed
   - If not: print install command (`curl https://mise.run | sh`) and exit
2. Run `mise install` to ensure correct Node/pnpm
3. Run `pnpm install` for project dependencies
4. Run `pnpm install` in `/infra` for CDK dependencies

---

## Phase 3: Interactive Environment Setup

### Flow Structure
The wizard guides users through each credential with:
- Clear explanation of what it's for
- Step-by-step instructions to obtain it
- Input prompt
- Validation where possible

### Credential Groups (in order)

#### 1. AWS Core
| Variable | Guide |
|----------|-------|
| `AWS_REGION` | Show list of common regions, let user pick |
| `AWS_ACCESS_KEY_ID` | "Go to AWS Console → IAM → Users → Your User → Security credentials → Create access key" |
| `AWS_SECRET_ACCESS_KEY` | (collected with above) |
| `CDK_DEFAULT_ACCOUNT` | "Run: `aws sts get-caller-identity --query Account --output text`" |
| `CDK_DEFAULT_REGION` | (same as AWS_REGION) |

#### 2. EC2 Access
| Variable | Guide |
|----------|-------|
| `KEY_PAIR_NAME` | "Go to EC2 → Key Pairs → Create key pair → Download .pem file" |

#### 3. Google OAuth
| Variable | Guide |
|----------|-------|
| `GOOGLE_CLIENT_ID` | Link to console.cloud.google.com, step-by-step to create OAuth app |
| `GOOGLE_CLIENT_SECRET` | (collected with above) |

#### 4. Authorization
| Variable | Guide |
|----------|-------|
| `ADMIN_EMAIL` | "Your Google email (full admin access)" |
| `ALLOWED_EMAILS` | "Comma-separated list of other users who can start/stop server" |

#### 5. Cloudflare (for DNS updates)
| Variable | Guide |
|----------|-------|
| `CLOUDFLARE_DNS_API_TOKEN` | "My Profile → API Tokens → Create Token → Edit zone DNS" |
| `CLOUDFLARE_ZONE_ID` | "Domain overview page → right sidebar" |
| `CLOUDFLARE_RECORD_ID` | "Use API or we can create it during CDK deploy" |
| `CLOUDFLARE_MC_DOMAIN` | "The subdomain for your Minecraft server (e.g., mc.example.com)" |

#### 6. Production URL
| Variable | Guide |
|----------|-------|
| `NEXT_PUBLIC_APP_URL` | "Your control panel URL (e.g., https://panel.example.com)" |

#### 7. Optional: Email Start (SES)
| Variable | Guide |
|----------|-------|
| `VERIFIED_SENDER` | "SES verified email for sending notifications" |
| `NOTIFICATION_EMAIL` | "Where to send server notifications" |
| `START_KEYWORD` | "Secret keyword to start server via email" |

#### 8. Optional: GitHub Config Sync
| Variable | Guide |
|----------|-------|
| `GITHUB_USER` | "Your GitHub username" |
| `GITHUB_REPO` | "Repo for server config backup" |
| `GITHUB_TOKEN` | "Settings → Developer settings → Personal access tokens" |

#### 9. Optional: Google Drive Backups
| Variable | Guide |
|----------|-------|
| `GDRIVE_REMOTE` | "rclone remote name (usually 'gdrive')" |
| `GDRIVE_ROOT` | "Folder path in Drive for backups" |

### Auto-Generated
| Variable | How |
|----------|-----|
| `AUTH_SECRET` | Generate via `openssl rand -base64 48` |

---

## Phase 4: Deploy AWS Infrastructure (CDK)

### Steps
1. Write collected values to `.env.local` and `.env.production`
2. `cd infra && pnpm run deploy`
3. Capture outputs:
   - `INSTANCE_ID` from CloudFormation outputs
   - Any other dynamic values
4. Update `.env.local` and `.env.production` with captured outputs

### Error Handling
- If CDK fails, show error and offer to retry
- Save progress so user doesn't have to re-enter credentials

---

## Phase 5: Deploy Cloudflare Workers

### Steps
1. Ensure all required secrets are in `.env.production`
2. Run existing `./scripts/deploy-cloudflare.sh`
3. Show success message with live URL

---

## File Changes Summary

### New Files
| File | Purpose |
|------|---------|
| `mise.toml` | Tool version pinning |
| `setup.sh` | Main setup wizard entry point |
| `scripts/setup-wizard.sh` | Interactive credential collection logic |

### Modified Files
| File | Changes |
|------|---------|
| `package.json` | Add `setup` script |
| `README.md` | Update quickstart to use `./setup.sh` |
| `.gitignore` | Ensure mise.local.toml is ignored |

---

## User Experience

### New User Flow
```bash
# Clone repo
git clone https://github.com/you/mc-aws.git
cd mc-aws

# Run setup (one command!)
./setup.sh

# Wizard guides through:
# 1. Installing mise (if needed)
# 2. Installing Node/pnpm (automatic)
# 3. Collecting credentials (interactive)
# 4. Deploying AWS infrastructure
# 5. Deploying Cloudflare frontend
# 
# Done! App is live.
```

### Returning User Flow
```bash
cd mc-aws
# mise auto-installs correct versions
pnpm dev  # ready to develop
```

---

## Implementation Order

1. [ ] Create `mise.toml`
2. [ ] Create `setup.sh` (bootstrap + calls wizard)
3. [ ] Create `scripts/setup-wizard.sh` (interactive prompts)
4. [ ] Test mise bootstrap flow
5. [ ] Test credential collection
6. [ ] Test CDK deployment integration
7. [ ] Test Cloudflare deployment integration
8. [ ] Update README
9. [ ] End-to-end test

---

## Open Questions

1. **Windows support?** - Current scripts are bash-only. Consider PowerShell version or WSL requirement?

2. **Credential storage format?** - Write directly to `.env.local`/`.env.production` or use intermediate file?

3. **CDK output capture** - How to reliably get `INSTANCE_ID` from CDK deploy output?

4. **Resume capability?** - If setup fails partway, can user resume without re-entering everything?

5. **Validation depth** - Should we validate AWS credentials work before proceeding? (e.g., `aws sts get-caller-identity`)
