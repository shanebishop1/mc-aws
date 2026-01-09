"use client";

import { motion } from "framer-motion";

interface BackupSelectionListProps {
  backups: string[];
  selectedBackup: string | null;
  onSelect: (backup: string) => void;
  isLoading: boolean;
}

export const BackupSelectionList = ({
  backups,
  selectedBackup,
  onSelect,
  isLoading,
}: BackupSelectionListProps) => {
  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <div className="w-6 h-6 border-2 border-green/30 border-t-green rounded-full animate-spin" />
      </div>
    );
  }

  if (backups.length === 0) {
    return (
      <p className="font-sans text-sm text-charcoal/60 text-center py-4">
        No backups available.
      </p>
    );
  }

  return (
    <div className="space-y-2 max-h-64 overflow-y-auto">
      {backups.map((backup, index) => (
        <motion.button
          key={backup}
          type="button"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: index * 0.02 }}
          onClick={() => onSelect(backup)}
          className={`w-full text-left p-3 rounded-sm border transition-colors cursor-pointer ${
            selectedBackup === backup
              ? "border-green bg-green/10"
              : "border-charcoal/10 hover:border-green/50"
          }`}
        >
          <span className="font-sans text-sm text-charcoal">{backup}</span>
        </motion.button>
      ))}
    </div>
  );
}
