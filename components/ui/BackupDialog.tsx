"use client";

import { useAccessibleDialog } from "@/hooks/useAccessibleDialog";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { useEffect, useLayoutEffect, useState } from "react";

interface BackupDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (backupName: string) => void;
  isLoading?: boolean;
}

const generateDefaultBackupName = (): string => {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toTimeString().slice(0, 8).replace(/:/g, "");
  return `server-${date}-${time}`;
};

export const BackupDialog = ({ isOpen, onClose, onConfirm, isLoading = false }: BackupDialogProps) => {
  const [backupName, setBackupName] = useState("");
  const modalRef = useAccessibleDialog(isOpen, onClose, !isLoading);

  // Reset and set default name when modal opens
  useEffect(() => {
    if (isOpen) {
      const defaultName = generateDefaultBackupName();
      setBackupName(defaultName);
    }
  }, [isOpen]);

  useLayoutEffect(() => {
    if (isOpen && isLoading) modalRef.current?.focus();
  }, [isLoading, isOpen, modalRef]);

  const handleClickOutside = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !isLoading) {
      onClose();
    }
  };

  const handleConfirm = () => {
    const trimmedName = backupName.trim();
    onConfirm(trimmedName || generateDefaultBackupName());
  };

  const isConfirmDisabled = isLoading || !backupName.trim();

  return (
    <>
      {isOpen && (
        <motion.div
          data-testid="backup-dialog"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={handleClickOutside as React.MouseEventHandler<HTMLDivElement>}
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-2 sm:items-center sm:p-4"
          // biome-ignore lint/a11y/useSemanticElements: Using motion.div for Framer Motion animations
          role="dialog"
          aria-modal="true"
          aria-labelledby="dialog-title"
          aria-describedby="dialog-description"
        >
          <motion.div
            ref={modalRef}
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="relative w-full max-w-md max-h-[calc(100dvh-1rem)] overflow-y-auto bg-cream rounded-sm shadow-xl border border-charcoal/10 sm:max-h-[calc(100dvh-2rem)]"
          >
            {/* Close Button */}
            <button
              type="button"
              onClick={onClose}
              disabled={isLoading}
              className="absolute top-4 right-4 text-charcoal/40 hover:text-charcoal transition-colors z-10 disabled:cursor-not-allowed disabled:opacity-50 sm:top-6 sm:right-6"
              aria-label="Close dialog"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            <div className="p-5 pt-14 sm:p-8">
              {/* Title and Description */}
              <div className="mb-6">
                <h2 id="dialog-title" className="font-serif text-2xl italic mb-3 text-charcoal">
                  Backup Server
                </h2>
                <p id="dialog-description" className="font-sans text-sm text-charcoal/70 leading-relaxed">
                  Create a backup of your server and upload it to Google Drive. The process may take a few minutes.
                </p>
              </div>

              {/* Backup Name Input */}
              <div className="mb-6">
                <label
                  htmlFor="backup-name"
                  className="block font-sans text-xs tracking-widest text-charcoal/60 uppercase mb-2"
                >
                  Backup Name
                </label>
                <input
                  data-dialog-initial-focus
                  id="backup-name"
                  type="text"
                  value={backupName}
                  onChange={(e) => setBackupName(e.target.value)}
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
                  placeholder="server-YYYYMMDD-HHMMSS"
                  disabled={isLoading}
                />
                <p className="mt-2 text-xs text-charcoal/50">
                  Edit the name or leave as default. The backup will be saved to the <strong>mc-backups</strong> folder
                  on Google Drive.
                </p>
              </div>

              {/* Action Buttons */}
              <div className="flex gap-3">
                <motion.button
                  type="button"
                  onClick={onClose}
                  disabled={isLoading}
                  whileHover={isLoading ? {} : { scale: 1.02 }}
                  whileTap={isLoading ? {} : { scale: 0.98 }}
                  className={cn(
                    "flex-1 px-6 py-3 border border-charcoal/20",
                    "font-sans text-xs tracking-[0.2em] font-medium uppercase text-charcoal/70",
                    "hover:text-charcoal hover:border-charcoal/40",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    "transition-all duration-300"
                  )}
                >
                  Cancel
                </motion.button>
                <motion.button
                  type="button"
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
                  <span className="relative z-10">{isLoading ? "Backing up..." : "Backup"}</span>
                  {!isLoading && !isConfirmDisabled && (
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
