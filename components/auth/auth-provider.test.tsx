// @vitest-environment jsdom

import { AuthProvider, useAuth } from "@/components/auth/auth-provider";
import { fetchAuthMe, postAuthLogout } from "@/lib/client-api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/usePageFocus", () => ({
  usePageFocus: vi.fn(() => true),
}));

vi.mock("@/lib/client-api", async () => {
  const actual = (await vi.importActual("@/lib/client-api")) as Record<string, unknown>;
  return {
    ...actual,
    fetchAuthMe: vi.fn(),
    postAuthLogout: vi.fn(),
  };
});

const AuthStateProbe = () => {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="is-authenticated">{String(auth.isAuthenticated)}</span>
      <span data-testid="is-admin">{String(auth.isAdmin)}</span>
      <span data-testid="is-allowed">{String(auth.isAllowed)}</span>
      <span data-testid="user-email">{auth.user?.email ?? "none"}</span>
    </div>
  );
};

function createWrapper(queryClient: QueryClient): ({ children }: { children: ReactNode }) => ReactNode {
  return ({ children }) => (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

describe("AuthProvider", () => {
  beforeEach(() => {
    vi.mocked(fetchAuthMe).mockReset();
    vi.mocked(postAuthLogout).mockReset();
  });

  it("maps allowed user to authenticated, allowed, non-admin flags", async () => {
    vi.mocked(fetchAuthMe).mockResolvedValue({
      authenticated: true,
      email: "allowed@example.com",
      role: "allowed",
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    render(<AuthStateProbe />, { wrapper: createWrapper(queryClient) });

    await waitFor(() => {
      expect(screen.getByTestId("is-authenticated").textContent).toBe("true");
      expect(screen.getByTestId("is-admin").textContent).toBe("false");
      expect(screen.getByTestId("is-allowed").textContent).toBe("true");
      expect(screen.getByTestId("user-email").textContent).toBe("allowed@example.com");
    });
  });

  it("maps unauthenticated user to null user and no permissions", async () => {
    vi.mocked(fetchAuthMe).mockResolvedValue({ authenticated: false });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    render(<AuthStateProbe />, { wrapper: createWrapper(queryClient) });

    await waitFor(() => {
      expect(screen.getByTestId("is-authenticated").textContent).toBe("false");
      expect(screen.getByTestId("is-admin").textContent).toBe("false");
      expect(screen.getByTestId("is-allowed").textContent).toBe("false");
      expect(screen.getByTestId("user-email").textContent).toBe("none");
    });
  });
});
