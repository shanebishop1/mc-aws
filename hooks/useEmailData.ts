"use client";

import { usePageFocus } from "@/hooks/usePageFocus";
import { fetchEmails, putEmailsAllowlist, queryKeys } from "@/lib/client-api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

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
  const isPageFocused = usePageFocus();
  const queryClient = useQueryClient();
  const [adminEmail, setAdminEmail] = useState("");
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [originalAllowlist, setOriginalAllowlist] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const emailsQuery = useQuery({
    queryKey: queryKeys.emails,
    queryFn: () => fetchEmails(false),
    enabled: isPageFocused,
    refetchOnWindowFocus: false,
  });

  const refreshMutation = useMutation({
    mutationFn: () => fetchEmails(true),
  });

  const saveMutation = useMutation({
    mutationFn: (emails: string[]) => putEmailsAllowlist(emails),
  });

  useEffect(() => {
    if (!emailsQuery.data?.data) {
      return;
    }

    const nextAdminEmail = emailsQuery.data.data.adminEmail;
    const nextAllowlist = emailsQuery.data.data.allowlist;
    setAdminEmail(nextAdminEmail);
    setAllowlist(nextAllowlist);
    setOriginalAllowlist(nextAllowlist);
    setError(null);
  }, [emailsQuery.data]);

  useEffect(() => {
    if (emailsQuery.error instanceof Error) {
      setError(emailsQuery.error.message);
    }
  }, [emailsQuery.error]);

  const refetch = useCallback(async () => {
    const minDelayPromise = new Promise<void>((resolve) => {
      window.setTimeout(resolve, 500);
    });

    try {
      const result = await refreshMutation.mutateAsync();
      if (result.data) {
        const nextAdminEmail = result.data.adminEmail;
        const nextAllowlist = result.data.allowlist;
        setAdminEmail(nextAdminEmail);
        setAllowlist(nextAllowlist);
        setOriginalAllowlist(nextAllowlist);
        setError(null);
      }

      queryClient.setQueryData(queryKeys.emails, result);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to refresh emails";
      setError(errorMessage);
    } finally {
      await minDelayPromise;
    }
  }, [queryClient, refreshMutation]);

  const saveAllowlist = useCallback(async (): Promise<boolean> => {
    setError(null);

    try {
      const result = await saveMutation.mutateAsync(allowlist);
      if (!result.success) {
        setError(result.error || "Failed to save");
        return false;
      }

      setOriginalAllowlist(allowlist);
      await queryClient.invalidateQueries({ queryKey: queryKeys.emails });
      return true;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to save";
      setError(errorMessage);
      return false;
    }
  }, [allowlist, queryClient, saveMutation]);

  return {
    adminEmail,
    allowlist,
    setAllowlist,
    originalAllowlist,
    isLoading: emailsQuery.isPending,
    isRefetching: refreshMutation.isPending,
    error,
    hasChanges: JSON.stringify(allowlist) !== JSON.stringify(originalAllowlist),
    refetch,
    saveAllowlist,
    isSaving: saveMutation.isPending,
  };
}
