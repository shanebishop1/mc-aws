import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isolatedBuildEnvironment,
  productionBuildNamespaceArguments,
  spawnIsolatedBuildChild,
} from "./build-child-isolation";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "mc-aws-build-child-"));
  roots.push(root);
  const preloadDir = path.join(root, "scripts/validation");
  mkdirSync(preloadDir, { recursive: true });
  writeFileSync(path.join(preloadDir, "deny-build-network.cjs"), '"use strict";\n');
  return {
    root,
    home: path.join(root, "isolated-home"),
    tmp: path.join(root, "isolated-tmp"),
  };
};

describe("build child process isolation", () => {
  it("uses a minimal environment, private synthetic HOME, and no inherited dotenv descriptor", () => {
    const item = fixture();
    const dotenv = path.join(item.root, "deployment.env");
    writeFileSync(dotenv, "CLOUDFLARE_DEPLOY_API_TOKEN=fd-canary\n", { mode: 0o600 });
    const descriptor = openSync(dotenv, "r");
    try {
      const script = `
const fs=require("node:fs");
const targets=fs.readdirSync("/proc/self/fd").flatMap((fd)=>{try{return [fs.readlinkSync("/proc/self/fd/"+fd)]}catch{return []}});
process.stdout.write(JSON.stringify({env:process.env,targets}));`;
      const result = spawnIsolatedBuildChild(process.execPath, ["-e", script], item.root, {
        home: item.home,
        tmpdir: item.tmp,
        output: "pipe",
        networkSandbox: "test-only",
        sourceEnvironment: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          HOME: "/real/home/with/.aws",
          AWS_ACCESS_KEY_ID: "access-canary",
          CLOUDFLARE_DEPLOY_API_TOKEN: "cloudflare-canary",
          AUTH_SECRET: "auth-canary",
        },
        overrides: { NEXT_PUBLIC_APP_URL: "https://panel.example.invalid" },
      });
      expect(result.status, result.stderr).toBe(0);
      const observed = JSON.parse(result.stdout) as { env: Record<string, string>; targets: string[] };
      expect(observed.env.HOME).toBe(item.home);
      expect(observed.env.AWS_ACCESS_KEY_ID).toBeUndefined();
      expect(observed.env.CLOUDFLARE_DEPLOY_API_TOKEN).toBeUndefined();
      expect(observed.env.AUTH_SECRET).toBeUndefined();
      expect(observed.env.NEXT_PUBLIC_APP_URL).toBe("https://panel.example.invalid");
      expect(observed.targets).not.toContain(dotenv);
    } finally {
      closeSync(descriptor);
    }
  });

  it("denies Node socket and fetch access before a connection is attempted", () => {
    const item = fixture();
    const sourcePreload = path.resolve(process.cwd(), "scripts/validation/deny-build-network.cjs");
    writeFileSync(
      path.join(item.root, "scripts/validation/deny-build-network.cjs"),
      `require(${JSON.stringify(sourcePreload)});`
    );
    const script = `
const net=require("node:net");
const result=[];
try{net.connect(443,"example.com");result.push("socket-open")}catch(e){result.push(e.code)}
fetch("https://example.com").then(()=>result.push("fetch-open"),e=>result.push(e.code)).finally(()=>process.stdout.write(JSON.stringify(result)));`;
    const result = spawnIsolatedBuildChild(process.execPath, ["-e", script], item.root, {
      home: item.home,
      tmpdir: item.tmp,
      output: "pipe",
      networkSandbox: "test-only",
      sourceEnvironment: { PATH: process.env.PATH, NODE_ENV: "test" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["MC_AWS_BUILD_NETWORK_DENIED", "MC_AWS_BUILD_NETWORK_DENIED"]);
  });

  it("rejects explicit deployment credential overrides", () => {
    const item = fixture();
    expect(() =>
      isolatedBuildEnvironment(item.root, {
        home: item.home,
        tmpdir: item.tmp,
        sourceEnvironment: { PATH: process.env.PATH },
        overrides: { AWS_ACCESS_KEY_ID: "forbidden" },
      })
    ).toThrow("forbidden isolated build environment override");
  });

  it("normalizes omitted or production NODE_ENV to the sandboxed production path", () => {
    const item = fixture();
    expect(
      isolatedBuildEnvironment(item.root, {
        home: item.home,
        tmpdir: item.tmp,
        sourceEnvironment: { PATH: process.env.PATH },
      }).NODE_ENV
    ).toBe("production");
    expect(() =>
      spawnIsolatedBuildChild(process.execPath, ["-e", "process.exit(0)"], item.root, {
        home: item.home,
        tmpdir: item.tmp,
        sourceEnvironment: { PATH: process.env.PATH, NODE_ENV: "production" },
        networkSandbox: "test-only",
      })
    ).toThrow("NODE_ENV=test harness");
  });

  it("contains detached descendants in a kill-on-exit PID namespace", () => {
    const detachedDescendantFixture =
      'require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"}).unref()';
    const args = productionBuildNamespaceArguments(process.execPath, ["-e", detachedDescendantFixture]);
    expect(args.slice(0, 8)).toEqual([
      "--user",
      "--map-root-user",
      "--net",
      "--pid",
      "--fork",
      "--kill-child=KILL",
      "--mount-proc",
      "--",
    ]);
    expect(args.slice(8)).toEqual([process.execPath, "-e", detachedDescendantFixture]);
  });
});
