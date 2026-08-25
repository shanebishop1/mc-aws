import { describe, expect, it, vi } from "vitest";
import { pollBackups } from "./backups-polling";

describe("pollBackups", () => {
  it("returns a completed backup list", async () => {
    const check = vi.fn().mockResolvedValue({ backups: [{ name: "backup.tar.gz" }], count: 1, status: "listing" });

    await expect(pollBackups(check, { delay: vi.fn() })).resolves.toMatchObject({ status: "listing", count: 1 });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("stops immediately with the safe asynchronous failure", async () => {
    const check = vi.fn().mockResolvedValue({
      backups: [],
      count: 0,
      status: "error",
      errorMessage: "Drive backup listing is temporarily unavailable.",
    });

    await expect(pollBackups(check, { delay: vi.fn() })).rejects.toThrow(
      "Drive backup listing is temporarily unavailable."
    );
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("fails usefully after the bounded pending poll budget", async () => {
    const check = vi.fn().mockResolvedValue({ backups: [], count: 0, status: "caching" });
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(pollBackups(check, { maxAttempts: 2, intervalMs: 1, delay })).rejects.toThrow(
      "Backup listing is still pending"
    );
    expect(check).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
  });
});
