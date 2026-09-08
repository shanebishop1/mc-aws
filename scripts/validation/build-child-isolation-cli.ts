import { spawnIsolatedBuildChild } from "./build-child-isolation";

const requiredArg = (args: string[], name: string): string => {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`Missing required argument: ${name}`);
  return value;
};

try {
  const args = process.argv.slice(2);
  if (args.shift() !== "run") throw new Error("Usage: build-child-isolation-cli.ts run ... -- command [args]");
  const separator = args.indexOf("--");
  if (separator < 0 || !args[separator + 1]) throw new Error("Isolated build command is missing.");
  const control = args.slice(0, separator);
  const command = args[separator + 1];
  const commandArgs = args.slice(separator + 2);
  const overrides: Record<string, string> = {};
  for (let index = 0; index < control.length; index += 1) {
    if (control[index] !== "--env") continue;
    const entry = control[index + 1];
    if (!entry?.includes("=")) throw new Error("Malformed --env value.");
    const split = entry.indexOf("=");
    overrides[entry.slice(0, split)] = entry.slice(split + 1);
    index += 1;
  }
  const root = requiredArg(control, "--root");
  const result = spawnIsolatedBuildChild(command, commandArgs, root, {
    cwd: root,
    home: requiredArg(control, "--home"),
    tmpdir: requiredArg(control, "--tmp"),
    overrides,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
