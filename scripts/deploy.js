#!/usr/bin/env node
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');
const fs = require('fs');

require('dotenv').config();

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

(async () => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('Error: GITHUB_TOKEN not found in .env file.');
    console.error('Please add GITHUB_TOKEN="ghp_..." to your .env file.');
    process.exit(1);
  }

  let gdriveArn = process.env.GDRIVE_TOKEN_SECRET_ARN;
  if (!gdriveArn) {
    const answer = (await prompt('No Google Drive token found (GDRIVE_TOKEN_SECRET_ARN). Run setup now? [y/N]: ')).trim().toLowerCase();
    if (answer.startsWith('y')) {
      const setupScript = path.resolve(__dirname, '..', 'bin', 'setup-drive-token.sh');
      try {
        execSync(setupScript, { stdio: 'inherit' });
        require('dotenv').config({ override: true });
        gdriveArn = process.env.GDRIVE_TOKEN_SECRET_ARN;
        if (!gdriveArn) {
          console.warn('Google Drive token not detected after setup. Add GDRIVE_TOKEN_SECRET_ARN to .env if you want Drive transfers.');
        } else {
          console.log('Google Drive token configured.');
        }
      } catch (err) {
        console.warn('Google Drive setup was skipped or failed; continuing without Drive token.');
      }
    }
  }

  const command = `cdk deploy --parameters GithubTokenParam="${token}" --require-approval never`;

  console.log('Deploying Minecraft Stack...');
  try {
    execSync(command, { stdio: 'inherit' });
  } catch (error) {
    process.exit(1);
  }

  // Optional: enable weekly EBS snapshots via DLM
  const backupPrompt = [
    'Enable AWS DLM weekly EBS snapshots?',
    '  - Schedule: every Monday at 03:00 UTC',
    '  - Retention: last 4 snapshots (oldest pruned)',
    '  - Cost: snapshot storage (~$0.40–$0.60/mo for 8GB with light weekly changes)',
    '  - If you plan to hibernate/delete the volume for cost savings, you may not want snapshots.',
    '',
    'Enable now? [y/N]: ',
  ].join('\n');
  const backupAnswer = (await prompt(backupPrompt)).trim().toLowerCase();
  if (backupAnswer.startsWith('y')) {
    const region = process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-west-1';
    const policyFile = path.resolve(__dirname, '..', 'setup', 'dlm', 'weekly-policy.json');
    if (!fs.existsSync(policyFile)) {
      console.warn('Could not find setup/dlm/weekly-policy.json; skipping snapshot setup.');
      return;
    }
    try {
      const existing = execSync(
        `aws dlm get-lifecycle-policies --region ${region} --query "Policies[?Description=='Minecraft weekly backups'].PolicyId | [0]" --output text`,
        { stdio: ['inherit', 'pipe', 'pipe'] },
      ).toString().trim();
      if (existing && existing !== 'None') {
        console.log(`Updating existing DLM policy ${existing}...`);
        execSync(
          `aws dlm update-lifecycle-policy --lifecycle-policy-id ${existing} --description "Minecraft weekly backups" --state ENABLED --policy-details file://${policyFile} --region ${region}`,
          { stdio: 'inherit' },
        );
      } else {
        console.log('Creating DLM policy for weekly snapshots...');
        execSync(
          `aws dlm create-lifecycle-policy --description "Minecraft weekly backups" --state ENABLED --policy-details file://${policyFile} --region ${region}`,
          { stdio: 'inherit' },
        );
      }
      console.log('Weekly EBS snapshots enabled.');
    } catch (err) {
      console.warn('Failed to configure DLM snapshots. You can run setup/dlm manually:', err.message);
    }
  }
})();
