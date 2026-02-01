"use client";

import { BackupSelectionList } from "@/components/backup";
import { LuxuryButton } from "@/components/ui/Button";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";

interface BackupInfo {
  name: string;
}

interface ResumeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onResume: (backupName?: string) => void;
}

export const ResumeModal = ({ isOpen, onClose, onResume }: ResumeModalProps) => {
  const [view, setView] = useState<"choice" | "backups">("choice");
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [selectedBackup, setSelectedBackup] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setView("choice");
      setBackups([]);
      setSelectedBackup(null);
      setIsLoading(false);
      setError(null);
    }
  }, [isOpen]);

  // Fetch backups when switching to backup view
  const fetchBackups = async () => {
    setIsLoading(true);
    setError(null);

    let attempts = 0;
    const maxAttempts = 10; // 30 seconds max

    // Helper to check backup status
    // I'll use a standard loop or local helper.
    // simpler:

    try {
      const check = async () => {
        const res = await fetch("/api/backups");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        return data.data;
      };

      let data = await check();
      while (data.status === "caching" && attempts < maxAttempts) {
        attempts++;
        await new Promise((r) => setTimeout(r, 3000));
        data = await check();
      }

      setBackups(data.backups || []);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to fetch backups";
      setError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRestoreClick = async () => {
    setView("backups");
    void fetchBackups();
  };

  const handleConfirmRestore = () => {
    if (selectedBackup) {
      onResume(selectedBackup);
    }
  };

  const handleBackToChoice = () => {
    setView("choice");
    setSelectedBackup(null);
    setError(null);
  };

  const handleStartFresh = () => {
    onResume(undefined);
  };

  const handleClickOutside = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          data-testid="resume-modal"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={handleClickOutside}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        >
          {/* Modal Container */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="relative w-full max-w-lg mx-4 bg-cream rounded-sm shadow-xl border border-charcoal/10"
          >
            {/* Close Button */}
            <button
              type="button"
              onClick={onClose}
              className="absolute top-6 right-6 text-charcoal/40 hover:text-charcoal transition-colors z-10"
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
                className="p-8"
              >
                <div className="text-center mb-8">
                  <h2 className="font-serif text-2xl italic text-charcoal mb-2">Resume World</h2>
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
                className="p-8"
              >
                <div className="text-center mb-8">
                  <h2 className="font-serif text-2xl italic text-charcoal mb-2">Select Backup</h2>
                  <p className="font-sans text-xs tracking-widest text-charcoal/60 uppercase">
                    Choose a backup to restore
                  </p>
                </div>

                {/* Error State */}
                {error && (
                  <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-sm">
                    <p className="font-sans text-xs text-red-800 text-center">{error}</p>
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
    </AnimatePresence>
  );
};
