import "source-map-support/register";

import * as fs from "node:fs";
import * as path from "node:path";

import * as dotenv from "dotenv";

// Load environment from repo-root .env for CDK deploys
const rootEnvPath = path.resolve(__dirname, "../../.env");

if (fs.existsSync(rootEnvPath)) {
  // override=true so a blank env var doesn't block values from .env
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
