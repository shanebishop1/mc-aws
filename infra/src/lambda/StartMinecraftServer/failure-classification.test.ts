import { describe, expect, it } from "vitest";
import { RetryableLifecycleError, TerminalLifecycleError, classifyLifecycleFailure } from "./failure-classification.js";

describe("lifecycle failure classification", () => {
  it.each(["ThrottlingException", "ServiceUnavailable", "RequestTimeout"])("retries transient %s failures", (name) => {
    expect(classifyLifecycleFailure(Object.assign(new Error(name), { name }))).toMatchObject({ retryable: true });
  });

  it("retries unresolved side effects while retaining lock ownership", () => {
    expect(classifyLifecycleFailure(new RetryableLifecycleError("unknown", { retainLifecycleLock: true }))).toEqual({
      retryable: true,
      retainLock: true,
      code: "retryable_lifecycle_failure",
    });
  });

  it("acknowledges tagged business and confirmed remote failures as terminal", () => {
    expect(classifyLifecycleFailure(new TerminalLifecycleError("invalid"))).toMatchObject({ retryable: false });
    expect(classifyLifecycleFailure(Object.assign(new Error("script failed"), { ssmTerminal: true }))).toMatchObject({
      retryable: false,
    });
  });
});
