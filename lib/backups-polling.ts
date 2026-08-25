import type { ListBackupsResponse } from "@/lib/types";

const DEFAULT_POLL_ERROR = "Could not refresh backups from Google Drive. Please verify Drive setup and try again.";
const DEFAULT_TIMEOUT_ERROR = "Backup listing is still pending. Please wait a moment and try again.";

interface PollBackupsOptions {
  maxAttempts?: number;
  intervalMs?: number;
  delay?: (milliseconds: number) => Promise<void>;
}

export async function pollBackups(
  check: () => Promise<ListBackupsResponse | undefined>,
  options: PollBackupsOptions = {}
): Promise<ListBackupsResponse | undefined> {
  const maxAttempts = options.maxAttempts ?? 10;
  const intervalMs = options.intervalMs ?? 3000;
  const delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const data = await check();
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
  }

  throw new Error(DEFAULT_TIMEOUT_ERROR);
}
