#!/usr/bin/env node
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

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
})();
