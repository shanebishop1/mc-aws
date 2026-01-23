"use client";

import { DestroyButton } from "@/components/DestroyButton";
import { GoogleDriveSetupPrompt } from "@/components/GoogleDriveSetupPrompt";
import { useAuth } from "@/components/auth/auth-provider";
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
  onAction: (action: string, endpoint: string) => void;
  onOpenResume: () => void;
  onDestroyComplete?: () => void;
  onDestroyError?: (error: string) => void;
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
  onDestroyComplete,
  onDestroyError,
}: ControlsSectionProps) => {
  const { isAdmin, isAllowed, isAuthenticated, refetch } = useAuth();

  const showStopEffective = showStop && isAdmin;
  const showResumeEffective = showResume && isAdmin;
  const showHibernateEffective = showHibernate && isAdmin;
  const showBackupRestoreEffective = showBackupRestore && isAdmin;

  const [showHibernateConfirm, setShowHibernateConfirm] = useState(false);
  const [showBackupConfirm, setShowBackupConfirm] = useState(false);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [showGDrivePrompt, setShowGDrivePrompt] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ action: string; endpoint: string } | null>(null);
  const [gdriveError, setGDriveError] = useState<string | null>(null);

  const handleBackupClick = async () => {
    const gdriveConfigured = await checkGDriveStatus();
    if (gdriveConfigured) {
      setShowBackupConfirm(true);
    } else {
      setPendingAction({ action: "Backup", endpoint: "/api/backup" });
      setShowGDrivePrompt(true);
    }
  };

  const handleRestoreClick = async () => {
    const gdriveConfigured = await checkGDriveStatus();
    if (gdriveConfigured) {
      setShowRestoreConfirm(true);
    } else {
      setPendingAction({ action: "Restore", endpoint: "/api/restore" });
      setShowGDrivePrompt(true);
    }
  };

  const handleGDriveSetupComplete = () => {
    setShowGDrivePrompt(false);
    setGDriveError(null);
    if (pendingAction) {
      onAction(pendingAction.action, pendingAction.endpoint);
      setPendingAction(null);
    }
  };

  const handleGDrivePromptClose = () => {
    setShowGDrivePrompt(false);
    if (pendingAction) {
      setGDriveError("Google Drive is required for this operation");
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
    const popup = window.open(
      "/api/auth/login?popup=1",
      "google-auth",
      "width=500,height=600,menubar=no,toolbar=no"
    );

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

  const promptLoginAndStart = () => {
    // Ensure full-page fallback can continue the action after redirect.
    window.sessionStorage.setItem("mc_pending_action", "start");

    openLoginPopup(() => {
      window.sessionStorage.removeItem("mc_pending_action");
      onAction("Start", "/api/start");
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
      onAction("Start", "/api/start");
    }
  };

  return (
    <motion.div
      data-testid="controls-section"
      className="shrink-0 h-24 md:h-48 flex items-center justify-center w-full"
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
            onAction={onAction}
            onPrimaryAction={handlePrimaryAction}
            onHibernateClick={() => setShowHibernateConfirm(true)}
            onBackupClick={handleBackupClick}
            onRestoreClick={handleRestoreClick}
            onDestroyComplete={onDestroyComplete}
            onDestroyError={onDestroyError}
          />

          <ConfirmationDialogs
            showHibernateConfirm={showHibernateConfirm}
            showBackupConfirm={showBackupConfirm}
            showRestoreConfirm={showRestoreConfirm}
            onHibernateClose={() => setShowHibernateConfirm(false)}
            onBackupClose={() => setShowBackupConfirm(false)}
            onRestoreClose={() => setShowRestoreConfirm(false)}
            onHibernateConfirm={() => {
              setShowHibernateConfirm(false);
              onAction("Hibernate", "/api/hibernate");
            }}
            onBackupConfirm={() => {
              setShowBackupConfirm(false);
              onAction("Backup", "/api/backup");
            }}
            onRestoreConfirm={() => {
              setShowRestoreConfirm(false);
              onAction("Restore", "/api/restore");
            }}
          />

          <GoogleDriveSetupPrompt
            isOpen={showGDrivePrompt}
            onClose={handleGDrivePromptClose}
            onSetupComplete={handleGDriveSetupComplete}
            allowSkip={false}
            context={pendingAction?.action === "Backup" ? "backup" : "restore"}
          />

          {gdriveError && <GDriveErrorToast message={gdriveError} onDismiss={() => setGDriveError(null)} />}
        </>
      ) : (
        <section className="w-full max-w-4xl flex items-center justify-center">
          <PrimaryActionButton
            showStop={false}
            showStart={showStart || showResume}
            showResume={false}
            actionsEnabled={actionsEnabled}
            isAllowed={isAllowed}
            isAuthenticated={isAuthenticated}
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
  onAction: (action: string, endpoint: string) => void;
  onPrimaryAction: () => void;
  onHibernateClick: () => void;
  onBackupClick: () => void;
  onRestoreClick: () => void;
  onDestroyComplete?: () => void;
  onDestroyError?: (error: string) => void;
}

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
  onAction,
  onPrimaryAction,
  onHibernateClick,
  onBackupClick,
  onRestoreClick,
  onDestroyComplete,
  onDestroyError,
}: ControlsGridProps) => {
  if (status === "unknown") return null;

  return (
    <section className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-8 items-center justify-items-center">
      <div className="flex flex-col gap-6 w-full max-w-[200px] text-center md:text-right">
        {showHibernate && (
          <LuxuryButton
            variant="text"
            onClick={onHibernateClick}
            disabled={!actionsEnabled || !isAdmin}
            title={!isAdmin ? "Admin privileges required" : undefined}
          >
            Hibernate
          </LuxuryButton>
        )}
      </div>

      <div className="order-first md:order-none flex flex-col items-center gap-4">
        <PrimaryActionButton
          showStop={showStop}
          showStart={showStart}
          showResume={showResume}
          actionsEnabled={actionsEnabled}
          isAllowed={isAllowed}
          isAuthenticated={isAuthenticated}
          onAction={onAction}
          onPrimaryAction={onPrimaryAction}
        />
        <DestroyButton onDestroyComplete={onDestroyComplete} onError={onDestroyError} />
      </div>

      <div className="flex flex-col gap-6 w-full max-w-[200px] text-center md:text-left">
        {showBackupRestore && (
          <>
            <LuxuryButton
              variant="text"
              onClick={onRestoreClick}
              disabled={!actionsEnabled || !isAdmin}
              title={!isAdmin ? "Admin privileges required" : undefined}
            >
              Restore
            </LuxuryButton>
            <LuxuryButton
              variant="text"
              onClick={onBackupClick}
              disabled={!actionsEnabled || !isAdmin}
              title={!isAdmin ? "Admin privileges required" : undefined}
            >
              Backup
            </LuxuryButton>
          </>
        )}
      </div>
    </section>
  );
};

interface PrimaryActionButtonProps {
  showStop: boolean;
  showStart: boolean;
  showResume: boolean;
  actionsEnabled: boolean;
  isAllowed: boolean;
  isAuthenticated: boolean;
  onAction: (action: string, endpoint: string) => void;
  onPrimaryAction: () => void;
}

function getStartButtonMeta({
  actionsEnabled,
  isAllowed,
  isAuthenticated,
}: {
  actionsEnabled: boolean;
  isAllowed: boolean;
  isAuthenticated: boolean;
}): { disabled: boolean; title?: string } {
  // When logged out, we keep the button enabled so it can trigger sign-in.
  const disabled = !actionsEnabled || (isAuthenticated && !isAllowed);
  const title = !isAuthenticated ? "Sign in to start the server" : !isAllowed ? "Allowed or admin privileges required" : undefined;
  return { disabled, title };
}

const PrimaryActionButton = ({
  showStop,
  showStart,
  showResume,
  actionsEnabled,
  isAllowed,
  isAuthenticated,
  onAction,
  onPrimaryAction,
}: PrimaryActionButtonProps) => {
  if (showStop) {
    return (
      <LuxuryButton
        onClick={() => onAction("Stop", "/api/stop")}
        disabled={!actionsEnabled || !isAllowed}
        title={!isAllowed ? "Allowed or admin privileges required" : undefined}
      >
        Stop Server
      </LuxuryButton>
    );
  }

  if (showStart || showResume) {
    const { disabled, title } = showStart
      ? getStartButtonMeta({ actionsEnabled, isAllowed, isAuthenticated })
      : { disabled: false, title: undefined };

    return (
      <LuxuryButton
        onClick={onPrimaryAction}
        disabled={disabled}
        title={title}
      >
        {showResume ? "Resume" : "Start Server"}
      </LuxuryButton>
    );
  }

  return null;
};

interface ConfirmationDialogsProps {
  showHibernateConfirm: boolean;
  showBackupConfirm: boolean;
  showRestoreConfirm: boolean;
  onHibernateClose: () => void;
  onBackupClose: () => void;
  onRestoreClose: () => void;
  onHibernateConfirm: () => void;
  onBackupConfirm: () => void;
  onRestoreConfirm: () => void;
}

const ConfirmationDialogs = ({
  showHibernateConfirm,
  showBackupConfirm,
  showRestoreConfirm,
  onHibernateClose,
  onBackupClose,
  onRestoreClose,
  onHibernateConfirm,
  onBackupConfirm,
  onRestoreConfirm,
}: ConfirmationDialogsProps) => (
  <>
    <ConfirmationDialog
      isOpen={showHibernateConfirm}
      onClose={onHibernateClose}
      onConfirm={onHibernateConfirm}
      title="Hibernate Server"
      description="This will backup your server, stop the instance, and delete the volume to save costs. You can resume later."
      confirmText="Hibernate"
      variant="danger"
    />
    <ConfirmationDialog
      isOpen={showBackupConfirm}
      onClose={onBackupClose}
      onConfirm={onBackupConfirm}
      title="Backup Server"
      description="This will create a backup of your server and upload it to Google Drive. The process may take a few minutes."
      confirmText="Backup"
    />
    <ConfirmationDialog
      isOpen={showRestoreConfirm}
      onClose={onRestoreClose}
      onConfirm={onRestoreConfirm}
      title="Restore Server"
      description="This will restore your server from a backup on Google Drive, overwriting the current server state. Any unsaved progress will be lost."
      confirmText="Restore"
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
