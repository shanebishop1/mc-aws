// @vitest-environment jsdom

import { ControlsSection } from "@/components/ControlsSection";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseAuth = vi.fn();

vi.mock("@/components/auth/auth-provider", () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...props }: { children: ReactNode }) => {
      const {
        whileHover: _whileHover,
        whileTap: _whileTap,
        transition: _transition,
        ...rest
      } = props as Record<string, unknown>;
      return <div {...rest}>{children}</div>;
    },
    button: ({ children, ...props }: { children: ReactNode }) => {
      const {
        whileHover: _whileHover,
        whileTap: _whileTap,
        transition: _transition,
        initial: _initial,
        animate: _animate,
        ...rest
      } = props as Record<string, unknown>;
      return <button {...rest}>{children}</button>;
    },
  },
}));

interface RenderOptions {
  isAdmin: boolean;
  isAllowed: boolean;
  isAuthenticated: boolean;
}

function renderControls({ isAdmin, isAllowed, isAuthenticated }: RenderOptions, onAction = vi.fn()) {
  mockUseAuth.mockReturnValue({
    isAdmin,
    isAllowed,
    isAuthenticated,
    refetch: vi.fn().mockResolvedValue(null),
  });

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  const onOpenResume = vi.fn();

  render(
    <QueryClientProvider client={queryClient}>
      <ControlsSection
        status="stopped"
        showStart
        showStop={false}
        showResume={false}
        showHibernate
        showBackupRestore
        actionsEnabled
        onAction={onAction}
        onOpenResume={onOpenResume}
      />
    </QueryClientProvider>
  );

  return { onAction, onOpenResume };
}

describe("ControlsSection permission flows", () => {
  beforeEach(() => {
    mockUseAuth.mockReset();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("hides admin-only controls for non-admin users", () => {
    renderControls({ isAdmin: false, isAllowed: true, isAuthenticated: true });

    expect(screen.queryByRole("button", { name: "Backup" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hibernate" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start Server" })).toBeTruthy();
  });

  it("prompts login before unauthenticated start and does not execute action", () => {
    const onAction = vi.fn();
    const openSpy = vi.spyOn(window, "open").mockReturnValue({ closed: false } as Window);
    vi.spyOn(window, "setInterval").mockReturnValue(1 as unknown as ReturnType<typeof setInterval>);
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);

    renderControls({ isAdmin: false, isAllowed: false, isAuthenticated: false }, onAction);

    fireEvent.click(screen.getByRole("button", { name: "Start Server" }));

    expect(openSpy).toHaveBeenCalledWith(
      "/api/auth/login?popup=1",
      "google-auth",
      "width=500,height=600,menubar=no,toolbar=no"
    );
    expect(window.sessionStorage.getItem("mc_pending_action")).toBe("start");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("executes primary start action for authenticated allowed users", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    renderControls({ isAdmin: false, isAllowed: true, isAuthenticated: true }, onAction);

    fireEvent.click(screen.getByRole("button", { name: "Start Server" }));

    await waitFor(() => {
      expect(onAction).toHaveBeenCalledWith("Start", "/api/start", undefined);
    });
  });
});
