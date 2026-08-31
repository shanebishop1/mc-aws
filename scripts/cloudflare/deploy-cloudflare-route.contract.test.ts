import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Cloudflare route replacement deployment contract", () => {
  const source = readFileSync(path.resolve(process.cwd(), "scripts/cloudflare/deploy-cloudflare.sh"), "utf8");

  it("classifies an exact live route through the validated manifest before deploy", () => {
    expect(source).toContain("manifest_route_state --zone");
    expect(source).toContain('if [[ "$route_state" == "created" ]]');
    expect(source).toContain('PANEL_ROUTE_OWNERSHIP="created"');
    expect(source).toContain("Existing Worker route does not match the validated deployment manifest");
    expect(source).toContain("Missing Worker route does not match the validated deployment manifest");
  });

  it("uses an explicit old-ID transition only after exact post-deploy route verification", () => {
    const patternCheck = source.indexOf(
      'if [[ "$route_pattern" != "$pattern" ]]',
      source.indexOf("capture_panel_route_after_deploy")
    );
    const targetCheck = source.indexOf('if [[ "$route_script" != "$WORKER_NAME" ]]', patternCheck);
    const replacement = source.indexOf('--ownership created --replaces-id "$PANEL_ROUTE_ID"', targetCheck);

    expect(patternCheck).toBeGreaterThan(-1);
    expect(targetCheck).toBeGreaterThan(patternCheck);
    expect(replacement).toBeGreaterThan(targetCheck);
    expect(source).toContain("Worker route ID replaced during deployment");
  });

  it("records route identity after both Worker deployments", () => {
    const calls = [...source.matchAll(/^capture_panel_route_after_deploy$/gm)].map((match) => match.index);
    const bindingRestore = source.indexOf('echo "✅ Worker bindings restored"');

    expect(calls).toHaveLength(2);
    expect(calls[1]).toBeGreaterThan(bindingRestore);
  });
});
