import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve(process.cwd(), "infra/src/ec2/update-dns.sh");
const cleanupDirs: string[] = [];

function executable(filePath: string, content: string): void {
  writeFileSync(filePath, content, "utf8");
  chmodSync(filePath, 0o755);
}

function run(mode: "missing" | "read-failure") {
  const root = mkdtempSync(path.join(os.tmpdir(), "mc-dns-test-"));
  cleanupDirs.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin);

  executable(
    path.join(bin, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *latest/api/token*) printf 'token' ;;
  *public-ipv4*) printf '203.0.113.10' ;;
  *placement/region*) printf 'us-west-1' ;;
  *) exit 2 ;;
esac
`
  );
  executable(path.join(bin, "jq"), "#!/usr/bin/env bash\nexit 0\n");
  executable(
    path.join(bin, "aws"),
    `#!/usr/bin/env bash
set -euo pipefail
name=""
while (( $# > 0 )); do
  if [[ "$1" == "--name" ]]; then name="$2"; shift 2; continue; fi
  shift
done
if [[ "${mode}" == "read-failure" && "$name" == "/minecraft/cloudflare-zone-id" ]]; then
  printf 'ServiceUnavailable: unavailable\n' >&2
  exit 1
fi
printf 'ParameterNotFound: %s\n' "$name" >&2
exit 254
`
  );

  return spawnSync("bash", [scriptPath], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const directory of cleanupDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("update-dns.sh SSM failure contract", () => {
  it("allows intentional raw-IP mode when DNS parameters do not exist", () => {
    const result = run("missing");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("No provider configured; skipping DNS update");
  });

  it("fails startup instead of treating an SSM read failure as disabled DNS", () => {
    const result = run("read-failure");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Failed to read required DNS configuration state");
    expect(result.stdout).not.toContain("No provider configured");
  });
});
