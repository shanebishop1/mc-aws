"use client";

import { cn } from "@/lib/utils";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

interface ConfirmationDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  requireTypedConfirmation?: string;
  variant?: "default" | "danger";
  isLoading?: boolean;
}

export const ConfirmationDialog = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmText = "Confirm",
  cancelText = "Cancel",
  requireTypedConfirmation,
  variant = "default",
  isLoading = false,
}: ConfirmationDialogProps) => {
  const modalRef = useRef<HTMLDivElement>(null);
  const [typedConfirmation, setTypedConfirmation] = useState("");

  // Reset typed confirmation when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setTypedConfirmation("");
    }
  }, [isOpen]);

  // Focus trap
  useEffect(() => {
    if (!isOpen) return;

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
        onClose();
      }
    };

    document.addEventListener("keydown", handleTab);
    document.addEventListener("keydown", handleEscape);

    // Focus first focusable element when modal opens
    const firstFocusable = modalRef.current?.querySelector(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    ) as HTMLElement;
    firstFocusable?.focus();

    return () => {
      document.removeEventListener("keydown", handleTab);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, onClose, isLoading]);

  const handleClickOutside = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !isLoading) {
      onClose();
    }
  };

  const handleConfirm = () => {
    if (requireTypedConfirmation && typedConfirmation !== requireTypedConfirmation) {
      return;
    }
    onConfirm();
  };

  const isConfirmDisabled = Boolean(
    isLoading || (requireTypedConfirmation && typedConfirmation !== requireTypedConfirmation)
  );
  const isDanger = variant === "danger";

  const renderCancelButton = () => (
    <motion.button
      type="button"
      onClick={onClose}
      disabled={isLoading ?? false}
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
      {cancelText}
    </motion.button>
  );

  const renderConfirmButton = () => (
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
        isDanger
          ? "border-red-600 text-red-600 hover:bg-red-600 hover:text-white"
          : "border-green text-green hover:bg-green hover:text-white"
      )}
    >
      <span className="relative z-10">{isLoading ? "Loading..." : confirmText}</span>
      {!isLoading && !isConfirmDisabled && (
        <motion.div
          className={cn("absolute inset-0", isDanger ? "bg-red-600" : "bg-green")}
          initial={{ scaleX: 0, originX: 0 }}
          whileHover={{ scaleX: 1 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
        />
      )}
    </motion.button>
  );

  const renderButtons = () => (
    <div className="flex gap-3">
      {renderCancelButton()}
      {renderConfirmButton()}
    </div>
  );

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          data-testid="confirmation-dialog"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={handleClickOutside as React.MouseEventHandler<HTMLDivElement>}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          // biome-ignore lint/a11y/useSemanticElements: Using motion.div for Framer Motion animations
          role="dialog"
          aria-modal="true"
          aria-labelledby="dialog-title"
          aria-describedby="dialog-description"
        >
          <motion.div
            ref={modalRef}
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="relative w-full max-w-md mx-4 bg-cream rounded-sm shadow-xl border border-charcoal/10"
          >
            {/* Close Button */}
            <button
              type="button"
              onClick={onClose}
              disabled={isLoading ?? false}
              className="absolute top-6 right-6 text-charcoal/40 hover:text-charcoal transition-colors z-10 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Close dialog"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            <div className="p-8">
              {/* Title and Description */}
              <div className="mb-6">
                <h2
                  id="dialog-title"
                  className={cn("font-serif text-2xl italic mb-3", isDanger ? "text-red-600" : "text-charcoal")}
                >
                  {title}
                </h2>
                <p id="dialog-description" className="font-sans text-sm text-charcoal/70 leading-relaxed">
                  {description}
                </p>
              </div>

              {/* Typed Confirmation Input */}
              {requireTypedConfirmation && (
                <div className="mb-6">
                  <label
                    htmlFor="typed-confirmation"
                    className="block font-sans text-xs tracking-widest text-charcoal/60 uppercase mb-2"
                  >
                    Type &quot;{requireTypedConfirmation}&quot; to confirm
                  </label>
                  <input
                    id="typed-confirmation"
                    type="text"
                    value={typedConfirmation}
                    onChange={(e) => setTypedConfirmation(e.target.value)}
                    className={cn(
                      "w-full px-4 py-3 border bg-white/50",
                      "font-sans text-sm text-charcoal",
                      "focus:outline-none focus:ring-2",
                      isDanger
                        ? "border-red-300 focus:border-red-500 focus:ring-red-500/20"
                        : "border-charcoal/20 focus:border-green focus:ring-green/20",
                      "transition-all duration-300"
                    )}
                    placeholder={requireTypedConfirmation}
                    disabled={isLoading}
                  />
                </div>
              )}

              {/* Action Buttons */}
              {renderButtons()}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
