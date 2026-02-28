"use client";

import { usePageFocus } from "@/hooks/usePageFocus";
import { fetchGDriveStatus, queryKeys } from "@/lib/client-api";
import { useQuery } from "@tanstack/react-query";

interface UseGDriveStatusReturn {
  isConfigured: boolean;
  isLoading: boolean;
  error: string | undefined;
  refetch: () => Promise<void>;
}

export function useGDriveStatus(): UseGDriveStatusReturn {
  const isPageFocused = usePageFocus();

  const gdriveStatusQuery = useQuery({
    queryKey: queryKeys.gdriveStatus,
    queryFn: fetchGDriveStatus,
    enabled: isPageFocused,
    refetchOnWindowFocus: false,
  });

  const refetch = async () => {
    await gdriveStatusQuery.refetch();
  };

  return {
    isConfigured: gdriveStatusQuery.data?.data?.configured ?? false,
    isLoading: gdriveStatusQuery.isPending,
    error: gdriveStatusQuery.error instanceof Error ? gdriveStatusQuery.error.message : undefined,
    refetch,
  };
}
