// @vitest-environment jsdom

import { useServerStatus } from "@/hooks/useServerStatus";
import { fetchPlayers, fetchStatus } from "@/lib/client-api";
import { type ApiResponse, type PlayersResponse, ServerState, type ServerStatusResponse } from "@/lib/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PENDING_ACTION_TIMEOUT_MS = 2 * 60 * 1000;

vi.mock("@/hooks/usePageFocus", () => ({
  usePageFocus: vi.fn(() => true),
}));

vi.mock("@/lib/client-api", () => ({
  queryKeys: {
    status: ["status"],
    players: ["players"],
  },
  fetchStatus: vi.fn(),
  fetchPlayers: vi.fn(),
}));

function buildStatusResponse(state: ServerState): ApiResponse<ServerStatusResponse> {
  return {
    success: true,
    data: {
      state,
      instanceId: "i-1234567890abcdef0",
      domain: state === ServerState.Running ? "mc.example.com" : undefined,
      hasVolume: true,
      lastUpdated: new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  };
}

function buildPlayersResponse(count: number): PlayersResponse {
  return {
    success: true,
    data: {
      count,
      lastUpdated: new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  };
}

function createTestClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
      },
    },
  });
}

function createWrapper(queryClient: QueryClient): ({ children }: { children: ReactNode }) => ReactNode {
  return ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function mockVisibleFocusedDocument(): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });

  vi.spyOn(document, "hasFocus").mockReturnValue(true);
}

describe("useServerStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    mockVisibleFocusedDocument();

    vi.mocked(fetchStatus).mockReset();
    vi.mocked(fetchPlayers).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("falls back to actual status after pending action timeout", async () => {
    vi.mocked(fetchStatus).mockResolvedValue(buildStatusResponse(ServerState.Stopped));
    vi.mocked(fetchPlayers).mockResolvedValue(buildPlayersResponse(0));

    const queryClient = createTestClient();
    const { result, rerender } = renderHook(() => useServerStatus(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.status).toBe(ServerState.Stopped);
    });

    act(() => {
      result.current.setPendingAction("start");
    });

    expect(result.current.status).toBe(ServerState.Pending);

    act(() => {
      vi.advanceTimersByTime(PENDING_ACTION_TIMEOUT_MS - 1);
    });
    rerender();
    expect(result.current.status).toBe(ServerState.Pending);

    act(() => {
      vi.advanceTimersByTime(2);
    });
    rerender();
    expect(result.current.status).toBe(ServerState.Stopped);
  });

  it("refetches status when window receives focus", async () => {
    vi.mocked(fetchStatus).mockResolvedValue(buildStatusResponse(ServerState.Running));
    vi.mocked(fetchPlayers).mockResolvedValue(buildPlayersResponse(4));

    const queryClient = createTestClient();
    renderHook(() => useServerStatus(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(fetchStatus).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(fetchStatus).toHaveBeenCalledTimes(2);
    });
  });

  it("refreshes players only when transitioning into running and cancels when leaving running", async () => {
    let currentState = ServerState.Stopped;

    vi.mocked(fetchStatus).mockImplementation(async () => buildStatusResponse(currentState));
    vi.mocked(fetchPlayers).mockResolvedValue(buildPlayersResponse(7));

    const queryClient = createTestClient();
    const cancelQueriesSpy = vi.spyOn(queryClient, "cancelQueries");

    const { result } = renderHook(() => useServerStatus(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.status).toBe(ServerState.Stopped);
    });

    await waitFor(() => {
      expect(cancelQueriesSpy).toHaveBeenCalledWith({ queryKey: ["players"] });
    });
    const initialCancelCalls = cancelQueriesSpy.mock.calls.length;

    currentState = ServerState.Running;
    await act(async () => {
      await result.current.fetchStatus();
    });

    await waitFor(() => {
      expect(result.current.status).toBe(ServerState.Running);
      expect(fetchPlayers).toHaveBeenCalledTimes(1);
      expect(result.current.playerCount).toBe(7);
    });

    await act(async () => {
      await result.current.fetchStatus();
    });

    await waitFor(() => {
      expect(fetchPlayers).toHaveBeenCalledTimes(1);
    });

    currentState = ServerState.Stopped;
    await act(async () => {
      await result.current.fetchStatus();
    });

    await waitFor(() => {
      expect(result.current.status).toBe(ServerState.Stopped);
      expect(result.current.playerCount).toBeUndefined();
      expect(cancelQueriesSpy.mock.calls.length).toBeGreaterThan(initialCancelCalls);
    });
  });
});
