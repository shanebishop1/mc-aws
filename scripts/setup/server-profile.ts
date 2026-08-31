#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCAL_PROFILE_DIRECTORY,
  resolveServerProfileDirectory,
  validateServerProfile,
} from "../../lib/server-profile";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const command = process.argv[2] ?? "validate";

try {
  if (command === "init") {
    const destination = path.join(root, LOCAL_PROFILE_DIRECTORY);
    if (fs.existsSync(destination))
      throw new Error(`${LOCAL_PROFILE_DIRECTORY}/ already exists; nothing was overwritten.`);
    fs.cpSync(path.join(root, "config"), destination, { recursive: true, errorOnExist: true, force: false });
    console.log(`Created ignored local profile: ${destination}`);
    console.log("Add at least one Minecraft UUID/name to whitelist.json, then run pnpm profile:validate.");
  } else if (command === "validate") {
    const directory = resolveServerProfileDirectory(root);
    const result = (() => {
      try {
        return validateServerProfile(directory);
      } catch (error) {
        if (directory === path.join(root, "config") && (error as Error).message.startsWith("whitelist.json is empty")) {
          throw new Error(
            "Tracked config/ has no authorized players. Run pnpm profile:init, add at least one Minecraft UUID/name to server-profile/whitelist.json, then validate again."
          );
        }
        throw error;
      }
    })();
    console.log(
      `Valid server profile: ${result.directory} (${result.fileCount} files, ${result.totalBytes} bytes, ${result.plugins.length} plugins)`
    );
  } else if (command === "rollout-check") {
    const result = validateServerProfile(resolveServerProfileDirectory(root));
    console.log(`Profile is valid: ${result.directory}`);
    console.log(
      "No deployment or instance command was run. Existing-instance profile rollout is intentionally fail-closed; use a reviewed rebuild/transition as documented."
    );
  } else {
    throw new Error("Usage: pnpm profile:init | pnpm profile:validate | pnpm profile:rollout:check");
  }
} catch (error) {
  console.error(`Server profile refused: ${(error as Error).message}`);
  process.exit(1);
}
