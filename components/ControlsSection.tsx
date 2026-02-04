"use client";

import { GoogleDriveSetupPrompt } from "@/components/GoogleDriveSetupPrompt";
import { useAuth } from "@/components/auth/auth-provider";
import { RestoreDialog } from "@/components/backup/RestoreDialog";
import { BackupDialog } from "@/components/ui/BackupDialog";
import { LuxuryButton } from "@/components/ui/Button";
import { ConfirmationDialog } from "@/components/ui/ConfirmationDialog";
import { motion } from "framer-motion";
import { useState } from "react";

interface ControlsSectionProps {
  status: string;
  showStart: boolean;
  showStop: boolean;
  showResume: boolean;
  showHibernate: boolean;
  showBackupRestore: boolean;
  actionsEnabled: boolean;
  onAction: (action: string, endpoint: string, body?: Record<string, string>) => Promise<void>;
  onOpenResume: () => void;
}

const checkGDriveStatus = async (): Promise<boolean> => {
  try {
    const response = await fetch("/api/gdrive/status");
    const data = await response.json();
    return data.success && data.data?.configured === true;
  } catch (error) {
    console.error("[CONTROLS] Failed to check GDrive status:", error);
    return false;
  }
};

export const ControlsSection = ({
  status,
  showStart,
  showStop,
  showResume,
  showHibernate,
  showBackupRestore,
  actionsEnabled,
  onAction,
  onOpenResume,
}: ControlsSectionProps) => {
  const { isAdmin, isAllowed, isAuthenticated, refetch } = useAuth();

  const showStopEffective = showStop && isAdmin;
  const showResumeEffective = showResume && isAdmin;
  const showHibernateEffective = showHibernate && isAdmin;
  const showBackupRestoreEffective = showBackupRestore && isAdmin;

  const [showHibernateConfirm, setShowHibernateConfirm] = useState(false);
  const [showBackupDialog, setShowBackupDialog] = useState(false);
  const [showRestoreDialog, setShowRestoreDialog] = useState(false);
  const [showGDrivePrompt, setShowGDrivePrompt] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ action: string; endpoint: string } | null>(null);
  const [gdriveError, setGdriveError] = useState<string | null>(null);
  const [isActionPending, setIsActionPending] = useState(false);

  const handleBackupClick = async () => {
    const gdriveConfigured = await checkGDriveStatus();
    if (gdriveConfigured) {
      setShowBackupDialog(true);
    } else {
      setPendingAction({ action: "Backup", endpoint: "/api/backup" });
      setShowGDrivePrompt(true);
    }
  };

  const handleRestoreClick = async () => {
    const gdriveConfigured = await checkGDriveStatus();
    if (gdriveConfigured) {
      setShowRestoreDialog(true);
    } else {
      setPendingAction({ action: "Restore", endpoint: "/api/restore" });
      setShowGDrivePrompt(true);
    }
  };

  const handleGDriveSetupComplete = () => {
    setShowGDrivePrompt(false);
    setGdriveError(null);
    if (pendingAction?.action === "Restore") {
      setShowRestoreDialog(true);
      setPendingAction(null);
    } else if (pendingAction?.action === "Backup") {
      setShowBackupDialog(true);
      setPendingAction(null);
    }
  };

  const handleGDrivePromptClose = () => {
    setShowGDrivePrompt(false);
    if (pendingAction) {
      setGdriveError("Google Drive is required for this operation");
      setPendingAction(null);
    }
  };

  const isSignedIn = async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/auth/me");
      const data = (await res.json()) as { authenticated?: boolean };
      return data.authenticated === true;
    } catch {
      return false;
    }
  };

  const openLoginPopup = (onSuccess?: () => void) => {
    const popup = window.open("/api/auth/login?popup=1", "google-auth", "width=500,height=600,menubar=no,toolbar=no");

    if (!popup) {
      window.location.href = "/api/auth/login";
      return;
    }

    async function complete() {
      cleanup();
      await refetch();
      if (onSuccess && (await isSignedIn())) {
        onSuccess();
      }
    }

    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (typeof event.data !== "object" || event.data === null) return;
      if ((event.data as { type?: string }).type !== "MC_AUTH_SUCCESS") return;
      void complete();
    }

    const poll = window.setInterval(() => {
      if (popup.closed) {
        void complete();
      }
    }, 500);

    function cleanup() {
      window.clearInterval(poll);
      window.removeEventListener("message", handleMessage);
    }

    window.addEventListener("message", handleMessage);
  };

  const promptLoginOnly = () => {
    openLoginPopup();
  };

  const handleAction = async (action: string, endpoint: string, body?: Record<string, string>) => {
    setIsActionPending(true);
    try {
      await onAction(action, endpoint, body);
    } finally {
      setIsActionPending(false);
    }
  };

  const promptLoginAndStart = () => {
    // Ensure full-page fallback can continue the action after redirect.
    window.sessionStorage.setItem("mc_pending_action", "start");

    openLoginPopup(() => {
      window.sessionStorage.removeItem("mc_pending_action");
      void handleAction("Start", "/api/start");
    });
  };

  const handlePrimaryAction = () => {
    if (showResumeEffective) {
      if (!isAuthenticated) {
        promptLoginOnly();
        return;
      }
      onOpenResume();
    } else {
      if (!isAuthenticated) {
        promptLoginAndStart();
        return;
      }
      void handleAction("Start", "/api/start");
    }
  };

  return (
    <motion.div
      data-testid="controls-section"
      className="shrink-0 w-full flex items-center justify-center py-4 md:py-0 min-h-24 md:min-h-48"
      initial={{ y: 20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.8, ease: "easeOut" }}
    >
      {isAdmin ? (
        <>
          <ControlsGrid
            status={status}
            showStop={showStopEffective}
            showStart={showStart}
            showResume={showResumeEffective}
            showHibernate={showHibernateEffective}
            showBackupRestore={showBackupRestoreEffective}
            actionsEnabled={actionsEnabled}
            isAdmin={isAdmin}
            isAllowed={isAllowed}
            isAuthenticated={isAuthenticated}
            isActionPending={isActionPending}
            onAction={onAction}
            onPrimaryAction={handlePrimaryAction}
            onHibernateClick={() => setShowHibernateConfirm(true)}
            onBackupClick={handleBackupClick}
            onRestoreClick={handleRestoreClick}
          />

          <ConfirmationDialogs
            showHibernateConfirm={showHibernateConfirm}
            isActionPending={isActionPending}
            onHibernateClose={() => setShowHibernateConfirm(false)}
            onHibernateConfirm={() => {
              setShowHibernateConfirm(false);
              void handleAction("Hibernate", "/api/hibernate");
            }}
          />

          <BackupDialog
            isOpen={showBackupDialog}
            onClose={() => setShowBackupDialog(false)}
            onConfirm={(backupName) => {
              setShowBackupDialog(false);
              void handleAction("Backup", "/api/backup", { name: backupName });
            }}
            isLoading={isActionPending}
          />

          <RestoreDialog
            open={showRestoreDialog}
            onOpenChange={setShowRestoreDialog}
            onConfirm={(backupName) => {
              setShowRestoreDialog(false);
              void handleAction("Restore", "/api/restore", { backupName });
            }}
          />

          <GoogleDriveSetupPrompt
            isOpen={showGDrivePrompt}
            onClose={handleGDrivePromptClose}
            onSetupComplete={handleGDriveSetupComplete}
            allowSkip={false}
            context={pendingAction?.action === "Backup" ? "backup" : "restore"}
          />

          {gdriveError && <GDriveErrorToast message={gdriveError} onDismiss={() => setGdriveError(null)} />}
        </>
      ) : (
        <section className="w-full max-w-4xl flex items-center justify-center">
          <PrimaryActionButton
            status={status}
            showStop={false}
            showStart={showStart || showResume}
            showResume={false}
            actionsEnabled={actionsEnabled}
            isAllowed={isAllowed}
            isAuthenticated={isAuthenticated}
            isActionPending={isActionPending}
            onAction={onAction}
            onPrimaryAction={handlePrimaryAction}
          />
        </section>
      )}
    </motion.div>
  );
};

// Sub-components to reduce complexity

interface ControlsGridProps {
  status: string;
  showStop: boolean;
  showStart: boolean;
  showResume: boolean;
  showHibernate: boolean;
  showBackupRestore: boolean;
  actionsEnabled: boolean;
  isAdmin: boolean;
  isAllowed: boolean;
  isAuthenticated: boolean;
  isActionPending: boolean;
  onAction: (action: string, endpoint: string) => void;
  onPrimaryAction: () => void;
  onHibernateClick: () => void;
  onBackupClick: () => void;
  onRestoreClick: () => void;
}

interface AdminButtonProps {
  show: boolean;
  onClick: () => void;
  disabled: boolean;
  title?: string;
  children: React.ReactNode;
}

const AdminButton = ({ show, onClick, disabled, title, children }: AdminButtonProps) => {
  if (!show) return null;
  return (
    <LuxuryButton variant="pill" onClick={onClick} disabled={disabled} title={title}>
      {children}
    </LuxuryButton>
  );
};

const getAdminButtonTitle = (isAdmin: boolean, isActionPending: boolean): string | undefined => {
  if (!isAdmin) return "Admin privileges required";
  if (isActionPending) return "Action in progress";
  return undefined;
};

const ControlsGrid = ({
  status,
  showStop,
  showStart,
  showResume,
  showHibernate,
  showBackupRestore,
  actionsEnabled,
  isAdmin,
  isAllowed,
  isAuthenticated,
  isActionPending,
  onAction,
  onPrimaryAction,
  onHibernateClick,
  onBackupClick,
  onRestoreClick,
}: ControlsGridProps) => {
  if (status === "unknown") return null;

  const adminButtonTitle = getAdminButtonTitle(isAdmin, isActionPending);
  const isDisabled = !actionsEnabled || !isAdmin || isActionPending;

  return (
    <section className="w-full max-w-4xl grid grid-cols-3 md:grid-cols-[1fr_auto_1fr] md:grid-rows-[auto_auto] gap-4 md:gap-x-8 md:gap-y-4 items-center md:items-center justify-items-center">
      <div className="order-2 col-span-1 md:col-span-1 md:order-none md:col-start-1 md:row-start-1 w-full max-w-[200px] flex justify-center md:justify-end">
        <AdminButton show={showBackupRestore} onClick={onBackupClick} disabled={isDisabled} title={adminButtonTitle}>
          Backup
        </AdminButton>
      </div>

      <div className="order-1 col-span-3 md:col-span-1 md:order-none md:col-start-2 md:row-start-1 flex justify-center">
        <PrimaryActionButton
          status={status}
          showStop={showStop}
          showStart={showStart}
          showResume={showResume}
          actionsEnabled={actionsEnabled}
          isAllowed={isAllowed}
          isAuthenticated={isAuthenticated}
          isActionPending={isActionPending}
          onAction={onAction}
          onPrimaryAction={onPrimaryAction}
        />
      </div>

      <div className="order-4 col-span-1 md:col-span-1 md:order-none md:col-start-3 md:row-start-1 w-full max-w-[200px] flex justify-center md:justify-start">
        <AdminButton show={showBackupRestore} onClick={onRestoreClick} disabled={isDisabled} title={adminButtonTitle}>
          Restore
        </AdminButton>
      </div>

      <div className="order-3 col-span-1 md:col-span-1 md:order-none md:col-start-2 md:row-start-2 flex justify-center md:mt-2">
        <AdminButton show={showHibernate} onClick={onHibernateClick} disabled={isDisabled} title={adminButtonTitle}>
          Hibernate
        </AdminButton>
      </div>
    </section>
  );
};

interface PrimaryActionButtonProps {
  status: string;
  showStop: boolean;
  showStart: boolean;
  showResume: boolean;
  actionsEnabled: boolean;
  isAllowed: boolean;
  isAuthenticated: boolean;
  isActionPending: boolean;
  onAction: (action: string, endpoint: string) => void;
  onPrimaryAction: () => void;
}

const PrimaryActionButton = ({
  showStop,
  showStart,
  showResume,
  actionsEnabled,
  isAllowed,
  isAuthenticated,
  isActionPending,
  onAction,
  onPrimaryAction,
}: PrimaryActionButtonProps) => {
  if (showStop) {
    return (
      <LuxuryButton
        onClick={() => onAction("Stop", "/api/stop")}
        disabled={!actionsEnabled || !isAllowed || isActionPending}
        title={!isAllowed ? "Allowed or admin privileges required" : undefined}
      >
        Stop Server
      </LuxuryButton>
    );
  }

  if (showStart || showResume) {
    // When logged out, we keep the button enabled so it can trigger sign-in.
    const disabled = !actionsEnabled || (isAuthenticated && !isAllowed) || isActionPending;
    const title = !isAuthenticated
      ? "Sign in to start the server"
      : !isAllowed
        ? "Allowed or admin privileges required"
        : undefined;

    return (
      <LuxuryButton onClick={onPrimaryAction} disabled={disabled} title={title}>
        {showResume ? "Resume" : "Start Server"}
      </LuxuryButton>
    );
  }

  return null;
};

interface ConfirmationDialogsProps {
  showHibernateConfirm: boolean;
  isActionPending: boolean;
  onHibernateClose: () => void;
  onHibernateConfirm: () => void;
}

const ConfirmationDialogs = ({
  showHibernateConfirm,
  isActionPending,
  onHibernateClose,
  onHibernateConfirm,
}: ConfirmationDialogsProps) => (
  <>
    <ConfirmationDialog
      isOpen={showHibernateConfirm}
      onClose={onHibernateClose}
      onConfirm={onHibernateConfirm}
      isLoading={isActionPending}
      title="Hibernate Server"
      description="This will backup your server, stop the instance, and delete the volume to save costs. You can resume later."
      confirmText="Hibernate"
      variant="danger"
    />
  </>
);

const GDriveErrorToast = ({ message, onDismiss }: { message: string; onDismiss: () => void }) => (
  <div className="fixed bottom-4 right-4 max-w-md bg-red-50 border border-red-200 rounded-sm p-4 shadow-xl z-50">
    <div className="flex items-start gap-3">
      <svg className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
          clipRule="evenodd"
        />
      </svg>
      <div className="flex-1">
        <p className="text-sm font-medium text-red-800">Setup Required</p>
        <p className="text-sm text-red-700 mt-1">{message}</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="text-red-400 hover:text-red-600 transition-colors"
        aria-label="Dismiss error"
      >
        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </div>
  </div>
);
