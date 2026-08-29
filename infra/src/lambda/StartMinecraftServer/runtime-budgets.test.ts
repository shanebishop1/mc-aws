import { describe, expect, it } from "vitest";
import {
  BACKUPS_REFRESH_SSM_MAX_ATTEMPTS,
  HIBERNATE_BACKUP_SSM_MAX_ATTEMPTS,
  INSTANCE_STATE_MAX_ATTEMPTS,
  INSTANCE_STATE_POLL_INTERVAL_MS,
  LAMBDA_FINALIZATION_MARGIN_MS,
  PUBLIC_IP_MAX_ATTEMPTS,
  PUBLIC_IP_POLL_INTERVAL_MS,
  READINESS_SSM_MAX_ATTEMPTS,
  RESUME_SSM_MAX_ATTEMPTS,
  SSM_CANCEL_MAX_ATTEMPTS,
  SSM_POLL_INTERVAL_MS,
  SSM_SEND_MAX_ATTEMPTS,
  SSM_SEND_RETRY_INTERVAL_MS,
  VOLUME_DETACH_MAX_ATTEMPTS,
  VOLUME_DETACH_POLL_INTERVAL_MS,
} from "./runtime-budgets.js";

const sendBudget = SSM_SEND_MAX_ATTEMPTS * SSM_SEND_RETRY_INTERVAL_MS;
const cancelBudget = SSM_CANCEL_MAX_ATTEMPTS * SSM_POLL_INTERVAL_MS;
const ssmBudget = (attempts: number) => sendBudget + attempts * SSM_POLL_INTERVAL_MS + cancelBudget;
const instanceBudget = INSTANCE_STATE_MAX_ATTEMPTS * INSTANCE_STATE_POLL_INTERVAL_MS;

describe("lifecycle runtime budgets", () => {
  it("keeps the resume worst case below Lambda's 900-second timeout with finalization margin", () => {
    const reconstructionAndAttach = 60_000 + 30_000;
    const publicIp = PUBLIC_IP_MAX_ATTEMPTS * PUBLIC_IP_POLL_INTERVAL_MS;
    const total =
      reconstructionAndAttach +
      instanceBudget +
      publicIp +
      ssmBudget(RESUME_SSM_MAX_ATTEMPTS) +
      ssmBudget(READINESS_SSM_MAX_ATTEMPTS) +
      LAMBDA_FINALIZATION_MARGIN_MS;
    expect(total).toBeLessThan(900_000);
  });

  it("keeps late hibernate failure recovery below timeout", () => {
    const backup = ssmBudget(HIBERNATE_BACKUP_SSM_MAX_ATTEMPTS);
    const refresh = ssmBudget(BACKUPS_REFRESH_SSM_MAX_ATTEMPTS);
    const detach = VOLUME_DETACH_MAX_ATTEMPTS * VOLUME_DETACH_POLL_INTERVAL_MS;
    const recovery = instanceBudget + detach + instanceBudget + ssmBudget(30);
    expect(backup + refresh + instanceBudget + detach + recovery + LAMBDA_FINALIZATION_MARGIN_MS).toBeLessThan(900_000);
  });
});
