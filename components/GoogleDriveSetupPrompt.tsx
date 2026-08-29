"use client";

import { LuxuryButton } from "@/components/ui/Button";
import { useAccessibleDialog } from "@/hooks/useAccessibleDialog";
import { fetchGDriveSetup } from "@/lib/client-api";
import { motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";

interface GoogleDriveSetupPromptProps {
  isOpen: boolean;
  onClose: () => void;
  onSetupComplete: () => void;
  onSkip?: () => void;
  allowSkip?: boolean;
  context?: "backup" | "restore";
}

export const GoogleDriveSetupPrompt = ({
  isOpen,
  onClose,
  onSetupComplete,
  onSkip,
  allowSkip = true,
  context = "backup",
}: GoogleDriveSetupPromptProps) => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const popupRef = useRef<Window | null>(null);
  const messageHandlerRef = useRef<((event: MessageEvent) => void) | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const workflowRef = useRef(0);
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const dialogRef = useAccessibleDialog(isOpen, onClose);

  const cleanupOAuth = useCallback(() => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = null;
    if (messageHandlerRef.current) window.removeEventListener("message", messageHandlerRef.current);
    messageHandlerRef.current = null;
    popupRef.current?.close();
    popupRef.current = null;
  }, []);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      workflowRef.current += 1;
      cleanupOAuth();
      setIsLoading(false);
      setError(null);
    }
  }, [cleanupOAuth, isOpen]);

  useEffect(() => () => cleanupOAuth(), [cleanupOAuth]);

  const isWorkflowActive = useCallback(
    (workflow: number, signal?: AbortSignal) =>
      workflow === workflowRef.current && isOpenRef.current && signal?.aborted !== true,
    []
  );

  // Handle OAuth flow
  const handleSetupClick = async () => {
    cleanupOAuth();
    const workflow = ++workflowRef.current;
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setIsLoading(true);
    setError(null);

    try {
      const data = await fetchGDriveSetup(controller.signal);
      if (!isWorkflowActive(workflow, controller.signal)) return;

      const authUrl = data.data?.authUrl;
      if (!authUrl) {
        throw new Error("No authorization URL returned");
      }

      // Open OAuth in popup window
      const popup = window.open(authUrl, "google-oauth", "width=500,height=600,scrollbars=yes,resizable=yes");

      if (!popup) {
        throw new Error("Popup blocked. Please allow popups and try again.");
      }
      popupRef.current = popup;

      // Listen for OAuth completion via window message
      const messageHandler = (event: MessageEvent) => {
        if (!isWorkflowActive(workflow) || event.origin !== window.location.origin) return;

        const messageType = event.data?.type;
        if (!["GDRIVE_OAUTH_SUCCESS", "GDRIVE_OAUTH_ERROR"].includes(messageType)) return;

        cleanupOAuth();
        setIsLoading(false);

        if (messageType === "GDRIVE_OAUTH_SUCCESS") {
          onSetupComplete();
        } else {
          setError(event.data?.error || "OAuth failed");
        }
      };

      messageHandlerRef.current = messageHandler;
      window.addEventListener("message", messageHandler);

      // Fallback: Poll popup to detect closure (user closed without completing)
      pollIntervalRef.current = setInterval(() => {
        if (popup.closed) {
          cleanupOAuth();
          if (!isWorkflowActive(workflow)) return;
          setIsLoading(false);
          // Don't set error - user may have intentionally closed
        }
      }, 1000);
    } catch (err) {
      if (!isWorkflowActive(workflow, controller.signal)) return;
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
    return "Google Drive Required";
  };

  const getSubtitle = () => {
    switch (context) {
      case "backup":
        return "Connect Google Drive to create backups";
      case "restore":
        return "Connect Google Drive to restore backups";
    }
  };

  const getDescription = () => {
    return "Google Drive is required for this operation. Once connected, your backups will be securely stored in your Google Drive account.";
  };

  return (
    <>
      {isOpen && (
        <motion.div
          data-testid="gdrive-setup-prompt"
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
            aria-labelledby="gdrive-prompt-title"
            aria-describedby="gdrive-prompt-description"
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
              className="absolute top-4 right-4 text-charcoal/40 hover:text-charcoal transition-colors z-10 disabled:opacity-50 sm:top-6 sm:right-6"
              aria-label="Close Google Drive setup"
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
              className="p-5 pt-14 sm:p-8"
            >
              {/* Header */}
              <div className="text-center mb-8">
                <h2 id="gdrive-prompt-title" className="font-serif text-2xl italic text-charcoal mb-2">
                  {getTitle()}
                </h2>
                <p className="font-sans text-xs tracking-widest text-charcoal/60 uppercase">{getSubtitle()}</p>
              </div>

              {/* Description */}
              <div className="mb-8">
                <p
                  id="gdrive-prompt-description"
                  className="font-sans text-sm text-charcoal/80 text-center leading-relaxed"
                >
                  {getDescription()}
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
    </>
  );
};
