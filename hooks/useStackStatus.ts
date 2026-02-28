"use client";

import { usePageFocus } from "@/hooks/usePageFocus";
import { fetchStackStatus, queryKeys } from "@/lib/client-api";
import { useQuery } from "@tanstack/react-query";

interface UseStackStatusReturn {
  stackExists: boolean;
  stackStatus: string | undefined;
  stackId: string | undefined;
  isLoading: boolean;
  error: string | undefined;
  refetch: () => Promise<void>;
}

export function useStackStatus(): UseStackStatusReturn {
  const isPageFocused = usePageFocus();

  const stackStatusQuery = useQuery({
    queryKey: queryKeys.stackStatus,
    queryFn: fetchStackStatus,
    enabled: isPageFocused,
  });

  const refetch = async () => {
    await stackStatusQuery.refetch();
  };

  return {
    stackExists: stackStatusQuery.data?.data?.exists ?? false,
    stackStatus: stackStatusQuery.data?.data?.status,
    stackId: stackStatusQuery.data?.data?.stackId,
    isLoading: stackStatusQuery.isPending,
    error: stackStatusQuery.error instanceof Error ? stackStatusQuery.error.message : undefined,
    refetch,
  };
}
