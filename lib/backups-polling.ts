import type { ListBackupsResponse } from "@/lib/types";

const DEFAULT_POLL_ERROR = "Could not refresh backups from Google Drive. Please verify Drive setup and try again.";
const DEFAULT_TIMEOUT_ERROR = "Backup listing is still pending. Please wait a moment and try again.";

interface PollBackupsOptions {
  maxAttempts?: number;
  intervalMs?: number;
  delay?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Backup polling was cancelled", "AbortError");
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const handleAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException("Backup polling was cancelled", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

export async function pollBackups(
  check: () => Promise<ListBackupsResponse | undefined>,
  options: PollBackupsOptions = {}
): Promise<ListBackupsResponse | undefined> {
  const maxAttempts = options.maxAttempts ?? 10;
  const intervalMs = options.intervalMs ?? 3000;
  const delay = options.delay ?? ((milliseconds) => abortableDelay(milliseconds, options.signal));

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    throwIfAborted(options.signal);
    const data = await check();
    throwIfAborted(options.signal);
    if (data?.status === "error") {
      throw new Error(data.errorMessage || DEFAULT_POLL_ERROR);
    }
    if (data?.status !== "caching") {
      return data;
    }
    if (attempt === maxAttempts) {
      throw new Error(DEFAULT_TIMEOUT_ERROR);
    }
    await delay(intervalMs);
    throwIfAborted(options.signal);
  }

  throw new Error(DEFAULT_TIMEOUT_ERROR);
}
