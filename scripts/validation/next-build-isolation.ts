import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sanitizeDeploymentBuildEnv } from "../cloudflare/deploy-env";

/** Every dotenv file Next can load while building a production application. */
export const NEXT_BUILD_DOTENV_FILES = [".env.production.local", ".env.local", ".env.production", ".env"] as const;

export const NEXT_BUILD_ISOLATION_STATE_DIRECTORY = ".mc-aws-state";
export const NEXT_BUILD_ISOLATION_JOURNAL = "next-build-isolation.json";
export const NEXT_BUILD_ISOLATION_LOCK = "next-build-isolation.lock";
const NEXT_BUILD_ISOLATION_OWNER = "next-build-isolation.owner.json";

type IsolationEntry = {
  source: string;
  backup: string;
  mode: number;
};

type IsolationJournal = {
  version: 1;
  pid: number;
  startToken: string;
  nonce: string;
  root: string;
  temporaryDirectory: string;
  generatedFile: string;
  entries: IsolationEntry[];
};

const stateDirectory = (root: string): string => path.join(root, NEXT_BUILD_ISOLATION_STATE_DIRECTORY);
const journalPath = (root: string): string => path.join(stateDirectory(root), NEXT_BUILD_ISOLATION_JOURNAL);
const lockPath = (root: string): string => path.join(stateDirectory(root), NEXT_BUILD_ISOLATION_LOCK);
const ownerPath = (root: string): string => path.join(stateDirectory(root), NEXT_BUILD_ISOLATION_OWNER);
const releasePath = (root: string, nonce: string): string =>
  path.join(stateDirectory(root), `.next-build-isolation-release-${nonce}`);

type ProcessIdentity = { pid: number; startToken: string };
type LockOwner = ProcessIdentity & {
  version: 1;
  helperPid: number;
  helperStartToken: string;
  nonce: string;
};
type ActiveLock = { descriptor: number; child: ChildProcess; owner: LockOwner };

const activeLocks = new Map<string, ActiveLock>();

const ensureStateDirectory = (root: string): string => {
  const directory = stateDirectory(root);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Refusing unsafe build isolation state directory: ${directory}`);
  }
  chmodSync(directory, 0o700);
  return directory;
};

const pathExists = (filePath: string): boolean => {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const writePrivateFile = (filePath: string, contents: string): void => {
  writeFileSync(filePath, contents, { mode: 0o600, flag: "wx" });
  chmodSync(filePath, 0o600);
};

const processStartToken = (pid: number): string | undefined => {
  try {
    const source = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = source.lastIndexOf(")");
    return end < 0
      ? undefined
      : source
          .slice(end + 2)
          .trim()
          .split(/\s+/)[19];
  } catch {
    return undefined;
  }
};

const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: journal recovery validates every ownership and path invariant before mutation.
const readJournal = (root: string): IsolationJournal | undefined => {
  const filePath = journalPath(root);
  if (!pathExists(filePath)) return undefined;
  let journal: unknown;
  try {
    const descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const status = fstatSync(descriptor);
      if (
        !status.isFile() ||
        status.nlink !== 1 ||
        (status.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" && status.uid !== process.getuid())
      )
        throw new Error("unsafe journal");
      journal = JSON.parse(readFileSync(descriptor, "utf8"));
    } finally {
      closeSync(descriptor);
    }
  } catch {
    throw new Error(`Refusing to recover malformed build isolation journal: ${filePath}`);
  }
  if (
    !journal ||
    typeof journal !== "object" ||
    (journal as IsolationJournal).version !== 1 ||
    (journal as IsolationJournal).root !== path.resolve(root) ||
    !Array.isArray((journal as IsolationJournal).entries) ||
    typeof (journal as IsolationJournal).temporaryDirectory !== "string" ||
    typeof (journal as IsolationJournal).generatedFile !== "string" ||
    !Number.isSafeInteger((journal as IsolationJournal).pid) ||
    typeof (journal as IsolationJournal).startToken !== "string" ||
    !/^[0-9a-f-]{36}$/.test((journal as IsolationJournal).nonce)
  ) {
    throw new Error(`Refusing to recover invalid build isolation journal: ${filePath}`);
  }
  if (
    Object.keys(journal).sort().join(",") !==
    "entries,generatedFile,nonce,pid,root,startToken,temporaryDirectory,version"
  ) {
    throw new Error(`Refusing to recover journal with unexpected fields: ${filePath}`);
  }
  const typedJournal = journal as IsolationJournal;
  const temporaryDirectory = path.resolve(typedJournal.temporaryDirectory);
  const state = path.resolve(stateDirectory(root));
  if (!temporaryDirectory.startsWith(`${state}${path.sep}`) || path.basename(temporaryDirectory).startsWith(".")) {
    throw new Error(`Refusing to recover invalid build isolation temporary path: ${filePath}`);
  }
  if (path.resolve(typedJournal.generatedFile) !== path.join(path.resolve(root), ".env.production.local")) {
    throw new Error(`Refusing to recover invalid generated dotenv path: ${filePath}`);
  }
  const expectedSources = new Set(NEXT_BUILD_DOTENV_FILES.map((name) => path.join(path.resolve(root), name)));
  const backupPaths = new Set<string>();
  for (const entry of typedJournal.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid dotenv journal entry");
    if (Object.keys(entry).sort().join(",") !== "backup,mode,source")
      throw new Error("Invalid dotenv journal entry fields");
    if (!expectedSources.has(path.resolve(entry.source)))
      throw new Error(`Refusing invalid dotenv journal source: ${entry.source}`);
    const backup = path.resolve(entry.backup);
    if (!backup.startsWith(`${temporaryDirectory}${path.sep}`) || backupPaths.has(backup)) {
      throw new Error(`Refusing invalid dotenv journal backup: ${entry.backup}`);
    }
    if (!Number.isSafeInteger(entry.mode) || (entry.mode & ~0o7777) !== 0)
      throw new Error("Invalid dotenv journal mode");
    backupPaths.add(backup);
  }
  return journal as IsolationJournal;
};

const readLockOwner = (root: string): LockOwner | undefined => {
  if (!pathExists(ownerPath(root))) return undefined;
  const descriptor = openSync(ownerPath(root), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let source: string;
  try {
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.nlink !== 1 ||
      (status.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && status.uid !== process.getuid())
    ) {
      throw new Error(`Refusing unsafe build isolation owner: ${ownerPath(root)}`);
    }
    source = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
  const owner = JSON.parse(source) as LockOwner;
  if (
    owner.version !== 1 ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid < 1 ||
    typeof owner.startToken !== "string" ||
    !Number.isSafeInteger(owner.helperPid) ||
    owner.helperPid < 1 ||
    typeof owner.helperStartToken !== "string" ||
    !/^[0-9a-f-]{36}$/.test(owner.nonce)
  ) {
    throw new Error(`Refusing unsafe build isolation owner: ${ownerPath(root)}`);
  }
  return owner;
};

const validateLockFile = (root: string): void => {
  if (!pathExists(lockPath(root))) return;
  const status = lstatSync(lockPath(root));
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    (status.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === "function" && status.uid !== process.getuid())
  ) {
    throw new Error(`Refusing unsafe build isolation lock: ${lockPath(root)}`);
  }
};

const processIdentity = (pid: number): ProcessIdentity => {
  const startToken = processStartToken(pid);
  if (!startToken) throw new Error(`Unable to establish process start identity for PID ${pid}.`);
  return { pid, startToken };
};

const orchestratorIdentity = (): ProcessIdentity => {
  const configured = process.env.MC_AWS_NEXT_BUILD_ORCHESTRATOR_PID;
  if (configured !== undefined) {
    if (!/^[1-9][0-9]*$/.test(configured)) throw new Error("Invalid Next build orchestrator PID.");
    return processIdentity(Number(configured));
  }
  return processIdentity(process.pid);
};

const wait = (milliseconds: number): void => {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
};

const lockIsFree = (root: string): boolean => {
  validateLockFile(root);
  const descriptor = openSync(lockPath(root), constants.O_RDWR | (constants.O_NOFOLLOW || 0));
  try {
    return (
      spawnSync("/usr/bin/flock", ["--nonblock", "--exclusive", "3", "/bin/true"], {
        stdio: ["ignore", "ignore", "ignore", descriptor],
      }).status === 0
    );
  } finally {
    closeSync(descriptor);
  }
};

const helperSource = `
  const fs = require("node:fs");
  const ready = process.argv[1];
  const parentPid = Number(process.argv[2]);
  const parentStartToken = process.argv[3];
  const release = process.argv[4];
  const nonce = process.argv[5];
  const startToken = (pid) => {
    try {
      const source = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
      const end = source.lastIndexOf(")");
      return end < 0 ? undefined : source.slice(end + 2).trim().split(/\\s+/)[19];
    } catch { return undefined; }
  };
  fs.writeFileSync(ready, "ready\\n", { flag: "wx", mode: 0o600 });
  const checkParent = () => {
    if (startToken(parentPid) !== parentStartToken) process.exit(0);
    try {
      if (fs.readFileSync(release, "utf8").trim() === nonce) process.exit(0);
    } catch {}
  };
  checkParent();
  setInterval(checkParent, 100);
`;

const waitForLockHelper = (child: ChildProcess, readyPath: string): void => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (pathExists(readyPath)) return;
    if (child.pid && !isProcessAlive(child.pid)) break;
    wait(25);
  }
  throw new Error("Unable to establish the Next build advisory lock.");
};

const waitForLockRelease = (root: string): boolean => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (lockIsFree(root)) return true;
    wait(25);
  }
  return lockIsFree(root);
};

const acquireAdvisoryLock = (root: string, identity: ProcessIdentity, nonce: string = randomUUID()): LockOwner => {
  const resolvedRoot = path.resolve(root);
  const existing = activeLocks.get(resolvedRoot);
  if (existing) return existing.owner;
  ensureStateDirectory(resolvedRoot);
  if (pathExists(lockPath(resolvedRoot))) validateLockFile(resolvedRoot);
  else {
    const created = openSync(lockPath(resolvedRoot), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    closeSync(created);
  }
  chmodSync(lockPath(resolvedRoot), 0o600);

  if (!lockIsFree(resolvedRoot)) {
    const owner = readLockOwner(resolvedRoot);
    if (owner && isProcessAlive(owner.pid) && processStartToken(owner.pid) === owner.startToken) {
      throw new Error(`Another isolated Next build is active (PID ${owner.pid}).`);
    }
    if (!waitForLockRelease(resolvedRoot)) {
      throw new Error(`Another isolated Next build is active: ${lockPath(resolvedRoot)}`);
    }
  }
  if (pathExists(ownerPath(resolvedRoot))) {
    // Metadata is never used as the lock. It can only be discarded after the
    // kernel advisory probe has proved that no prior holder owns the file.
    readLockOwner(resolvedRoot);
    unlinkSync(ownerPath(resolvedRoot));
  }

  const descriptor = openSync(lockPath(resolvedRoot), constants.O_RDWR | (constants.O_NOFOLLOW || 0));
  const readyPath = path.join(stateDirectory(resolvedRoot), `.next-build-isolation-ready-${nonce}`);
  const child = spawn(
    "/bin/sh",
    [
      "-c",
      'exec /usr/bin/flock --nonblock --exclusive 3 "$@"',
      "next-build-lock",
      process.execPath,
      "-e",
      helperSource,
      readyPath,
      String(identity.pid),
      identity.startToken,
      releasePath(resolvedRoot, nonce),
      nonce,
    ],
    { stdio: ["ignore", "ignore", "ignore", descriptor] }
  );
  try {
    waitForLockHelper(child, readyPath);
  } catch (error) {
    closeSync(descriptor);
    rmSync(readyPath, { force: true });
    throw error;
  }
  rmSync(readyPath, { force: true });
  const helperPid = child.pid;
  if (!helperPid) throw new Error("Next build advisory lock helper did not expose a PID.");
  const owner: LockOwner = {
    version: 1,
    pid: identity.pid,
    startToken: identity.startToken,
    helperPid,
    helperStartToken: processIdentity(helperPid).startToken,
    nonce,
  };
  writePrivateFile(ownerPath(resolvedRoot), `${JSON.stringify(owner)}\n`);
  activeLocks.set(resolvedRoot, { descriptor, child, owner });
  return owner;
};

const releaseAdvisoryLock = (root: string, expectedNonce?: string): void => {
  const resolvedRoot = path.resolve(root);
  const active = activeLocks.get(resolvedRoot);
  const owner = active?.owner ?? readLockOwner(resolvedRoot);
  if (!owner) return;
  if (expectedNonce && owner.nonce !== expectedNonce)
    throw new Error("Next build lock nonce does not match the journal.");
  if (!active) {
    const identity = orchestratorIdentity();
    if (owner.pid !== identity.pid || owner.startToken !== identity.startToken) {
      throw new Error("Next build isolation lock ownership could not be established.");
    }
    if (processStartToken(owner.helperPid) !== owner.helperStartToken) {
      throw new Error("Next build isolation lock helper identity changed.");
    }
  }
  writePrivateFile(releasePath(resolvedRoot, owner.nonce), `${owner.nonce}\n`);
  if (active) closeSync(active.descriptor);
  if (!waitForLockRelease(resolvedRoot)) throw new Error("Next build advisory lock did not release.");
  activeLocks.delete(resolvedRoot);
  rmSync(releasePath(resolvedRoot, owner.nonce), { force: true });
  rmSync(ownerPath(resolvedRoot), { force: true });
};

const validatePrivateTemporaryDirectory = (root: string, temporaryDirectory: string): void => {
  const resolved = path.resolve(temporaryDirectory);
  if (!resolved.startsWith(path.resolve(stateDirectory(root)) + path.sep)) {
    throw new Error("Refusing to recover build isolation from an unsafe state directory.");
  }
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error("Refusing to recover build isolation from a non-private temporary directory.");
  }
};

/** Restore files from a previous interrupted isolation operation, if present. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Recovery deliberately validates every stale journal state before restoring files.
const recoverLocked = (root: string, options: { allowActive?: boolean } = {}): boolean => {
  const resolvedRoot = path.resolve(root);
  const journal = readJournal(resolvedRoot);
  if (!journal) return false;

  const identity = orchestratorIdentity();
  const owner = readLockOwner(resolvedRoot);
  const ownerIsCurrent =
    owner?.pid === identity.pid && owner.startToken === identity.startToken && owner.nonce === journal.nonce;
  const journalOwnerIsAlive = isProcessAlive(journal.pid) && processStartToken(journal.pid) === journal.startToken;
  if (!options.allowActive && journalOwnerIsAlive) {
    throw new Error(`Another isolated Next build is active (PID ${journal.pid}).`);
  }
  if (options.allowActive && !ownerIsCurrent) {
    throw new Error("Next build isolation restore requires the journal owner and advisory lock owner.");
  }
  validatePrivateTemporaryDirectory(resolvedRoot, journal.temporaryDirectory);
  // Remove the generated dotenv before restoring the original candidate at the
  // same path. This also makes recovery safe after a crash between those steps.
  if (pathExists(journal.generatedFile)) {
    const generatedStatus = lstatSync(journal.generatedFile);
    if (!generatedStatus.isFile() && !generatedStatus.isSymbolicLink()) {
      throw new Error("Refusing to remove an unexpected generated dotenv path.");
    }
    rmSync(journal.generatedFile, { force: true });
  }
  for (const entry of [...journal.entries].reverse()) {
    if (!pathExists(entry.backup)) continue;
    const backupStatus = lstatSync(entry.backup);
    if (!backupStatus.isFile() && !backupStatus.isSymbolicLink()) throw new Error("Refusing an unsafe dotenv backup.");
    if (pathExists(entry.source)) {
      const sourceStatus = lstatSync(entry.source);
      if (!sourceStatus.isFile() && !sourceStatus.isSymbolicLink())
        throw new Error("Refusing an unsafe dotenv source.");
    }
    rmSync(entry.source, { force: true });
    renameSync(entry.backup, entry.source);
    if (!lstatSync(entry.source).isSymbolicLink()) chmodSync(entry.source, entry.mode);
  }
  rmSync(journal.temporaryDirectory, { recursive: true, force: true });
  rmSync(journalPath(resolvedRoot), { force: true });
  return true;
};

export const recoverNextBuildIsolation = (root = process.cwd(), options: { allowActive?: boolean } = {}): boolean => {
  const resolvedRoot = path.resolve(root);
  ensureStateDirectory(resolvedRoot);
  const identity = orchestratorIdentity();
  const active = activeLocks.get(resolvedRoot);
  if (active) {
    if (!options.allowActive) throw new Error(`Another isolated Next build is active (PID ${active.owner.pid}).`);
    return recoverLocked(resolvedRoot, options);
  }
  const owner = pathExists(ownerPath(resolvedRoot)) ? readLockOwner(resolvedRoot) : undefined;
  if (owner && !lockIsFree(resolvedRoot)) {
    if (owner.pid === identity.pid && owner.startToken === identity.startToken) {
      throw new Error("Next build isolation is already staged by this orchestrator.");
    }
    if (isProcessAlive(owner.pid) && processStartToken(owner.pid) === owner.startToken) {
      throw new Error(`Another isolated Next build is active (PID ${owner.pid}).`);
    }
    throw new Error(`Another isolated Next build is active: ${lockPath(resolvedRoot)}`);
  }
  const lockOwner = acquireAdvisoryLock(resolvedRoot, identity);
  try {
    return recoverLocked(resolvedRoot, options);
  } finally {
    releaseAdvisoryLock(resolvedRoot, lockOwner.nonce);
  }
};

export type NextBuildIsolationOptions = {
  /** A sanitized dotenv source. If omitted, the source file is sanitized. */
  buildEnvironment?: string;
  sourceEnvironmentFile?: string;
};

/**
 * Move every Next dotenv candidate into a private directory and expose only a
 * sanitized generated `.env.production.local`. The journal is written before
 * any move so a later invocation can restore the exact original files.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Staging validates every dotenv candidate before and after journaling.
export const stageNextBuildIsolation = (root = process.cwd(), options: NextBuildIsolationOptions = {}): void => {
  const resolvedRoot = path.resolve(root);
  const privateStateDirectory = ensureStateDirectory(resolvedRoot);
  if (activeLocks.has(resolvedRoot)) throw new Error(`Another isolated Next build is active (PID ${process.pid}).`);
  const identity = orchestratorIdentity();
  const sourceEnvironmentFile = path.resolve(resolvedRoot, options.sourceEnvironmentFile ?? ".env.production");
  const allowedSource = new Set(NEXT_BUILD_DOTENV_FILES.map((name) => path.join(resolvedRoot, name)));
  if (!allowedSource.has(sourceEnvironmentFile) && !/^\/proc\/self\/fd\/\d+$/.test(sourceEnvironmentFile)) {
    throw new Error(`Refusing an environment source outside the build root: ${sourceEnvironmentFile}`);
  }
  const buildEnvironment =
    options.buildEnvironment ??
    (pathExists(sourceEnvironmentFile) ? sanitizeDeploymentBuildEnv(readFileSync(sourceEnvironmentFile, "utf8")) : "");

  const owner = acquireAdvisoryLock(resolvedRoot, identity);
  let temporaryDirectory = "";
  try {
    recoverLocked(resolvedRoot);
    const lockOwner = readLockOwner(resolvedRoot);
    if (!lockOwner || lockOwner.pid !== identity.pid || lockOwner.startToken !== identity.startToken) {
      throw new Error("Build isolation lock ownership could not be established.");
    }
    temporaryDirectory = mkdtempSync(path.join(privateStateDirectory, "next-build-isolation-"));
    chmodSync(temporaryDirectory, 0o700);
    const generatedFile = path.join(resolvedRoot, ".env.production.local");
    const entries: IsolationEntry[] = NEXT_BUILD_DOTENV_FILES.flatMap((relativePath, index) => {
      const source = path.join(resolvedRoot, relativePath);
      if (!pathExists(source)) return [];
      const stat = lstatSync(source);
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        throw new Error(`Refusing to isolate non-file dotenv candidate: ${source}`);
      }
      return [{ source, backup: path.join(temporaryDirectory, `${index}.dotenv`), mode: stat.mode & 0o7777 }];
    });
    const journal: IsolationJournal = {
      version: 1,
      pid: identity.pid,
      startToken: identity.startToken,
      nonce: lockOwner.nonce,
      root: resolvedRoot,
      temporaryDirectory,
      generatedFile,
      entries,
    };
    writePrivateFile(journalPath(resolvedRoot), `${JSON.stringify(journal)}\n`);
    for (const entry of entries) {
      renameSync(entry.source, entry.backup);
      if (!lstatSync(entry.backup).isSymbolicLink()) chmodSync(entry.backup, 0o600);
    }
    const isolatedBuildEnvironment = `${buildEnvironment.replace(/\n*$/, "")}\nMC_AWS_BUILD_ISOLATION=1\n`;
    writePrivateFile(generatedFile, isolatedBuildEnvironment);
  } catch (error) {
    if (pathExists(journalPath(resolvedRoot))) {
      recoverLocked(resolvedRoot, { allowActive: true });
    } else if (temporaryDirectory) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    releaseAdvisoryLock(resolvedRoot, owner.nonce);
    throw error;
  }
};

export const restoreNextBuildIsolation = (root = process.cwd()): void => {
  const resolvedRoot = path.resolve(root);
  ensureStateDirectory(resolvedRoot);
  const active = activeLocks.get(resolvedRoot);
  if (active) {
    const restored = recoverLocked(resolvedRoot, { allowActive: true });
    if (restored) releaseAdvisoryLock(resolvedRoot, active.owner.nonce);
    return;
  }

  const journal = readJournal(resolvedRoot);
  if (!journal) {
    const owner = acquireAdvisoryLock(resolvedRoot, orchestratorIdentity());
    releaseAdvisoryLock(resolvedRoot, owner.nonce);
    return;
  }
  const identity = orchestratorIdentity();
  const owner = readLockOwner(resolvedRoot);
  if (
    !owner ||
    owner.pid !== identity.pid ||
    owner.startToken !== identity.startToken ||
    owner.nonce !== journal.nonce
  ) {
    throw new Error("Next build isolation restore requires the journal owner and advisory lock owner.");
  }
  // The staging CLI exits before the build starts, so the restore CLI claims
  // the same journal nonce only after proving the original helper's advisory
  // lock and orchestrator identity. This is not a stale-lock takeover.
  releaseAdvisoryLock(resolvedRoot, journal.nonce);
  const claimed = acquireAdvisoryLock(resolvedRoot, identity, journal.nonce);
  try {
    const restored = recoverLocked(resolvedRoot, { allowActive: true });
    releaseAdvisoryLock(resolvedRoot, claimed.nonce);
    if (!restored) throw new Error("Next build isolation journal disappeared before restoration.");
  } catch (error) {
    if (activeLocks.has(resolvedRoot)) throw error;
    throw error;
  }
};

export const withNextBuildIsolation = <T>(root: string, options: NextBuildIsolationOptions, callback: () => T): T => {
  stageNextBuildIsolation(root, options);
  const cleanup = (): void => {
    restoreNextBuildIsolation(root);
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    cleanup();
    process.kill(process.pid, signal);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    return callback();
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    cleanup();
  }
};

const getArg = (args: string[], name: string): string => {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value) throw new Error(`Missing required argument: ${name}`);
  return value;
};

const runCli = (): void => {
  const [command, ...args] = process.argv.slice(2);
  const root = path.resolve(args.includes("--root") ? getArg(args, "--root") : process.cwd());
  if (command === "stage") {
    const sourceEnvironmentFile = args.includes("--source-fd")
      ? `/proc/self/fd/${getArg(args, "--source-fd")}`
      : getArg(args, "--env-file");
    stageNextBuildIsolation(root, { sourceEnvironmentFile });
    return;
  }
  if (command === "restore") {
    restoreNextBuildIsolation(root);
    return;
  }
  if (command === "recover") {
    recoverNextBuildIsolation(root);
    return;
  }
  throw new Error(`Unknown next-build-isolation command: ${String(command)}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
