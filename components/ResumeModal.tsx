"use client";

import { BackupSelectionList } from "@/components/backup";
import { LuxuryButton } from "@/components/ui/Button";
import { useAccessibleDialog } from "@/hooks/useAccessibleDialog";
import { pollBackups } from "@/lib/backups-polling";
import { fetchBackups as fetchBackupsApi, queryKeys } from "@/lib/client-api";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

interface BackupInfo {
  name: string;
}

interface ResumeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onResume: (input: { restoreMode: "fresh" | "named"; backupName?: string }) => void;
}

export const ResumeModal = ({ isOpen, onClose, onResume }: ResumeModalProps) => {
  const queryClient = useQueryClient();
  const [view, setView] = useState<"choice" | "backups">("choice");
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [selectedBackup, setSelectedBackup] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchControllerRef = useRef<AbortController | null>(null);
  const dialogRef = useAccessibleDialog(isOpen, onClose);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      fetchControllerRef.current?.abort();
      void queryClient.cancelQueries({ queryKey: queryKeys.backups(false) });
      setView("choice");
      setBackups([]);
      setSelectedBackup(null);
      setIsLoading(false);
      setError(null);
    }
    return () => {
      fetchControllerRef.current?.abort();
      void queryClient.cancelQueries({ queryKey: queryKeys.backups(false) });
    };
  }, [isOpen, queryClient]);

  // Fetch backups when switching to backup view
  const fetchBackups = async () => {
    fetchControllerRef.current?.abort();
    const controller = new AbortController();
    fetchControllerRef.current = controller;
    setIsLoading(true);
    setError(null);

    try {
      const check = async () => {
        const data = await queryClient.fetchQuery({
          queryKey: queryKeys.backups(false),
          queryFn: () => fetchBackupsApi(false, controller.signal),
        });
        return data.data;
      };

      const data = await pollBackups(check, { signal: controller.signal });

      if (!controller.signal.aborted) setBackups(data?.backups || []);
    } catch (err) {
      if (controller.signal.aborted) return;
      const errorMessage = err instanceof Error ? err.message : "Failed to fetch backups";
      setError(errorMessage);
    } finally {
      if (fetchControllerRef.current === controller) {
        setIsLoading(false);
        fetchControllerRef.current = null;
      }
    }
  };

  const handleRestoreClick = async () => {
    setView("backups");
    void fetchBackups();
  };

  const handleConfirmRestore = () => {
    if (selectedBackup) {
      onResume({ restoreMode: "named", backupName: selectedBackup });
    }
  };

  const handleBackToChoice = () => {
    setView("choice");
    setSelectedBackup(null);
    setError(null);
  };

  const handleStartFresh = () => {
    onResume({ restoreMode: "fresh" });
  };

  const handleClickOutside = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <>
      {isOpen && (
        <motion.div
          data-testid="resume-modal"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={handleClickOutside}
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-2 sm:items-center sm:p-4"
        >
          {/* Modal Container */}
          <motion.div
            ref={dialogRef}
            // biome-ignore lint/a11y/useSemanticElements: Framer Motion does not expose a motion.dialog element.
            role="dialog"
            aria-modal="true"
            aria-labelledby={view === "choice" ? "resume-modal-title" : "resume-backups-title"}
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="relative w-full max-w-lg max-h-[calc(100dvh-1rem)] overflow-y-auto bg-cream rounded-sm shadow-xl border border-charcoal/10 sm:max-h-[calc(100dvh-2rem)]"
          >
            {/* Close Button */}
            <button
              type="button"
              onClick={onClose}
              data-dialog-initial-focus
              aria-label="Close resume dialog"
              className="absolute top-4 right-4 text-charcoal/40 hover:text-charcoal transition-colors z-10 sm:top-6 sm:right-6"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            {/* Choice View */}
            {view === "choice" && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="p-5 pt-14 sm:p-8"
              >
                <div className="text-center mb-8">
                  <h2 id="resume-modal-title" className="font-serif text-2xl italic text-charcoal mb-2">
                    Resume World
                  </h2>
                  <p className="font-sans text-xs tracking-widest text-charcoal/60 uppercase">
                    Choose how to resume your server
                  </p>
                </div>

                <div className="space-y-4">
                  {/* Start Fresh Button - Prominent */}
                  <LuxuryButton onClick={handleStartFresh} className="w-full">
                    Start Fresh World
                  </LuxuryButton>

                  {/* Restore from Backup Button - Secondary */}
                  <LuxuryButton onClick={handleRestoreClick} variant="text" className="w-full text-center">
                    Restore from Backup
                  </LuxuryButton>
                </div>
              </motion.div>
            )}

            {/* Backups View */}
            {view === "backups" && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="p-5 pt-14 sm:p-8"
              >
                <div className="text-center mb-8">
                  <h2 id="resume-backups-title" className="font-serif text-2xl italic text-charcoal mb-2">
                    Select Backup
                  </h2>
                  <p className="font-sans text-xs tracking-widest text-charcoal/60 uppercase">
                    Choose a backup to restore
                  </p>
                </div>

                {/* Error State */}
                {error && (
                  <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-sm">
                    <p role="alert" aria-live="assertive" className="font-sans text-xs text-red-800 text-center">
                      {error}
                    </p>
                  </div>
                )}

                {/* Backups List */}
                <BackupSelectionList
                  backups={backups.map((b) => b.name)}
                  selectedBackup={selectedBackup}
                  onSelect={setSelectedBackup}
                  isLoading={isLoading}
                />

                {/* Action Buttons */}
                <div className="space-y-3">
                  <LuxuryButton
                    onClick={handleConfirmRestore}
                    disabled={!selectedBackup || isLoading}
                    className="w-full"
                  >
                    Confirm Restore
                  </LuxuryButton>

                  <LuxuryButton onClick={handleBackToChoice} variant="text" className="w-full text-center">
                    Back
                  </LuxuryButton>
                </div>
              </motion.div>
            )}
          </motion.div>
        </motion.div>
      )}
    </>
  );
};
