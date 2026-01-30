#!/usr/bin/env node
/**
 * Validate Dev Login in Mock Mode
 *
 * This script tests the end-to-end dev login flow:
 * 1. Checks environment variables are set correctly
 * 2. Validates dev login endpoint is accessible
 * 3. Verifies session cookie is set
 * 4. Confirms authentication works
 * 5. Tests protected routes
 *
 * Usage:
 *   MC_BACKEND_MODE=mock ENABLE_DEV_LOGIN=true node scripts/validate-dev-login.ts
 */

import http from "node:http";

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
};

function log(message: string, color: keyof typeof colors = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function success(message: string) {
  log(`✓ ${message}`, "green");
}

function error(message: string) {
  log(`✗ ${message}`, "red");
}

function info(message: string) {
  log(`ℹ ${message}`, "blue");
}

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
}

const results: TestResult[] = [];
let sessionCookie = "";

function recordTest(name: string, passed: boolean, message: string) {
  results.push({ name, passed, message });
  if (passed) {
    success(message);
  } else {
    error(message);
  }
}

async function makeRequest(
  path: string,
  method = "GET",
  headers: Record<string, string> = {}
): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "localhost",
      port: 3001,
      path,
      method,
      headers,
    };

    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 500,
          headers: res.headers,
          body,
        });
      });
    });

    req.on("error", reject);
    req.end();
  });
}

async function runTests() {
  log("\n=== Dev Login Validation Tests ===\n", "blue");

  // Test 1: Check environment variables
  info("Checking environment variables...");
  const backendMode = process.env.MC_BACKEND_MODE;
  const enableDevLogin = process.env.ENABLE_DEV_LOGIN;

  recordTest(
    "MC_BACKEND_MODE",
    backendMode === "mock",
    backendMode === "mock"
      ? "MC_BACKEND_MODE is set to 'mock'"
      : `MC_BACKEND_MODE is '${backendMode}' (expected 'mock')`
  );

  recordTest(
    "ENABLE_DEV_LOGIN",
    enableDevLogin === "true",
    enableDevLogin === "true"
      ? "ENABLE_DEV_LOGIN is set to 'true'"
      : `ENABLE_DEV_LOGIN is '${enableDevLogin}' (expected 'true')`
  );

  recordTest(
    "AUTH_SECRET",
    !!process.env.AUTH_SECRET && process.env.AUTH_SECRET.length > 0,
    process.env.AUTH_SECRET ? `AUTH_SECRET is set (${process.env.AUTH_SECRET.length} chars)` : "AUTH_SECRET is not set"
  );

  // Test 2: Check if dev server is running
  info("\nChecking if dev server is running...");
  try {
    const response = await makeRequest("/");
    recordTest(
      "Dev server running",
      response.statusCode === 200,
      `Dev server is running (status ${response.statusCode})`
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    recordTest("Dev server running", false, `Dev server is not running: ${errorMessage}`);
    log("\n❌ Cannot continue tests without dev server running.\n", "red");
    log("Start it with: pnpm dev:mock\n", "blue");
    printSummary();
    process.exit(1);
  }

  // Test 3: Check auth status before login
  info("\nChecking authentication status before login...");
  try {
    const response = await makeRequest("/api/auth/me");
    const data = JSON.parse(response.body);

    recordTest(
      "Not authenticated before login",
      data.authenticated === false,
      data.authenticated === false
        ? "User is not authenticated (as expected)"
        : "User is authenticated (unexpected - may have existing session)"
    );
  } catch (err) {
    recordTest("Auth status check", false, `Failed to check auth status: ${err}`);
  }

  // Test 3: Check auth status before login
  info("\nChecking authentication status before login...");
  try {
    const response = await makeRequest("/api/auth/me");
    const data = JSON.parse(response.body);

    recordTest(
      "Not authenticated before login",
      data.authenticated === false,
      data.authenticated === false
        ? "User is not authenticated (as expected)"
        : "User is authenticated (unexpected - may have existing session)"
    );
  } catch (err) {
    recordTest("Auth status check", false, `Failed to check auth status: ${err}`);
  }

  // Test 4: Visit dev login endpoint
  info("\nTesting dev login endpoint...");
  try {
    const response = await makeRequest("/api/auth/dev-login", "GET");

    if (response.statusCode === 403) {
      recordTest("Dev login endpoint", false, "Dev login returned 403 - check ENABLE_DEV_LOGIN=true is set");
    } else if (response.statusCode === 404) {
      recordTest("Dev login endpoint", false, "Dev login returned 404 - check NODE_ENV is not 'production'");
    } else if (response.statusCode === 302 || response.statusCode === 307) {
      // Redirect is expected
      const setCookieHeader = response.headers["set-cookie"];
      const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
      const hasSessionCookie = cookies.some((c: string) => c.startsWith("mc_session="));

      recordTest("Dev login endpoint", true, `Dev login returned ${response.statusCode} (redirect)`);

      recordTest(
        "Session cookie set",
        hasSessionCookie,
        hasSessionCookie ? "Session cookie was set" : "Session cookie was not set"
      );

      // Extract session cookie for next test
      if (setCookieHeader) {
        const cookieMatch = cookies.find((c: string) => c.startsWith("mc_session="));
        if (cookieMatch) {
          sessionCookie = cookieMatch.split(";")[0];
        }
      }

      // Test 5: Check auth status after login
      info("\nChecking authentication status after login...");
      try {
        const authResponse = await makeRequest("/api/auth/me", "GET", {
          Cookie: sessionCookie,
        });
        const authData = JSON.parse(authResponse.body);

        recordTest(
          "Authenticated after login",
          authData.authenticated === true,
          authData.authenticated === true
            ? `User is authenticated as ${authData.email} (${authData.role})`
            : "User is not authenticated after login"
        );

        recordTest(
          "Correct user role",
          authData.role === "admin",
          authData.role === "admin" ? "User has admin role" : `User has role '${authData.role}' (expected 'admin')`
        );

        recordTest(
          "Correct email",
          authData.email === "dev@localhost",
          authData.email === "dev@localhost"
            ? "User email is dev@localhost"
            : `User email is '${authData.email}' (expected 'dev@localhost')`
        );
      } catch (err) {
        recordTest("Auth status after login", false, `Failed to check auth status: ${err}`);
      }

      // Test 6: Test a protected route
      info("\nTesting protected route access...");
      try {
        const statusResponse = await makeRequest("/api/status", "GET", {
          Cookie: sessionCookie,
        });
        const statusData = JSON.parse(statusResponse.body);

        recordTest(
          "Protected route accessible",
          statusResponse.statusCode === 200,
          statusResponse.statusCode === 200
            ? "Protected route /api/status is accessible"
            : `Protected route returned ${statusResponse.statusCode}`
        );

        recordTest(
          "Status response has expected structure",
          statusData.success === true && typeof statusData.data === "object",
          statusData.success === true && typeof statusData.data === "object"
            ? "Status response has correct structure"
            : "Status response structure is incorrect"
        );
      } catch (err) {
        recordTest("Protected route access", false, `Failed to access protected route: ${err}`);
      }
    } else {
      recordTest("Dev login endpoint", false, `Dev login returned unexpected status ${response.statusCode}`);
    }
  } catch (err) {
    recordTest("Dev login endpoint", false, `Failed to access dev login: ${err}`);
  }

  // Test 7: Test logout
  info("\nTesting logout...");
  try {
    const logoutResponse = await makeRequest("/api/auth/logout", "POST");
    const logoutData = JSON.parse(logoutResponse.body);

    recordTest(
      "Logout endpoint",
      logoutResponse.statusCode === 200 && logoutData.success === true,
      logoutResponse.statusCode === 200 && logoutData.success === true
        ? "Logout successful"
        : `Logout failed: ${logoutResponse.statusCode}`
    );
  } catch (err) {
    recordTest("Logout endpoint", false, `Failed to logout: ${err}`);
  }

  printSummary();
}

function printSummary() {
  log("\n=== Test Summary ===\n", "blue");

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  results.forEach((result) => {
    const icon = result.passed ? "✓" : "✗";
    const color = result.passed ? "green" : "red";
    log(`${icon} ${result.name}`, color);
  });

  log(`\n${passed}/${total} tests passed`, passed === total ? "green" : "yellow");

  if (failed > 0) {
    log(`\n${failed} test(s) failed. See details above.`, "red");
    process.exit(1);
  } else {
    log("\n🎉 All tests passed! Dev login is working correctly.", "green");
    process.exit(0);
  }
}

// Run tests
runTests().catch((err) => {
  error(`Unexpected error: ${err}`);
  process.exit(1);
});
