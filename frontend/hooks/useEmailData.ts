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
    if (!isBackground) setIsLoading(true);
    else setIsRefetching(true);

    try {
      const response = await fetch(`/api/emails${isBackground ? "?refresh=true" : ""}`);
      const data = await response.json();

      if (data.success && data.data) {
        setAdminEmail(data.data.adminEmail);
        setAllowlist(data.data.allowlist);
        setOriginalAllowlist(data.data.allowlist);
        setError(null);
      } else {
        if (!isBackground) setError(data.error || "Failed to load emails");
      }
    } catch {
      if (!isBackground) setError("Failed to load emails");
    } finally {
      if (!isBackground) setIsLoading(false);
      else setIsRefetching(false);
      setHasFetchedOnce(true);
    }
  }, []);

  const refetch = useCallback(async () => {
    setIsRefetching(true);
    try {
      const response = await fetch("/api/emails?refresh=true");
      const data = await response.json();
      if (data.success && data.data) {
        setAdminEmail(data.data.adminEmail);
        setAllowlist(data.data.allowlist);
        setOriginalAllowlist(data.data.allowlist);
      }
    } finally {
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

      const data = await response.json();

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
