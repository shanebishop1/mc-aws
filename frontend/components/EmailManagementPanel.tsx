"use client";

import { motion, AnimatePresence } from "framer-motion";
import { EmailListItem, AddEmailForm } from "@/components/email";
import { useEmailData } from "@/hooks/useEmailData";

interface EmailManagementPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function EmailManagementPanel({ isOpen, onClose }: EmailManagementPanelProps) {
  const {
    adminEmail,
    allowlist,
    setAllowlist,
    isLoading,
    isRefetching,
    error,
    hasChanges,
    refetch,
    saveAllowlist,
    isSaving,
  } = useEmailData();

  const handleAdd = (email: string) => {
    if (!allowlist.includes(email)) {
      setAllowlist([...allowlist, email]);
    }
  };

  const handleRemove = (email: string) => {
    setAllowlist(allowlist.filter((e) => e !== email));
  };

  const handleSave = async () => {
    const success = await saveAllowlist();
    if (success) {
      onClose();
    }
  };

  const handleClickOutside = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !hasChanges) {
      onClose();
    }
  };

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
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="relative w-full max-w-lg mx-4 bg-luxury-cream rounded-sm shadow-xl border border-luxury-black/10"
          >
            <button
              type="button"
              onClick={onClose}
              disabled={isLoading || isSaving}
              className="absolute top-6 right-6 text-luxury-black/40 hover:text-luxury-black transition-colors z-10 disabled:cursor-not-allowed"
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
              <div className="flex items-center justify-between mb-8">
                <div className="text-center flex-1">
                  <h2 className="font-serif text-2xl italic text-luxury-black mb-2">
                    Email Management
                  </h2>
                  <p className="font-sans text-xs tracking-widest text-luxury-black/60 uppercase">
                    Configure email access and notifications
                  </p>
                </div>
                <button
                  type="button"
                  onClick={refetch}
                  disabled={isLoading || isRefetching}
                  className="ml-4 text-luxury-black/40 hover:text-luxury-green transition-colors disabled:opacity-50"
                  title="Refresh"
                >
                  <svg
                    className={`w-5 h-5 ${isRefetching ? "animate-spin" : ""}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                </button>
              </div>

              {isLoading ? (
                <div className="py-12 flex items-center justify-center">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 2, repeat: Number.POSITIVE_INFINITY, ease: "linear" }}
                    className="w-8 h-8 border-2 border-luxury-green border-t-transparent rounded-full"
                  />
                </div>
              ) : (
                <>
                  {error && (
                    <motion.div
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mb-6 p-4 bg-red-50 border border-red-200 rounded-sm"
                    >
                      <p className="font-sans text-xs text-red-800 text-center">{error}</p>
                    </motion.div>
                  )}

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

                  <div className="mb-8">
                    <div className="block font-sans text-xs tracking-widest text-luxury-black/60 uppercase mb-3">
                      Allowed Emails
                    </div>

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

                    {allowlist.length > 0 && (
                      <div className="space-y-2 mb-4 max-h-40 overflow-y-auto">
                        {allowlist.map((email) => (
                          <EmailListItem
                            key={email}
                            email={email}
                            onRemove={handleRemove}
                            disabled={isSaving}
                          />
                        ))}
                      </div>
                    )}

                    <AddEmailForm onAdd={handleAdd} disabled={isSaving} />
                  </div>

                  <div className="space-y-3">
                    <button
                      type="button"
                      onClick={handleSave}
                      disabled={!hasChanges || isSaving}
                      className="w-full px-4 py-3 font-sans text-sm text-white bg-luxury-green rounded-sm hover:bg-luxury-green/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {isSaving ? "Saving..." : "Save Changes"}
                    </button>

                    <button
                      type="button"
                      onClick={onClose}
                      disabled={isSaving}
                      className="w-full px-4 py-3 font-sans text-sm text-luxury-black/60 hover:text-luxury-black transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {hasChanges ? "Discard & Close" : "Close"}
                    </button>
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
