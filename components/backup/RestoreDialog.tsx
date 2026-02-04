"use client";

import { cn } from "@/lib/utils";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackupSelectionList } from "./BackupSelectionList";

interface RestoreDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (backupName: string) => void;
}

interface BackupInfo {
  name: string;
}

interface BackupsResponse {
  backups: BackupInfo[];
  count: number;
  status?: "listing" | "caching" | "error";
  cachedAt?: number;
}

export const RestoreDialog = ({ open, onOpenChange, onConfirm }: RestoreDialogProps) => {
  const modalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [backupName, setBackupName] = useState("");
  const [backups, setBackups] = useState<string[]>([]);
  const [selectedBackup, setSelectedBackup] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch backups with polling for caching status
  const fetchBackups = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    let attempts = 0;
    const maxAttempts = 10; // 30 seconds max (3s * 10)

    try {
      const check = async () => {
        const res = await fetch("/api/backups");
        const data = (await res.json()) as { data?: BackupsResponse; error?: string };
        if (!res.ok) throw new Error(data.error || "Failed to fetch backups");
        return data.data;
      };

      let data = await check();
      while (data?.status === "caching" && attempts < maxAttempts) {
        attempts++;
        await new Promise((resolve) => setTimeout(resolve, 3000));
        data = await check();
      }

      if (data?.backups) {
        setBackups(data.backups.map((b) => b.name));
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to fetch backups";
      setError(errorMessage);
      // Don't clear backups on error - manual input still works
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setBackupName("");
      setBackups([]);
      setSelectedBackup(null);
      setIsLoading(false);
      setError(null);
    } else {
      // Focus input when dialog opens
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
      // Fetch backups when dialog opens
      void fetchBackups();
    }
  }, [open, fetchBackups]);

  // Sync input with selected backup
  useEffect(() => {
    if (selectedBackup) {
      setBackupName(selectedBackup);
    }
  }, [selectedBackup]);

  // Focus trap
  useEffect(() => {
    if (!open) return;

    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !modalRef.current) return;

      const focusableElements = modalRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );

      if (focusableElements.length === 0) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (e.shiftKey && document.activeElement === firstElement) {
        lastElement.focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === lastElement) {
        firstElement.focus();
        e.preventDefault();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isLoading) {
        onOpenChange(false);
      }
    };

    document.addEventListener("keydown", handleTab);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("keydown", handleTab);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open, onOpenChange, isLoading]);

  const handleClickOutside = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !isLoading) {
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
    <AnimatePresence>
      {open && (
        <motion.div
          data-testid="restore-dialog"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={handleClickOutside}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          // biome-ignore lint/a11y/useSemanticElements: Using motion.div for Framer Motion animations
          role="dialog"
          aria-modal="true"
          aria-labelledby="restore-dialog-title"
          aria-describedby="restore-dialog-description"
        >
          <motion.div
            ref={modalRef}
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="relative w-full max-w-lg mx-4 bg-cream rounded-sm shadow-xl border border-charcoal/10"
          >
            {/* Close Button */}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="absolute top-6 right-6 text-charcoal/40 hover:text-charcoal transition-colors z-10"
              aria-label="Close dialog"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            <div className="p-8">
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
                  <p className="font-sans text-xs text-red-800 text-center">{error}</p>
                  <p className="font-sans text-xs text-red-600 text-center mt-1">
                    You can still manually enter a backup name below.
                  </p>
                </div>
              )}

              {/* Backup Selection List */}
              {backups.length > 0 && (
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
              <div className="flex gap-3">
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
                  <span className="relative z-10">
                    {backupName.trim() ? `Restore "${backupName.trim()}"` : "Select Backup"}
                  </span>
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
    </AnimatePresence>
  );
};
