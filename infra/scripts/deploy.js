#!/usr/bin/env node
const path = require("node:path");
const readline = require("node:readline");
const { execSync } = require("node:child_process");
const fs = require("node:fs");

require("dotenv").config();

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    })
  );
}

async function setupDLMSnapshots() {
  const backupPrompt = [
    "Enable AWS DLM weekly EBS snapshots?",
    "  - Schedule: every Monday at 03:00 UTC",
    "  - Retention: last 4 snapshots (oldest pruned)",
    "  - Cost: snapshot storage (~$0.40–$0.60/mo for 8GB with light weekly changes)",
    "  - If you plan to hibernate/delete the volume for cost savings, you may not want snapshots.",
    "",
    "Enable now? [y/N]: ",
  ].join("\n");

  const answer = (await prompt(backupPrompt)).trim().toLowerCase();
  if (!answer.startsWith("y")) return;

  const region =
    process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-1";
  const policyFile = path.resolve(__dirname, "..", "setup", "dlm", "weekly-policy.json");

  if (!fs.existsSync(policyFile)) {
    console.warn("Could not find setup/dlm/weekly-policy.json; skipping snapshot setup.");
    return;
  }

  try {
    const existing = execSync(
      `aws dlm get-lifecycle-policies --region ${region} --query "Policies[?Description=='Minecraft weekly backups'].PolicyId | [0]" --output text`,
      { stdio: ["inherit", "pipe", "pipe"] }
    )
      .toString()
      .trim();

    const policyArg = `--policy-details file://${policyFile} --region ${region}`;
    if (existing && existing !== "None") {
      console.log(`Updating existing DLM policy ${existing}...`);
      execSync(
        `aws dlm update-lifecycle-policy --lifecycle-policy-id ${existing} --description "Minecraft weekly backups" --state ENABLED ${policyArg}`,
        { stdio: "inherit" }
      );
    } else {
      console.log("Creating DLM policy for weekly snapshots...");
      execSync(
        `aws dlm create-lifecycle-policy --description "Minecraft weekly backups" --state ENABLED ${policyArg}`,
        {
          stdio: "inherit",
        }
      );
    }
    console.log("Weekly EBS snapshots enabled.");
  } catch (err) {
    console.warn("Failed to configure DLM snapshots. You can run setup/dlm manually:", err.message);
  }
}

(async () => {
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    console.error("Error: GITHUB_TOKEN not found in .env file.");
    console.error('Please add GITHUB_TOKEN="ghp_..." to your .env file.');
    process.exit(1);
  }

  const cloudflareToken = process.env.CLOUDFLARE_DNS_API_TOKEN;
  if (!cloudflareToken) {
    console.error("Error: CLOUDFLARE_DNS_API_TOKEN not found in .env file.");
    console.error('Please add CLOUDFLARE_DNS_API_TOKEN="..." to your .env file.');
    process.exit(1);
  }

  console.log("Deploying Minecraft Stack...");
  try {
    execSync(
      `pnpm cdk deploy --parameters GithubTokenParam="${githubToken}" --parameters CloudflareTokenParam="${cloudflareToken}" --require-approval never`,
      { stdio: "inherit" }
    );
  } catch (_error) {
    process.exit(1);
  }

  await setupDLMSnapshots();
})();
