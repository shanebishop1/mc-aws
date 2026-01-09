"use client";

import { LuxuryButton } from "@/components/ui/LuxuryButton";
import { motion, AnimatePresence } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";

interface EmailManagementPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function EmailManagementPanel({ isOpen, onClose }: EmailManagementPanelProps) {
  const [adminEmail, setAdminEmail] = useState<string | null>(null);
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setNewEmail("");
      setError(null);
      setSuccessMessage(null);
      setHasChanges(false);
    }
  }, [isOpen]);

  // Fetch emails when modal opens
  useEffect(() => {
    if (!isOpen) return;

    const fetchEmails = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const res = await fetch("/api/emails");
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || "Failed to fetch email settings");
        }

        setAdminEmail(data.data.adminEmail);
        setAllowlist(data.data.allowlist || []);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Failed to fetch email settings";
        setError(errorMessage);
        console.error("Failed to fetch emails:", err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchEmails();
  }, [isOpen]);

  const handleAddEmail = () => {
    const trimmedEmail = newEmail.trim();

    if (!trimmedEmail) {
      setError("Please enter an email address");
      return;
    }

    if (!EMAIL_REGEX.test(trimmedEmail)) {
      setError("Please enter a valid email address");
      return;
    }

    if (allowlist.includes(trimmedEmail)) {
      setError("This email is already in the allowlist");
      return;
    }

    setAllowlist([...allowlist, trimmedEmail]);
    setNewEmail("");
    setError(null);
    setHasChanges(true);
  };

  const handleRemoveEmail = (email: string) => {
    setAllowlist(allowlist.filter((e) => e !== email));
    setHasChanges(true);
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const res = await fetch("/api/emails/allowlist", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails: allowlist }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to save email settings");
      }

      setSuccessMessage("Email allowlist updated successfully");
      setHasChanges(false);

      // Clear success message after 3 seconds
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to save email settings";
      setError(errorMessage);
      console.error("Failed to save emails:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    onClose();
  };

  const handleClickOutside = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !hasChanges) {
      onClose();
    }
  };

  const isFormValid = newEmail.trim() === "" || EMAIL_REGEX.test(newEmail.trim());

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
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
            className="relative w-full max-w-lg mx-4 bg-luxury-cream rounded-sm shadow-xl border border-luxury-black/10"
          >
            {/* Close Button */}
            <button
              type="button"
              onClick={onClose}
              disabled={isLoading || isSaving}
              className="absolute top-6 right-6 text-luxury-black/40 hover:text-luxury-black transition-colors z-10 disabled:cursor-not-allowed"
            >
              <svg
                className="w-6 h-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>

            {/* Content */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="p-8"
            >
              {/* Header */}
              <div className="text-center mb-8">
                <h2 className="font-serif text-2xl italic text-luxury-black mb-2">
                  Email Management
                </h2>
                <p className="font-sans text-xs tracking-widest text-luxury-black/60 uppercase">
                  Configure email access and notifications
                </p>
              </div>

              {/* Loading State */}
              {isLoading && (
                <div className="py-12 flex items-center justify-center">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 2, repeat: Number.POSITIVE_INFINITY, ease: "linear" }}
                    className="w-8 h-8 border-2 border-luxury-green border-t-transparent rounded-full"
                  />
                </div>
              )}

              {/* Main Content */}
              {!isLoading && (
                <>
                  {/* Error State */}
                  {error && (
                    <motion.div
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mb-6 p-4 bg-red-50 border border-red-200 rounded-sm"
                    >
                      <p className="font-sans text-xs text-red-800 text-center">{error}</p>
                    </motion.div>
                  )}

                  {/* Success State */}
                  {successMessage && (
                    <motion.div
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mb-6 p-4 bg-green-50 border border-green-200 rounded-sm"
                    >
                      <p className="font-sans text-xs text-green-800 text-center">{successMessage}</p>
                    </motion.div>
                  )}

                   {/* Admin Email Section */}
                   <div className="mb-8">
                     <div className="block font-sans text-xs tracking-widest text-luxury-black/60 uppercase mb-3">
                       Admin Email
                     </div>
                    <div className="p-4 bg-luxury-black/5 border border-luxury-black/10 rounded-sm">
                      <p className="font-sans text-sm text-luxury-black mb-2">
                        {adminEmail || "—"}
                      </p>
                      <p className="font-sans text-xs text-luxury-black/50">
                        Set at deploy time. Redeploy to change.
                      </p>
                    </div>
                  </div>

                   {/* Allowlist Section */}
                   <div className="mb-8">
                     <div className="block font-sans text-xs tracking-widest text-luxury-black/60 uppercase mb-3">
                       Allowed Emails
                     </div>

{/* Warning if empty */}
                     {allowlist.length === 0 && (
                       <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-sm flex items-start gap-3">
<svg
                          className="w-5 h-5 text-yellow-600 flex-shrink-0 -mt-0.5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                           <path
                             strokeLinecap="round"
                             strokeLinejoin="round"
                             strokeWidth={2}
                             d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                           />
                         </svg>
                         <p className="font-sans text-xs text-yellow-800">
                           Allowlist is empty. Anyone can trigger the server.
                         </p>
                       </div>
                     )}

                    {/* Allowlist Items */}
                    {allowlist.length > 0 && (
                      <div className="space-y-2 mb-4 max-h-40 overflow-y-auto">
                        {allowlist.map((email) => (
                          <motion.div
                            key={email}
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -10 }}
                            className="flex items-center justify-between p-3 bg-luxury-black/5 border border-luxury-black/10 rounded-sm"
                          >
                            <span className="font-sans text-xs text-luxury-black">
                              {email}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleRemoveEmail(email)}
                              disabled={isSaving}
                              className="ml-2 text-luxury-black/40 hover:text-red-600 transition-colors disabled:cursor-not-allowed"
                              title="Remove email"
                            >
                              <svg
                                className="w-4 h-4"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M6 18L18 6M6 6l12 12"
                                />
                              </svg>
                            </button>
                          </motion.div>
                        ))}
                      </div>
                    )}

                    {/* Add Email Input */}
                    <div className="space-y-2">
                      <div className="flex gap-2">
                        <input
                          type="email"
                          value={newEmail}
                          onChange={(e) => {
                            setNewEmail(e.target.value);
                            setError(null);
                          }}
                          onKeyPress={(e) => {
                            if (e.key === "Enter" && isFormValid) {
                              handleAddEmail();
                            }
                          }}
                          placeholder="Enter email to allow..."
                          disabled={isSaving}
                          className="flex-1 px-4 py-2 bg-luxury-cream border border-luxury-black/20 rounded-sm font-sans text-xs text-luxury-black placeholder:text-luxury-black/40 focus:outline-none focus:border-luxury-green focus:ring-1 focus:ring-luxury-green/20 disabled:cursor-not-allowed disabled:opacity-50"
                        />
                        <LuxuryButton
                          onClick={handleAddEmail}
                          disabled={!isFormValid || isSaving || newEmail.trim() === ""}
                          className="px-6"
                        >
                          Add
                        </LuxuryButton>
                      </div>
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div className="space-y-3">
                    <LuxuryButton
                      onClick={handleSave}
                      disabled={!hasChanges || isSaving}
                      className="w-full"
                    >
                      {isSaving ? "Saving..." : "Save Changes"}
                    </LuxuryButton>

                    <LuxuryButton
                      onClick={handleCancel}
                      variant="text"
                      disabled={isSaving}
                      className="w-full text-center disabled:cursor-not-allowed"
                    >
                      {hasChanges ? "Discard & Close" : "Close"}
                    </LuxuryButton>
                  </div>
                </>
              )}
            </motion.div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
