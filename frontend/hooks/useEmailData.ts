"use client";

import { useState, useEffect, useCallback } from "react";

interface UseEmailDataReturn {
  adminEmail: string;
  allowlist: string[];
  setAllowlist: React.Dispatch<React.SetStateAction<string[]>>;
  originalAllowlist: string[];
  isLoading: boolean;
  isRefetching: boolean;
  error: string | null;
  hasChanges: boolean;
  refetch: () => Promise<void>;
  saveAllowlist: () => Promise<boolean>;
  isSaving: boolean;
}

interface EmailResponse {
  success: boolean;
  data?: { adminEmail: string; allowlist: string[] };
  error?: string;
}

/**
 * Update state from successful email response
 */
function updateFromResponse(
  data: EmailResponse["data"],
  setAdminEmail: React.Dispatch<React.SetStateAction<string>>,
  setAllowlist: React.Dispatch<React.SetStateAction<string[]>>,
  setOriginalAllowlist: React.Dispatch<React.SetStateAction<string[]>>,
  setError: React.Dispatch<React.SetStateAction<string | null>>
): void {
  if (data) {
    setAdminEmail(data.adminEmail);
    setAllowlist(data.allowlist);
    setOriginalAllowlist(data.allowlist);
    setError(null);
  }
}

/**
 * Fetch emails from API
 */
async function fetchEmailsFromApi(
  url: string,
  isBackground: boolean,
  onSuccess: (data: EmailResponse["data"]) => void,
  onError: (message: string) => void
): Promise<void> {
  try {
    const response = await fetch(url);
    const data: EmailResponse = await response.json();

    if (!data.success) {
      if (!isBackground) onError(data.error || "Failed to load emails");
      return;
    }

    onSuccess(data.data);
  } catch {
    if (!isBackground) onError("Failed to load emails");
  }
}

export function useEmailData(): UseEmailDataReturn {
  const [adminEmail, setAdminEmail] = useState("");
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [originalAllowlist, setOriginalAllowlist] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefetching, setIsRefetching] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasFetchedOnce, setHasFetchedOnce] = useState(false);

  const hasChanges = JSON.stringify(allowlist) !== JSON.stringify(originalAllowlist);

  const fetchEmails = useCallback(async (isBackground = false) => {
    const setLoadingState = isBackground ? setIsRefetching : setIsLoading;
    setLoadingState(true);

    const url = `/api/emails${isBackground ? "?refresh=true" : ""}`;
    const onSuccess = (data: EmailResponse["data"]) =>
      updateFromResponse(data, setAdminEmail, setAllowlist, setOriginalAllowlist, setError);

    await fetchEmailsFromApi(url, isBackground, onSuccess, setError);

    setLoadingState(false);
    setHasFetchedOnce(true);
  }, []);

  const refetch = useCallback(async () => {
    setIsRefetching(true);

    const minDelayPromise = new Promise<void>((resolve) => {
      window.setTimeout(resolve, 500);
    });

    try {
      const response = await fetch("/api/emails?refresh=true");
      const data: EmailResponse = await response.json();

      if (data.success && data.data) {
        updateFromResponse(data.data, setAdminEmail, setAllowlist, setOriginalAllowlist, setError);
      } else {
        setError(data.error || "Failed to refresh emails");
      }
    } catch {
      setError("Failed to refresh emails");
    } finally {
      await minDelayPromise;
      setIsRefetching(false);
    }
  }, []);

  const saveAllowlist = useCallback(async (): Promise<boolean> => {
    setIsSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/emails/allowlist", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails: allowlist }),
      });

      const data: EmailResponse = await response.json();

      if (data.success) {
        setOriginalAllowlist(allowlist);
        return true;
      }
      setError(data.error || "Failed to save");
      return false;
    } catch {
      setError("Failed to save");
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [allowlist]);

  // Initial fetch
  useEffect(() => {
    if (!hasFetchedOnce) {
      fetchEmails(false);
    }
  }, [fetchEmails, hasFetchedOnce]);

  return {
    adminEmail,
    allowlist,
    setAllowlist,
    originalAllowlist,
    isLoading,
    isRefetching,
    error,
    hasChanges,
    refetch,
    saveAllowlist,
    isSaving,
  };
}
