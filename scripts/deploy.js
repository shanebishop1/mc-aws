#!/usr/bin/env node
require('dotenv').config();
const { execSync } = require('child_process');

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('Error: GITHUB_TOKEN not found in .env file.');
  console.error('Please add GITHUB_TOKEN="ghp_..." to your .env file.');
  process.exit(1);
}

const command = `cdk deploy --parameters GithubTokenParam="${token}" --require-approval never`;

console.log('Deploying Minecraft Stack...');
try {
  execSync(command, { stdio: 'inherit' });
} catch (error) {
  process.exit(1);
}
