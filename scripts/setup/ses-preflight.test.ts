import { describe, expect, it, vi } from "vitest";
import {
  type SesInboundPreflightConfig,
  type SesInboundPreflightDependencies,
  runSesInboundPreflight,
} from "./ses-preflight";

const enabledConfig: SesInboundPreflightConfig = {
  enabled: "true",
  region: "us-east-1",
  recipient: "start@commands.example.com",
  ruleSetName: "inbound-rules",
  startKeyword: "never-log-this",
};

function dependencies(overrides: Partial<SesInboundPreflightDependencies> = {}): SesInboundPreflightDependencies {
  return {
    getDomainVerificationStatus: vi.fn().mockResolvedValue("Success"),
    getActiveRuleSetName: vi.fn().mockResolvedValue("inbound-rules"),
    resolveMx: vi.fn().mockResolvedValue([{ exchange: "INBOUND-SMTP.US-EAST-1.AMAZONAWS.COM.", priority: 10 }]),
    log: vi.fn(),
    ...overrides,
  };
}

describe("SES inbound-command preflight", () => {
  it("explicitly skips without reading AWS or DNS when inbound commands are disabled", async () => {
    const deps = dependencies();

    await runSesInboundPreflight({ ...enabledConfig, enabled: "false" }, deps);

    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("preflight skipped"));
    expect(deps.getDomainVerificationStatus).not.toHaveBeenCalled();
    expect(deps.resolveMx).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   ", "false", "FALSE"])("accepts disabled value %j", async (enabled) => {
    const deps = dependencies();

    await runSesInboundPreflight({ ...enabledConfig, enabled }, deps);

    expect(deps.getDomainVerificationStatus).not.toHaveBeenCalled();
  });

  it.each(["true", "TRUE", "TrUe"])("accepts exact case-insensitive enabled value %j", async (enabled) => {
    const deps = dependencies();

    await runSesInboundPreflight({ ...enabledConfig, enabled }, deps);

    expect(deps.getDomainVerificationStatus).toHaveBeenCalledOnce();
  });

  it.each(["yes", "1", "enabled", "falsey", " true ", " false "])(
    "rejects invalid enabled value %j",
    async (enabled) => {
      const deps = dependencies();

      await expect(runSesInboundPreflight({ ...enabledConfig, enabled }, deps)).rejects.toThrow(
        'SES_INBOUND_COMMANDS_ENABLED must be blank, "false", or "true"'
      );
      expect(deps.getDomainVerificationStatus).not.toHaveBeenCalled();
      expect(deps.resolveMx).not.toHaveBeenCalled();
    }
  );

  it("passes a verified exact domain, matching active rule set, and normalized same-region MX", async () => {
    const deps = dependencies();

    await runSesInboundPreflight(enabledConfig, deps);

    expect(deps.getDomainVerificationStatus).toHaveBeenCalledWith("us-east-1", "commands.example.com");
    expect(deps.getActiveRuleSetName).toHaveBeenCalledWith("us-east-1");
    expect(deps.resolveMx).toHaveBeenCalledWith("commands.example.com");
    expect(deps.log).toHaveBeenCalledWith(
      "SES inbound-command preflight passed for commands.example.com in us-east-1."
    );
  });

  it("fails closed when the exact domain identity is unverified", async () => {
    const deps = dependencies({ getDomainVerificationStatus: vi.fn().mockResolvedValue("Pending") });

    await expect(runSesInboundPreflight(enabledConfig, deps)).rejects.toThrow(
      "exact recipient domain commands.example.com is not a verified SES identity"
    );
  });

  it.each([
    [undefined, "none"],
    ["other-rules", '"other-rules"'],
  ])("rejects an inactive or wrong active rule set (%s)", async (activeName, expected) => {
    const deps = dependencies({ getActiveRuleSetName: vi.fn().mockResolvedValue(activeName) });

    await expect(runSesInboundPreflight(enabledConfig, deps)).rejects.toThrow(
      `active SES receipt rule set is ${expected}`
    );
  });

  it("rejects a wrong MX target", async () => {
    const deps = dependencies({
      resolveMx: vi.fn().mockResolvedValue([{ exchange: "inbound-smtp.us-west-2.amazonaws.com", priority: 10 }]),
    });

    await expect(runSesInboundPreflight(enabledConfig, deps)).rejects.toThrow(
      "must use inbound-smtp.us-east-1.amazonaws.com as the sole exchange at the lowest numeric priority"
    );
  });

  it.each([
    ["lower", 5],
    ["equal", 10],
  ])("rejects a competing non-SES MX at %s priority", async (_label, priority) => {
    const deps = dependencies({
      resolveMx: vi.fn().mockResolvedValue([
        { exchange: "inbound-smtp.us-east-1.amazonaws.com", priority: 10 },
        { exchange: "mail.example.com", priority },
      ]),
    });

    await expect(runSesInboundPreflight(enabledConfig, deps)).rejects.toThrow(
      "competing exchanges are allowed only at strictly higher numeric priorities"
    );
  });

  it("accepts a competing fallback MX at a strictly higher numeric priority", async () => {
    const deps = dependencies({
      resolveMx: vi.fn().mockResolvedValue([
        { exchange: "inbound-smtp.us-east-1.amazonaws.com", priority: 10 },
        { exchange: "fallback.example.com", priority: 20 },
      ]),
    });

    await expect(runSesInboundPreflight(enabledConfig, deps)).resolves.toBeUndefined();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("rejects invalid MX priority %s", async (priority) => {
    const deps = dependencies({
      resolveMx: vi.fn().mockResolvedValue([{ exchange: "inbound-smtp.us-east-1.amazonaws.com", priority }]),
    });

    await expect(runSesInboundPreflight(enabledConfig, deps)).rejects.toThrow(
      "priorities must be finite and nonnegative"
    );
  });

  it("rejects a missing or unreadable MX record", async () => {
    const deps = dependencies({ resolveMx: vi.fn().mockRejectedValue(new Error("ENODATA")) });

    await expect(runSesInboundPreflight(enabledConfig, deps)).rejects.toThrow(
      "No readable MX record was found for commands.example.com"
    );
  });

  it("rejects an empty keyword without printing it or reading AWS/DNS", async () => {
    const deps = dependencies();

    await expect(runSesInboundPreflight({ ...enabledConfig, startKeyword: "  " }, deps)).rejects.toThrow(
      "START_KEYWORD must be nonempty"
    );
    expect(deps.getDomainVerificationStatus).not.toHaveBeenCalled();
    expect(deps.resolveMx).not.toHaveBeenCalled();
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining("never-log-this"));
  });
});
