"use client";

import { LuxuryButton } from "@/components/ui/Button";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

interface GoogleDriveSetupPromptProps {
  isOpen: boolean;
  onClose: () => void;
  onSetupComplete: () => void;
  onSkip?: () => void;
  allowSkip?: boolean;
  context?: "deploy" | "backup" | "restore";
}

export const GoogleDriveSetupPrompt = ({
  isOpen,
  onClose,
  onSetupComplete,
  onSkip,
  allowSkip = true,
  context = "deploy",
}: GoogleDriveSetupPromptProps) => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setIsLoading(false);
      setError(null);
      // Clear any pending poll interval
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    }
  }, [isOpen]);

  // Handle OAuth flow
  const handleSetupClick = async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Get OAuth URL from API
      const res = await fetch("/api/gdrive/setup");
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to get OAuth URL");
      }

      const authUrl = data.data?.authUrl;
      if (!authUrl) {
        throw new Error("No authorization URL returned");
      }

      // Open OAuth in popup window
      const popup = window.open(authUrl, "google-oauth", "width=500,height=600,scrollbars=yes,resizable=yes");

      if (!popup) {
        throw new Error("Popup blocked. Please allow popups and try again.");
      }

      // Listen for OAuth completion via window message
      const messageHandler = (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return;

        const isSuccess = event.data?.type === "GDRIVE_OAUTH_SUCCESS";
        const isError = event.data?.type === "GDRIVE_OAUTH_ERROR";

        if (!isSuccess && !isError) return;

        popup.close();
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
        window.removeEventListener("message", messageHandler);
        setIsLoading(false);

        if (isSuccess) {
          onSetupComplete();
        } else {
          setError(event.data?.error || "OAuth failed");
        }
      };

      window.addEventListener("message", messageHandler);

      // Fallback: Poll popup to detect closure (user closed without completing)
      pollIntervalRef.current = setInterval(() => {
        if (popup.closed) {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          window.removeEventListener("message", messageHandler);
          setIsLoading(false);
          // Don't set error - user may have intentionally closed
        }
      }, 1000);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to start OAuth flow";
      setError(errorMessage);
      setIsLoading(false);
      console.error("Google Drive setup error:", err);
    }
  };

  const handleSkipClick = () => {
    onSkip?.();
    onClose();
  };

  const handleClickOutside = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  // Determine messaging based on context
  const getTitle = () => {
    switch (context) {
      case "backup":
      case "restore":
        return "Google Drive Required";
      default:
        return "Set Up Backups";
    }
  };

  const getSubtitle = () => {
    switch (context) {
      case "backup":
        return "Configure Google Drive to create backups";
      case "restore":
        return "Configure Google Drive to restore backups";
      default:
        return "Configure Google Drive for automatic backups";
    }
  };

  const getDescription = () => {
    switch (context) {
      case "backup":
      case "restore":
        return "Google Drive is required for this operation. Once connected, your backups will be securely stored in your Google Drive account.";
      default:
        return "Set up Google Drive to automatically backup your Minecraft world. This helps protect your progress and allows you to restore from previous states.";
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          data-testid="gdrive-setup-prompt"
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
              aria-label="Close modal"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="p-8"
            >
              {/* Header */}
              <div className="text-center mb-8">
                <h2 className="font-serif text-2xl italic text-charcoal mb-2">{getTitle()}</h2>
                <p className="font-sans text-xs tracking-widest text-charcoal/60 uppercase">{getSubtitle()}</p>
              </div>

              {/* Description */}
              <div className="mb-8">
                <p className="font-sans text-sm text-charcoal/80 text-center leading-relaxed">{getDescription()}</p>
              </div>

              {/* Error State */}
              {error && (
                <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-sm">
                  <p className="font-sans text-xs text-red-800 text-center">{error}</p>
                </div>
              )}

              {/* Action Buttons */}
              <div className="space-y-4">
                {/* Set Up Google Drive Button - Primary */}
                <LuxuryButton onClick={handleSetupClick} disabled={isLoading} className="w-full">
                  {isLoading ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg
                        className="animate-spin h-4 w-4"
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                      >
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        />
                      </svg>
                      Connecting...
                    </span>
                  ) : (
                    "Set Up Google Drive"
                  )}
                </LuxuryButton>

                {/* Skip Button - Secondary */}
                {allowSkip && (
                  <LuxuryButton onClick={handleSkipClick} variant="text" className="w-full text-center">
                    Skip for Now
                  </LuxuryButton>
                )}
              </div>
            </motion.div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
