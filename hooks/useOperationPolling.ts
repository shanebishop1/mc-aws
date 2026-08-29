"use client";

import { pollOperationUntilTerminal, pollServerUntilStopped } from "@/lib/operation-polling";
import type { OperationStatusData } from "@/lib/types";
import { useCallback, useEffect, useRef } from "react";

export function useOperationPolling() {
  const activeController = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    activeController.current?.abort();
    activeController.current = null;
  }, []);

  const poll = useCallback(
    async (operationId: string): Promise<OperationStatusData> => {
      cancel();
      const controller = new AbortController();
      activeController.current = controller;

      try {
        return await pollOperationUntilTerminal(operationId, { signal: controller.signal });
      } finally {
        if (activeController.current === controller) activeController.current = null;
      }
    },
    [cancel]
  );

  const pollStop = useCallback(async () => {
    cancel();
    const controller = new AbortController();
    activeController.current = controller;
    try {
      return await pollServerUntilStopped({ signal: controller.signal });
    } finally {
      if (activeController.current === controller) activeController.current = null;
    }
  }, [cancel]);

  useEffect(() => cancel, [cancel]);

  return { poll, pollStop, cancel };
}
