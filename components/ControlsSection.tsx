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
  const { isAdmin, isAllowed, isAuthenticated } = useAuth();

  const [showHibernateConfirm, setShowHibernateConfirm] = useState(false);
  const [showBackupConfirm, setShowBackupConfirm] = useState(false);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [showGDrivePrompt, setShowGDrivePrompt] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ action: string; endpoint: string } | null>(null);
  const [gdriveError, setGDriveError] = useState<string | null>(null);

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

  const handleBackupClick = async () => {
    const gdriveConfigured = await checkGDriveStatus();
    if (!gdriveConfigured) {
      setPendingAction({ action: "Backup", endpoint: "/api/backup" });
      setShowGDrivePrompt(true);
    } else {
      setShowBackupConfirm(true);
    }
  };

  const handleRestoreClick = async () => {
    const gdriveConfigured = await checkGDriveStatus();
    if (!gdriveConfigured) {
      setPendingAction({ action: "Restore", endpoint: "/api/restore" });
      setShowGDrivePrompt(true);
    } else {
      setShowRestoreConfirm(true);
    }
  };

  const handleBackupConfirm = () => {
    setShowBackupConfirm(false);
    onAction("Backup", "/api/backup");
  };

  const handleRestoreConfirm = () => {
    setShowRestoreConfirm(false);
    onAction("Restore", "/api/restore");
  };

  const handleGDriveSetupComplete = () => {
    setShowGDrivePrompt(false);
    setGDriveError(null);
    // Proceed with the pending action
    if (pendingAction) {
      onAction(pendingAction.action, pendingAction.endpoint);
      setPendingAction(null);
    }
  };

  const handleGDrivePromptClose = () => {
    setShowGDrivePrompt(false);
    // For backup/restore, Google Drive is required
    if (pendingAction) {
      setGDriveError("Google Drive is required for this operation");
      setPendingAction(null);
    }
  };

  const handlePrimaryAction = () => {
    if (showResume) {
      if (!isAuthenticated) {
        window.open("/api/auth/login", "google-auth", "width=500,height=600,menubar=no,toolbar=no");
        return;
      }
      onOpenResume();
    } else {
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
      {/* Controls Grid - Only renders buttons inside container */}
      {status !== "unknown" && (
        <section className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-8 items-center justify-items-center">
          {/* Left Col */}
          <div className="flex flex-col gap-6 w-full max-w-[200px] text-center md:text-right">
            {showHibernate && (
              <LuxuryButton
                variant="text"
                onClick={() => setShowHibernateConfirm(true)}
                disabled={!actionsEnabled || !isAdmin}
                title={!isAdmin ? "Admin privileges required" : undefined}
              >
                Hibernate
              </LuxuryButton>
            )}
          </div>

          {/* Center - Primary Action + Destroy Button */}
          <div className="order-first md:order-none flex flex-col items-center gap-4">
            {showStop ? (
              <LuxuryButton
                onClick={() => onAction("Stop", "/api/stop")}
                disabled={!actionsEnabled || !isAllowed}
                title={!isAllowed ? "Allowed or admin privileges required" : undefined}
              >
                Stop Server
              </LuxuryButton>
            ) : showStart || showResume ? (
              <LuxuryButton
                onClick={handlePrimaryAction}
                disabled={showStart && (!actionsEnabled || !isAllowed)}
                title={showStart && !isAllowed ? "Allowed or admin privileges required" : undefined}
              >
                {showResume ? "Resume" : "Start Server"}
              </LuxuryButton>
            ) : null}
            <DestroyButton onDestroyComplete={onDestroyComplete} onError={onDestroyError} />
          </div>

          {/* Right Col */}
          <div className="flex flex-col gap-6 w-full max-w-[200px] text-center md:text-left">
            {showBackupRestore && (
              <>
                <LuxuryButton
                  variant="text"
                  onClick={handleRestoreClick}
                  disabled={!actionsEnabled || !isAdmin}
                  title={!isAdmin ? "Admin privileges required" : undefined}
                >
                  Restore
                </LuxuryButton>
                <LuxuryButton
                  variant="text"
                  onClick={handleBackupClick}
                  disabled={!actionsEnabled || !isAdmin}
                  title={!isAdmin ? "Admin privileges required" : undefined}
                >
                  Backup
                </LuxuryButton>
              </>
            )}
          </div>
        </section>
      )}

      {/* Confirmation Dialogs */}
      <ConfirmationDialog
        isOpen={showHibernateConfirm}
        onClose={() => setShowHibernateConfirm(false)}
        onConfirm={() => {
          setShowHibernateConfirm(false);
          onAction("Hibernate", "/api/hibernate");
        }}
        title="Hibernate Server"
        description="This will backup your server, stop the instance, and delete the volume to save costs. You can resume later."
        confirmText="Hibernate"
        variant="danger"
      />

      <ConfirmationDialog
        isOpen={showBackupConfirm}
        onClose={() => setShowBackupConfirm(false)}
        onConfirm={handleBackupConfirm}
        title="Backup Server"
        description="This will create a backup of your server and upload it to Google Drive. The process may take a few minutes."
        confirmText="Backup"
      />

      <ConfirmationDialog
        isOpen={showRestoreConfirm}
        onClose={() => setShowRestoreConfirm(false)}
        onConfirm={handleRestoreConfirm}
        title="Restore Server"
        description="This will restore your server from a backup on Google Drive, overwriting the current server state. Any unsaved progress will be lost."
        confirmText="Restore"
        variant="danger"
      />

      {/* Google Drive Setup Prompt */}
      <GoogleDriveSetupPrompt
        isOpen={showGDrivePrompt}
        onClose={handleGDrivePromptClose}
        onSetupComplete={handleGDriveSetupComplete}
        allowSkip={false}
        context={pendingAction?.action === "Backup" ? "backup" : "restore"}
      />

      {/* Google Drive Error Message */}
      {gdriveError && (
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
              <p className="text-sm text-red-700 mt-1">{gdriveError}</p>
            </div>
            <button
              type="button"
              onClick={() => setGDriveError(null)}
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
      )}
    </motion.div>
  );
};
