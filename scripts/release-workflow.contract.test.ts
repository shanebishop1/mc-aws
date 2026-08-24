import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(path.join(process.cwd(), ".github/workflows/publish-release.yml"), "utf8");

describe("privileged release workflow contract", () => {
  it("is gated to successful validated pushes on this repository's main branch", () => {
    expect(workflow).toContain('workflows: ["Baseline Validation"]');
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(workflow).toContain("head_repository.full_name == github.repository");
  });

  it("checks out only the validated SHA without persisted credentials", () => {
    expect(workflow).toContain("ref: ${{ github.event.workflow_run.head_sha }}");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("fetch-tags: true");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain('subprocess.check_output(["git", "rev-parse", "HEAD"]');
  });

  it("uses least privilege, pinned actions, and never installs repository code", () => {
    expect(workflow).toContain("permissions: {}\n");
    expect(workflow).toContain("contents: write");
    expect(workflow).not.toMatch(/(?:npm|pnpm|yarn) (?:install|ci)/);
    for (const use of workflow.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)) {
      expect(use[1]).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("compares strict SemVer against parent and complete repository release state", () => {
    expect(workflow).toContain("current_parts <= parent_parts");
    expect(workflow).toContain('subprocess.check_output(["git", "tag", "--list"]');
    expect(workflow).toContain("releases?per_page=100");
    expect(workflow).toContain("highest_name = max(repository_versions");
    expect(workflow).toContain("current_parts <= highest_parts");
    expect(workflow).toContain("current_parts < highest_parts");
    expect(workflow).toContain("is behind highest repository version");
    expect(workflow).toContain('tag = f"v{current}"');
  });

  it("recovers skipped validations while requiring a normal parent version bump", () => {
    expect(workflow).toContain("elif parent_changed:");
    expect(workflow).toContain('["git", "rev-list", "--first-parent", "HEAD^"]');
    expect(workflow).toContain("above_repository_state = highest_parts is None or current_parts > highest_parts");
    expect(workflow).toContain("current_parts > prior_version[1]");
    expect(workflow).toContain('action = "create"');
    expect(workflow).toContain("recovering unpublished");
  });

  it("supports idempotent and partial publication recovery without moving tags", () => {
    expect(workflow).toContain('action = "idempotent"');
    expect(workflow).toContain('action = "release-existing-tag"');
    expect(workflow).toContain("not validated SHA {sha}; refusing to move it");
    expect(workflow).toContain('"repos/$GITHUB_REPOSITORY/git/refs"');
    expect(workflow).toContain('--raw-field "sha=$VALIDATED_SHA"');
    expect(workflow).toContain("--verify-tag");
    expect(workflow).toContain("--generate-notes");
  });
});
