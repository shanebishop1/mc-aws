import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type CheckId = "S1" | "S2" | "S3" | "S4" | "S5";
type CheckStatus = "pass" | "fail" | "skipped";
type RoutingHint = "credentials/config" | "runtime-state/deploy" | "service/runtime";

interface CheckResult {
  id: CheckId;
  label: string;
  status: CheckStatus;
  primarySignal: string;
  failureHint: string;
  routingHint?: RoutingHint;
}

interface SmokeConfig {
  baseUrl: string;
  environmentLabel: string;
  sessionCookie: string;
  expectedBackendMode: "aws" | "mock";
  expectedDomain: string;
  requestTimeoutMs: number;
  enableOptionalEnvironmentProbe: boolean;
  requireOptionalEnvironmentProbe: boolean;
  summaryOutputPath: string | null;
}

const DEFAULT_SUMMARY_PATH = "artifacts/real-environment-smoke-summary.md";
const placeholderValues = new Set(["", "changeme", "placeholder", "example", "your-value", "replace-me"]);

const getRequiredEnv = (name: string): string => {
  const value = process.env[name]?.trim() ?? "";

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  if (placeholderValues.has(value.toLowerCase())) {
    throw new Error(`Environment variable ${name} still contains a placeholder value.`);
  }

  return value;
};

const getBooleanEnv = (name: string, defaultValue: boolean): boolean => {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return defaultValue;
  }

  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }

  throw new Error(`Invalid boolean value for ${name}.`);
};

const getBoundedIntegerEnv = (name: string, defaultValue: number, minimum: number, maximum: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
};

const getRoutingHint = (results: CheckResult[]): RoutingHint | "none" => {
  const failed = results.find((result) => result.status === "fail" && result.routingHint);
  return failed?.routingHint ?? "none";
};

const checkSignalNames: Record<CheckId, string> = {
  S1: "authenticated",
  S2: "real backend",
  S3: "service",
  S4: "runtime binding",
  S5: "optional environment",
};

const fixedSignal = (result: CheckResult): string => {
  const outcome = result.status === "pass" ? "passed" : result.status === "fail" ? "failed" : "skipped";
  return `${checkSignalNames[result.id]} contract ${outcome}`;
};

const fixedFailureHint = (result: CheckResult): string => {
  if (result.status === "pass") return "-";
  if (result.status === "skipped") return "Optional contract was not required or an earlier required contract failed.";
  const hints: Record<CheckId, string> = {
    S1: "Verify smoke credentials and required workflow configuration.",
    S2: "Check backend mode, AWS authentication, and status dependencies.",
    S3: "Check read-only SSM permissions and service-status wiring.",
    S4: "Check runtime-state bindings and runtime configuration.",
    S5: "The optional environment contract is configured as required.",
  };
  return hints[result.id];
};

const toCookieHeader = (rawCookieValue: string): string => {
  if (rawCookieValue.startsWith("mc_session=")) {
    return rawCookieValue;
  }

  return `mc_session=${rawCookieValue}`;
};

const parseJsonResponse = async (response: Response): Promise<unknown> => {
  const body = await response.text();

  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`Expected JSON response but received non-JSON body (HTTP ${response.status}).`);
  }
};

export const buildSummary = (results: CheckResult[]): string => {
  // A failed S5 is emitted only when SMOKE_REQUIRE_S5_ENVIRONMENT_PROBE=true;
  // a non-blocking S5 failure is represented as skipped.
  const hasRequiredFailure = results.some(
    (result) => result.status === "fail" || (result.id !== "S5" && result.status !== "pass")
  );
  const overallVerdict = hasRequiredFailure ? "FAIL" : "PASS";
  const routingHint = getRoutingHint(results);

  const rows = results.map((result) => {
    return `| ${result.id} | ${result.status} | ${fixedSignal(result)} | ${fixedFailureHint(result)} |`;
  });

  return [
    "## Real-environment smoke summary",
    "",
    `- Overall verdict: **${overallVerdict}**`,
    `- Failure routing hint: **${routingHint}**`,
    "",
    "| Check | Status | Primary signal | Failure hint |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "Status values: `pass`, `fail`, `skipped` (`skipped` is only valid for optional S5).",
  ].join("\n");
};

const appendStepSummary = (summary: string): void => {
  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;

  if (!stepSummaryPath) {
    return;
  }

  writeFileSync(stepSummaryPath, `${summary}\n`, { encoding: "utf8", flag: "a" });
};

const writeArtifactSummary = (summary: string, summaryOutputPath: string | null): void => {
  const targetPath = summaryOutputPath?.trim() || DEFAULT_SUMMARY_PATH;
  const absolutePath = path.resolve(process.cwd(), targetPath);
  const parentDir = path.dirname(absolutePath);

  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  writeFileSync(absolutePath, `${summary}\n`, "utf8");
};

const loadConfig = (): SmokeConfig => {
  const rawExpectedBackendMode = process.env.SMOKE_EXPECT_BACKEND_MODE?.trim().toLowerCase() ?? "aws";
  if (rawExpectedBackendMode !== "aws" && rawExpectedBackendMode !== "mock") {
    throw new Error('SMOKE_EXPECT_BACKEND_MODE must be either "aws" or "mock".');
  }

  return {
    baseUrl: getRequiredEnv("SMOKE_BASE_URL").replace(/\/$/, ""),
    environmentLabel: getRequiredEnv("SMOKE_ENVIRONMENT_LABEL"),
    sessionCookie: toCookieHeader(getRequiredEnv("SMOKE_SESSION_COOKIE")),
    expectedBackendMode: rawExpectedBackendMode,
    expectedDomain: getRequiredEnv("SMOKE_EXPECT_DOMAIN").toLowerCase(),
    requestTimeoutMs: getBoundedIntegerEnv("SMOKE_REQUEST_TIMEOUT_MS", 15_000, 100, 120_000),
    enableOptionalEnvironmentProbe: getBooleanEnv("SMOKE_ENABLE_S5_ENVIRONMENT_PROBE", false),
    requireOptionalEnvironmentProbe: getBooleanEnv("SMOKE_REQUIRE_S5_ENVIRONMENT_PROBE", false),
    summaryOutputPath: process.env.SMOKE_SUMMARY_OUTPUT_PATH?.trim() || null,
  };
};

const fetchSmoke = async (
  config: SmokeConfig,
  routePath: string
): Promise<{ response: Response; payload: Record<string, unknown> }> => {
  const response = await fetch(`${config.baseUrl}${routePath}`, {
    method: "GET",
    headers: {
      Cookie: config.sessionCookie,
      Accept: "application/json",
      "User-Agent": "mc-aws-real-smoke-workflow/1.0",
    },
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });

  const parsed = await parseJsonResponse(response);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid response contract for ${routePath}: expected JSON object.`);
  }

  return {
    response,
    payload: parsed as Record<string, unknown>,
  };
};

const validateDomainSignal = (data: Record<string, unknown>, expectedDomain: string): void => {
  const domain = data.domain;
  const state = data.state;
  const nonRunningStates = new Set(["stopped", "hibernating", "pending", "stopping", "terminated", "unknown"]);
  if (typeof domain === "undefined" && typeof state === "string" && nonRunningStates.has(state)) return;
  if (typeof domain !== "string" || domain.trim().toLowerCase() !== expectedDomain) {
    throw new Error("Configured domain does not match the status response.");
  }
};

const finalizeSmokeRun = (config: SmokeConfig, results: CheckResult[]): number => {
  const summary = buildSummary(results);
  appendStepSummary(summary);
  writeArtifactSummary(summary, config.summaryOutputPath);

  const hasRequiredFailure = results.filter((result) => result.id !== "S5").some((result) => result.status !== "pass");
  const hasRequiredOptionalFailure = results.some((result) => result.id === "S5" && result.status === "fail");
  return hasRequiredFailure || hasRequiredOptionalFailure ? 1 : 0;
};

const pushBlockedChecks = (
  results: CheckResult[],
  checkIds: readonly CheckId[],
  cause: string,
  routingHint: RoutingHint
): void => {
  for (const blockedId of checkIds) {
    results.push({
      id: blockedId,
      label: `Blocked due to ${cause}`,
      status: "fail",
      primarySignal: "not executed",
      failureHint: "Required check blocked by prior required failure.",
      routingHint,
    });
  }
};

const pushOptionalSkipped = (results: CheckResult[], reason: string): void => {
  results.push({
    id: "S5",
    label: "Optional backup/environment read probe",
    status: "skipped",
    primarySignal: reason,
    failureHint: "S5 skipped by configuration or due to earlier required failure.",
  });
};

const runS1 = async (config: SmokeConfig): Promise<CheckResult> => {
  try {
    const { response, payload } = await fetchSmoke(config, "/api/auth/me");
    const authenticated = payload.authenticated;
    const role = payload.role;
    const email = payload.email;

    if (!response.ok) {
      throw new Error(`Auth bootstrap probe returned HTTP ${response.status}.`);
    }

    if (authenticated !== true || typeof role !== "string" || typeof email !== "string") {
      throw new Error("Auth bootstrap payload does not indicate authenticated session.");
    }

    return {
      id: "S1",
      label: "Environment/auth bootstrap sanity",
      status: "pass",
      primarySignal: "authenticated contract passed",
      failureHint: "-",
    };
  } catch {
    return {
      id: "S1",
      label: "Environment/auth bootstrap sanity",
      status: "fail",
      primarySignal: "authenticated contract failed",
      failureHint: "Verify smoke auth secret/cookie and required workflow env values.",
      routingHint: "credentials/config",
    };
  }
};

const runS2 = async (config: SmokeConfig): Promise<CheckResult> => {
  try {
    const { response, payload } = await fetchSmoke(config, "/api/status");
    if (!response.ok) {
      throw new Error(`/api/status returned HTTP ${response.status}.`);
    }

    const success = payload.success;
    const data = payload.data;
    if (success !== true || !data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("/api/status payload contract mismatch.");
    }

    const instanceId = (data as Record<string, unknown>).instanceId;
    if (typeof instanceId !== "string" || !instanceId || instanceId === "redacted") {
      throw new Error("/api/status did not return an authenticated real instance id.");
    }

    const appearsMock = instanceId.toLowerCase().includes("mock");
    if (config.expectedBackendMode === "aws" && appearsMock) {
      throw new Error("Status response indicates the mock backend.");
    }

    return {
      id: "S2",
      label: "Real backend status read",
      status: "pass",
      primarySignal: "real backend contract passed",
      failureHint: "-",
    };
  } catch {
    return {
      id: "S2",
      label: "Real backend status read",
      status: "fail",
      primarySignal: "real backend contract failed",
      failureHint: "Check backend mode, AWS auth, and status route runtime dependencies.",
      routingHint: "service/runtime",
    };
  }
};

const runS3 = async (config: SmokeConfig): Promise<CheckResult> => {
  try {
    const { response, payload } = await fetchSmoke(config, "/api/service-status");
    if (!response.ok) {
      throw new Error(`/api/service-status returned HTTP ${response.status}.`);
    }

    const success = payload.success;
    const data = payload.data;
    if (success !== true || !data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("/api/service-status payload contract mismatch.");
    }

    const serviceActive = (data as Record<string, unknown>).serviceActive;
    const instanceRunning = (data as Record<string, unknown>).instanceRunning;
    if (typeof serviceActive !== "boolean" || typeof instanceRunning !== "boolean") {
      throw new Error("/api/service-status response shape is invalid.");
    }

    return {
      id: "S3",
      label: "Safe operation path verification",
      status: "pass",
      primarySignal: "service contract passed",
      failureHint: "-",
    };
  } catch {
    return {
      id: "S3",
      label: "Safe operation path verification",
      status: "fail",
      primarySignal: "service contract failed",
      failureHint: "Check read-only SSM permissions and service-status path wiring.",
      routingHint: "service/runtime",
    };
  }
};

const runS4 = async (config: SmokeConfig): Promise<CheckResult> => {
  try {
    const firstStatus = await fetchSmoke(config, "/api/status?refresh=1");
    const secondStatus = await fetchSmoke(config, "/api/status");
    const stackStatus = await fetchSmoke(config, "/api/stack-status");

    if (!firstStatus.response.ok || !secondStatus.response.ok || !stackStatus.response.ok) {
      throw new Error(
        `Probe returned non-2xx (status=${firstStatus.response.status}/${secondStatus.response.status}, stack=${stackStatus.response.status}).`
      );
    }

    const firstData = firstStatus.payload.data;
    if (!firstData || typeof firstData !== "object" || Array.isArray(firstData)) {
      throw new Error("/api/status payload missing data object for binding probe.");
    }

    const writeSignal = firstStatus.response.headers.get("x-status-cache") ?? "";
    const readSignal = secondStatus.response.headers.get("x-status-cache") ?? "";
    const writeProbe = firstStatus.response.headers.get("x-status-refresh-probe") ?? "";
    const readProbe = secondStatus.response.headers.get("x-status-refresh-probe") ?? "";
    if (
      writeSignal !== "MISS" ||
      readSignal !== "HIT" ||
      !/^[a-f0-9]{32}$/.test(writeProbe) ||
      readProbe !== writeProbe
    ) {
      throw new Error(
        `/api/status did not prove a runtime-state write/read round trip (refresh=${writeSignal || "absent"}, read=${readSignal || "absent"}).`
      );
    }

    if (stackStatus.payload.success !== true) {
      throw new Error("/api/stack-status did not return success payload.");
    }

    validateDomainSignal(firstData as Record<string, unknown>, config.expectedDomain);

    return {
      id: "S4",
      label: "Runtime-state + DNS/binding health probe",
      status: "pass",
      primarySignal: "runtime binding contract passed",
      failureHint: "-",
    };
  } catch {
    return {
      id: "S4",
      label: "Runtime-state + DNS/binding health probe",
      status: "fail",
      primarySignal: "runtime binding contract failed",
      failureHint: "Check runtime-state bindings/migrations and domain/runtime config consistency.",
      routingHint: "runtime-state/deploy",
    };
  }
};

const runS5 = async (config: SmokeConfig): Promise<CheckResult> => {
  if (!config.enableOptionalEnvironmentProbe) {
    return {
      id: "S5",
      label: "Optional backup/environment read probe",
      status: "skipped",
      primarySignal: "optional environment contract skipped",
      failureHint: "Optional probe intentionally disabled.",
    };
  }

  try {
    const { response, payload } = await fetchSmoke(config, "/api/costs");
    if (!response.ok) {
      throw new Error(`/api/costs returned HTTP ${response.status}.`);
    }

    const success = payload.success;
    const data = payload.data;
    if (success !== true || !data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("/api/costs payload contract mismatch.");
    }

    const totalCost = (data as Record<string, unknown>).totalCost;
    if (typeof totalCost !== "string" || totalCost.trim().length === 0) {
      throw new Error("/api/costs missing string totalCost.");
    }

    return {
      id: "S5",
      label: "Optional backup/environment read probe",
      status: "pass",
      primarySignal: "optional environment contract passed",
      failureHint: "-",
    };
  } catch {
    if (config.requireOptionalEnvironmentProbe) {
      return {
        id: "S5",
        label: "Optional backup/environment read probe",
        status: "fail",
        primarySignal: "optional environment contract failed",
        failureHint: "Optional probe marked required by SMOKE_REQUIRE_S5_ENVIRONMENT_PROBE=true.",
        routingHint: "service/runtime",
      };
    }

    return {
      id: "S5",
      label: "Optional backup/environment read probe",
      status: "skipped",
      primarySignal: "optional environment contract skipped",
      failureHint: "Optional probe failed but is configured as non-blocking.",
    };
  }
};

const fallbackConfig = (): SmokeConfig => {
  return {
    baseUrl: "unknown",
    environmentLabel: process.env.SMOKE_ENVIRONMENT_LABEL?.trim() || "unknown",
    sessionCookie: "redacted",
    expectedBackendMode: "aws",
    expectedDomain: "",
    requestTimeoutMs: 15_000,
    enableOptionalEnvironmentProbe: false,
    requireOptionalEnvironmentProbe: false,
    summaryOutputPath: process.env.SMOKE_SUMMARY_OUTPUT_PATH?.trim() || null,
  };
};

export const runSmoke = async (): Promise<number> => {
  const results: CheckResult[] = [];

  let config: SmokeConfig;
  try {
    config = loadConfig();
  } catch {
    results.push({
      id: "S1",
      label: "Environment/auth bootstrap sanity",
      status: "fail",
      primarySignal: "authenticated contract failed",
      failureHint: "Populate required smoke env/secrets (base URL, environment label, session cookie).",
      routingHint: "credentials/config",
    });
    pushBlockedChecks(results, ["S2", "S3", "S4"], "S1 failure", "credentials/config");
    pushOptionalSkipped(results, "S1 bootstrap failed");
    return finalizeSmokeRun(fallbackConfig(), results);
  }

  const requiredChecks = [runS1, runS2, runS3, runS4] as const;
  const checkIdsByOrder: CheckId[] = ["S1", "S2", "S3", "S4"];

  for (const [index, check] of requiredChecks.entries()) {
    const result = await check(config);
    results.push(result);

    if (result.status !== "pass") {
      const remaining = checkIdsByOrder.slice(index + 1);
      pushBlockedChecks(results, remaining, `${result.id} failure`, result.routingHint ?? "service/runtime");
      pushOptionalSkipped(results, "Required checks failed before optional probe");
      return finalizeSmokeRun(config, results);
    }
  }

  results.push(await runS5(config));
  return finalizeSmokeRun(config, results);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runSmoke().then((exitCode) => {
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  });
}
