"use client";

import { useAccessibleDialog } from "@/hooks/useAccessibleDialog";
import { pollBackups } from "@/lib/backups-polling";
import { fetchBackups as fetchBackupsApi, queryKeys } from "@/lib/client-api";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackupSelectionList } from "./BackupSelectionList";

interface RestoreDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (backupName: string) => void;
}

export const RestoreDialog = ({ open, onOpenChange, onConfirm }: RestoreDialogProps) => {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const fetchControllerRef = useRef<AbortController | null>(null);

  const [backupName, setBackupName] = useState("");
  const [backups, setBackups] = useState<string[]>([]);
  const [selectedBackup, setSelectedBackup] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useAccessibleDialog(open, () => onOpenChange(false));

  // Fetch backups with polling for caching status
  const fetchBackups = useCallback(async () => {
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

      if (!controller.signal.aborted && data?.backups) {
        setBackups(data.backups.map((backup) => backup.name));
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      const errorMessage = err instanceof Error ? err.message : "Failed to fetch backups";
      setError(errorMessage);
      // Don't clear backups on error - manual input still works
    } finally {
      if (fetchControllerRef.current === controller) {
        setIsLoading(false);
        fetchControllerRef.current = null;
      }
    }
  }, [queryClient]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setBackupName("");
      setBackups([]);
      setSelectedBackup(null);
      setIsLoading(false);
      setError(null);
    } else {
      // Fetch backups when dialog opens
      void fetchBackups();
    }
    return () => {
      fetchControllerRef.current?.abort();
      void queryClient.cancelQueries({ queryKey: queryKeys.backups(false) });
    };
  }, [open, fetchBackups, queryClient]);

  // Sync input with selected backup
  useEffect(() => {
    if (selectedBackup) {
      setBackupName(selectedBackup);
    }
  }, [selectedBackup]);

  const handleClickOutside = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onOpenChange(false);
    }
  };

  const handleConfirm = () => {
    const trimmedName = backupName.trim();
    if (trimmedName) {
      onConfirm(trimmedName);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setBackupName(value);
    // Clear selected backup if user types manually
    if (selectedBackup && value !== selectedBackup) {
      setSelectedBackup(null);
    }
  };

  const handleBackupSelect = (backup: string) => {
    setSelectedBackup(backup);
    setBackupName(backup);
  };

  const isConfirmDisabled = !backupName.trim();

  return (
    <>
      {open && (
        <motion.div
          data-testid="restore-dialog"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={handleClickOutside}
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-2 sm:items-center sm:p-4"
          // biome-ignore lint/a11y/useSemanticElements: Using motion.div for Framer Motion animations
          role="dialog"
          aria-modal="true"
          aria-labelledby="restore-dialog-title"
          aria-describedby="restore-dialog-description"
        >
          <motion.div
            ref={modalRef}
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
              onClick={() => onOpenChange(false)}
              className="absolute top-4 right-4 text-charcoal/40 hover:text-charcoal transition-colors z-10 sm:top-6 sm:right-6"
              aria-label="Close dialog"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            <div className="p-5 pt-14 sm:p-8">
              {/* Title and Description */}
              <div className="mb-6">
                <h2 id="restore-dialog-title" className="font-serif text-2xl italic mb-3 text-charcoal">
                  Restore Backup
                </h2>
                <p id="restore-dialog-description" className="font-sans text-sm text-charcoal/70 leading-relaxed">
                  Select a backup to restore from Google Drive. The server will be stopped and replaced with the
                  selected backup.
                </p>
              </div>

              {/* Error State */}
              {error && (
                <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-sm">
                  <p role="alert" aria-live="assertive" className="font-sans text-xs text-red-800 text-center">
                    {error}
                  </p>
                  <p className="font-sans text-xs text-red-600 text-center mt-1">
                    You can still manually enter a backup name below.
                  </p>
                </div>
              )}

              {/* Backup Selection List */}
              {(backups.length > 0 || isLoading) && (
                <div className="mb-6">
                  <div className="block font-sans text-xs tracking-widest text-charcoal/60 uppercase mb-2">
                    Available Backups
                  </div>
                  <BackupSelectionList
                    backups={backups}
                    selectedBackup={selectedBackup}
                    onSelect={handleBackupSelect}
                    isLoading={isLoading}
                  />
                </div>
              )}

              {/* Manual Input */}
              <div className="mb-6">
                <label
                  htmlFor="restore-backup-input"
                  className="block font-sans text-xs tracking-widest text-charcoal/60 uppercase mb-2"
                >
                  Backup Name
                </label>
                <input
                  ref={inputRef}
                  data-dialog-initial-focus
                  id="restore-backup-input"
                  data-testid="restore-backup-input"
                  type="text"
                  value={backupName}
                  onChange={handleInputChange}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !isConfirmDisabled) {
                      handleConfirm();
                    }
                  }}
                  className={cn(
                    "w-full px-4 py-3 border bg-white/50",
                    "font-sans text-sm text-charcoal",
                    "focus:outline-none focus:ring-2",
                    "border-charcoal/20 focus:border-green focus:ring-green/20",
                    "transition-all duration-300"
                  )}
                  placeholder="Enter backup name..."
                />
                <p className="mt-2 text-xs text-charcoal/50">
                  {selectedBackup
                    ? `Selected: ${selectedBackup}`
                    : "Type a backup name manually or select from the list above."}
                </p>
              </div>

              {/* Confirmation Summary */}
              {backupName.trim() && (
                <div className="mb-6 p-4 bg-green/5 border border-green/20 rounded-sm">
                  <p className="font-sans text-xs text-charcoal/70">
                    <span className="font-semibold text-charcoal">Restore backup:</span> {backupName.trim()}
                  </p>
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex flex-col gap-3 min-[360px]:flex-row">
                <motion.button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  className={cn(
                    "flex-1 px-6 py-3 border border-charcoal/20",
                    "font-sans text-xs tracking-[0.2em] font-medium uppercase text-charcoal/70",
                    "hover:text-charcoal hover:border-charcoal/40",
                    "transition-all duration-300"
                  )}
                >
                  Cancel
                </motion.button>
                <motion.button
                  type="button"
                  data-testid="restore-confirm"
                  onClick={handleConfirm}
                  disabled={isConfirmDisabled}
                  whileHover={isConfirmDisabled ? undefined : { scale: 1.02 }}
                  whileTap={isConfirmDisabled ? undefined : { scale: 0.98 }}
                  className={cn(
                    "flex-1 px-6 py-3 border overflow-hidden relative",
                    "font-sans text-xs tracking-[0.2em] font-medium uppercase",
                    "transition-all duration-300",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    "border-green text-green hover:bg-green hover:text-white"
                  )}
                >
                  <span className="relative z-10">Restore</span>
                  {!isConfirmDisabled && (
                    <motion.div
                      className="absolute inset-0 bg-green"
                      initial={{ scaleX: 0, originX: 0 }}
                      whileHover={{ scaleX: 1 }}
                      transition={{ duration: 0.3, ease: "easeOut" }}
                    />
                  )}
                </motion.button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </>
  );
};
