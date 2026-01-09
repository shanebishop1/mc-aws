"use client";

import { motion } from "framer-motion";

interface EmailListItemProps {
  email: string;
  onRemove: (email: string) => void;
  disabled: boolean;
}

export const EmailListItem = ({ email, onRemove, disabled }: EmailListItemProps) => {
  return (
    <motion.div
      data-testid="email-list-item"
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 10 }}
      className="flex items-center justify-between p-3 bg-cream/50 border border-charcoal/10 rounded-sm"
    >
      <span className="font-sans text-sm text-charcoal">{email}</span>
      <button
        type="button"
        onClick={() => onRemove(email)}
        disabled={disabled}
        className="text-charcoal/40 hover:text-red-500 transition-colors disabled:opacity-50"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </motion.div>
  );
};
