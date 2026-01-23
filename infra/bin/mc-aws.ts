import "source-map-support/register";

import * as fs from "node:fs";
import * as path from "node:path";

import * as dotenv from "dotenv";

// Prefer repo-root .env.local for CDK deploys run from infra/
const rootEnvLocalPath = path.resolve(__dirname, "../../.env.local");
const rootEnvPath = path.resolve(__dirname, "../../.env");

if (fs.existsSync(rootEnvLocalPath)) {
  // override=true so a blank env var doesn't block values from .env.local
  dotenv.config({ path: rootEnvLocalPath, override: true });
} else if (fs.existsSync(rootEnvPath)) {
  dotenv.config({ path: rootEnvPath, override: true });
} else {
  dotenv.config();
}

import * as cdk from "aws-cdk-lib";
import { MinecraftStack } from "../lib/minecraft-stack";

const app = new cdk.App();
new MinecraftStack(app, "MinecraftStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
