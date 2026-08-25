import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve(process.cwd(), "infra/src/ec2/user_data.sh");
const script = readFileSync(scriptPath, "utf8");

describe("EC2 user data", () => {
  it("is valid Bash", () => {
    expect(spawnSync("bash", ["-n", scriptPath]).status).toBe(0);
  });

  it("uses the supported Paper downloads service contract", () => {
    expect(script).toContain("https://fill.papermc.io/v3/");
    expect(script).toContain("User-Agent: ${PAPER_USER_AGENT}");
    expect(script).not.toContain("api.papermc.io/v2");
  });

  it("powers off when bootstrap fails", () => {
    expect(script).toContain("trap bootstrap_failed EXIT");
    expect(script).toContain("systemctl poweroff || shutdown -h now");
  });

  it("installs the rclone helper and optionally materializes config without an inline token", () => {
    expect(script).toContain("mc-rclone-config.sh mc-backup.sh");
    expect(script).toContain("/usr/local/bin/mc-rclone-config.sh --bootstrap");
    expect(script).toContain("/etc/minecraft/gdrive-remote");
    expect(script).toContain("/etc/minecraft/gdrive-root");
    expect(script).not.toContain("TOKEN_JSON=");
    expect(script).not.toContain("chown -R minecraft:minecraft /opt/setup/rclone");
  });
});
