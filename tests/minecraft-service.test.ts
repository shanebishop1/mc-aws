import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const service = readFileSync(path.resolve(process.cwd(), "infra/src/ec2/minecraft.service"), "utf8");
const stopScript = readFileSync(path.resolve(process.cwd(), "infra/src/ec2/mc-stop.sh"), "utf8");
const resumeScript = readFileSync(path.resolve(process.cwd(), "infra/src/ec2/mc-resume.sh"), "utf8");

describe("minecraft service", () => {
  it("does not mutate runtime/profile state on service restart", () => {
    expect(service).not.toMatch(/\bgit\b|rsync|mc-profile-install/);
    expect(service).toContain("WorkingDirectory=/opt/minecraft/server");
  });

  it("runs only ownership preparation as root and uses systemd-native stop semantics", () => {
    expect(service).not.toContain("PermissionsStartOnly");
    expect(service).toContain("ExecStartPre=+/bin/chown -R minecraft:minecraft /opt/minecraft/server/");
    expect(service).toContain("ExecStop=/usr/local/bin/mc-stop.sh");
    expect(service).toContain("ExecStopPost=-/usr/bin/screen -S mc-server -X quit");
    expect(service).not.toMatch(/ExecStop(?:Post)?=.*(?:\$\(|\|\|)/);
  });

  it("blocks both EC2 metadata endpoint addresses for the Minecraft process", () => {
    expect(service).toContain("IPAddressDeny=169.254.169.254/32");
    expect(service).toContain("IPAddressDeny=fd00:ec2::254/128");
  });

  it("keeps ExecStop alive until both screen and Java exit", () => {
    expect(service).toContain("TimeoutStopSec=60");
    expect(stopScript).toContain("screen -list");
    expect(stopScript).toContain('pgrep -u "$(id -u minecraft)" -x java');
    expect(stopScript).toContain("sleep 1");
  });

  it("does not start Minecraft until DNS succeeds during resume", () => {
    expect(resumeScript.indexOf("systemctl start minecraft-dns.service")).toBeLessThan(
      resumeScript.indexOf("systemctl start minecraft;")
    );
  });

  it("requires successful DNS publication before Minecraft on every boot", () => {
    expect(service).toContain("Requires=minecraft-dns.service");
    expect(service).toContain("After=network-online.target minecraft-dns.service");
  });
});
