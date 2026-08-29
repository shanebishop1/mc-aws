// @vitest-environment jsdom

import { GoogleDriveSetupPrompt } from "@/components/GoogleDriveSetupPrompt";
import { ResumeModal } from "@/components/ResumeModal";
import { EmailListItem } from "@/components/email/EmailListItem";
import { BackupDialog } from "@/components/ui/BackupDialog";
import { useAccessibleDialog } from "@/hooks/useAccessibleDialog";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const DialogHarness = ({ onClose }: { onClose: () => void }) => {
  const [canClose, setCanClose] = useState(true);
  const dialogRef = useAccessibleDialog(true, onClose, canClose);
  return (
    <div ref={dialogRef} tabIndex={-1}>
      <button type="button" data-dialog-initial-focus>
        First
      </button>
      <button type="button" onClick={() => setCanClose((value) => !value)}>
        Toggle loading
      </button>
      <button type="button">Last</button>
    </div>
  );
};

const EmptyDialogHarness = ({ onClose }: { onClose: () => void }) => {
  const dialogRef = useAccessibleDialog(true, onClose);
  return (
    // biome-ignore lint/a11y/useSemanticElements: Harness matches the div-based animated production dialogs.
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-label="Empty dialog">
      <button type="button" disabled>
        Disabled
      </button>
    </div>
  );
};

describe("modal and icon button accessibility", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it("labels, focuses, traps, closes, and restores focus for the resume dialog", async () => {
    const onClose = vi.fn();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <ResumeModal isOpen onClose={onClose} onResume={vi.fn()} />
      </QueryClientProvider>
    );

    const dialog = screen.getByRole("dialog", { name: "Resume World" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close resume dialog" })).toBe(document.activeElement)
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    rerender(
      <QueryClientProvider client={queryClient}>
        <ResumeModal isOpen={false} onClose={onClose} onResume={vi.fn()} />
      </QueryClientProvider>
    );
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("gives an email removal icon a specific accessible name", () => {
    render(<EmailListItem email="player@example.com" onRemove={vi.fn()} disabled={false} />);
    expect(screen.getByRole("button", { name: "Remove player@example.com" })).toBeTruthy();
  });

  it("wraps Tab in both directions, including when focus starts outside", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    render(<DialogHarness onClose={vi.fn()} />);
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });

    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    outside.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    outside.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    outside.remove();
  });

  it("focuses the dialog fallback when it has no enabled controls", async () => {
    render(<EmptyDialogHarness onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Empty dialog" });
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(dialog);
  });

  it("does not restore focus when canClose changes while open", () => {
    const onClose = vi.fn();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    render(<DialogHarness onClose={onClose} />);

    const toggle = screen.getByRole("button", { name: "Toggle loading" });
    toggle.focus();
    fireEvent.click(toggle);
    expect(document.activeElement).toBe(toggle);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    opener.remove();
  });

  it("keeps the backup backdrop disabled during loading but allows Escape without focusing disabled controls", async () => {
    const onClose = vi.fn();
    const { rerender } = render(<BackupDialog isOpen onClose={onClose} onConfirm={vi.fn()} isLoading={false} />);
    await waitFor(() => expect(screen.getByLabelText("Backup Name")).toBe(document.activeElement));

    rerender(<BackupDialog isOpen onClose={onClose} onConfirm={vi.fn()} isLoading />);
    await waitFor(() =>
      expect((document.activeElement as HTMLButtonElement | HTMLInputElement).disabled).not.toBe(true)
    );
    fireEvent.click(screen.getByTestId("backup-dialog"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    rerender(<BackupDialog isOpen onClose={onClose} onConfirm={vi.fn()} isLoading={false} />);
    fireEvent.click(screen.getByTestId("backup-dialog"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("cleans up the Google OAuth popup and ignores completion after close", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ success: true, data: { authUrl: "https://accounts.example.test" }, timestamp: "now" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        )
    );
    const popup = { closed: false, close: vi.fn() } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    const onSetupComplete = vi.fn();
    const { rerender } = render(<GoogleDriveSetupPrompt isOpen onClose={vi.fn()} onSetupComplete={onSetupComplete} />);

    fireEvent.click(screen.getByRole("button", { name: "Set Up Google Drive" }));
    await waitFor(() => expect(window.open).toHaveBeenCalledOnce());
    rerender(<GoogleDriveSetupPrompt isOpen={false} onClose={vi.fn()} onSetupComplete={onSetupComplete} />);
    expect(popup.close).toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent("message", { origin: window.location.origin, data: { type: "GDRIVE_OAUTH_SUCCESS" } })
    );
    expect(onSetupComplete).not.toHaveBeenCalled();
  });
});
