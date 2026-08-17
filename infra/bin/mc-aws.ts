import "source-map-support/register";

import * as fs from "node:fs";
import * as path from "node:path";

import * as dotenv from "dotenv";
import { loadEnvironmentPreservingCdkTarget } from "./cdk-target-env";

// Load environment from repo root for CDK deploys.
// Priority: .env.production, then .env.local.
const envCandidates = [".env.production", ".env.local"].map((file) => path.resolve(__dirname, `../../${file}`));
const selectedEnvPath = envCandidates.find((candidate) => fs.existsSync(candidate));

loadEnvironmentPreservingCdkTarget(() => {
  if (selectedEnvPath) {
    // override=true so a blank shell env var does not block file values. Explicit,
    // non-empty CDK target variables are restored after dotenv loads.
    dotenv.config({ path: selectedEnvPath, override: true });
  } else {
    dotenv.config({ override: true });
  }
});

import * as cdk from "aws-cdk-lib";
import { MinecraftStack } from "../lib/minecraft-stack";

const app = new cdk.App();
new MinecraftStack(app, "MinecraftStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
