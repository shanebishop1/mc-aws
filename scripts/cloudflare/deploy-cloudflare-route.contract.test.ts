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

  it("removes Wrangler route mutation and performs one pre-journaled explicit create", () => {
    expect(source).not.toContain('helper_args+=(--hostname "$DOMAIN")');
    const journal = source.indexOf('journal_creation_intent route "$operation_id"');
    const post = source.indexOf('cf_api POST "/zones/${CF_ZONE_ID}/workers/routes"');
    expect(journal).toBeGreaterThan(-1);
    expect(journal).toBeLessThan(post);
    expect(source).toContain("route-create-response");
    expect(source).toContain("Worker route ID changed outside the explicit journaled operation");
    expect(source).toContain('manifest route --zone "$CF_ZONE_ID" --id "$route_id"');
    expect(source).not.toContain(
      'manifest route --zone "$CF_ZONE_ID" --pattern "$pattern" --script "$WORKER_NAME" --ownership created'
    );
  });

  it("records route identity after both Worker deployments", () => {
    const calls = [...source.matchAll(/^capture_panel_route_after_deploy$/gm)].map((match) => match.index);
    const bindingRestore = source.indexOf('echo "✅ Worker bindings restored"');

    expect(calls).toHaveLength(2);
    expect(calls[1]).toBeGreaterThan(bindingRestore);
  });
});
