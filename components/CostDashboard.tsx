"use client";

import { CostBreakdownTable } from "@/components/cost";
import { LuxuryButton } from "@/components/ui/Button";
import { useAccessibleDialog } from "@/hooks/useAccessibleDialog";
import { useCostData } from "@/hooks/useCostData";
import { motion } from "framer-motion";
import { useEffect, useState } from "react";

interface CostDashboardProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CostDashboard = ({ isOpen, onClose }: CostDashboardProps) => {
  const { costData, cachedAt, isLoading, error, isStale, setError, fetchCosts, refresh } = useCostData();
  // Show confirmation only if no cached data exists
  const [showConfirmation, setShowConfirmation] = useState(!costData);
  const dialogRef = useAccessibleDialog(isOpen, onClose, !isLoading);

  // Update showConfirmation when costData loads from localStorage
  useEffect(() => {
    if (costData) {
      setShowConfirmation(false);
    }
  }, [costData]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setError(null);
      // Don't reset costData or showConfirmation - keep cache
    }
  }, [isOpen, setError]);

  const handleGenerateReport = () => {
    setShowConfirmation(false);
    void fetchCosts();
  };

  const handleRefresh = async () => {
    await refresh();
  };

  const handleClickOutside = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !isLoading) {
      onClose();
    }
  };

  const formatDate = (dateStr: string): string => {
    const date = new Date(`${dateStr}T00:00:00Z`);
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  return (
    <>
      {isOpen && (
        <motion.div
          data-testid="cost-dashboard"
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
            aria-labelledby="cost-dashboard-title"
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="relative w-full max-w-2xl max-h-[calc(100dvh-1rem)] overflow-y-auto bg-cream rounded-sm shadow-xl border border-charcoal/10 sm:max-h-[calc(100dvh-2rem)]"
          >
            {/* Close Button */}
            <button
              type="button"
              onClick={onClose}
              disabled={isLoading}
              data-dialog-initial-focus
              aria-label="Close cost dashboard"
              className="absolute top-4 right-4 text-charcoal/40 hover:text-charcoal transition-colors z-10 disabled:cursor-not-allowed sm:top-6 sm:right-6"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            {/* Content */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="p-5 pt-14 sm:p-8"
            >
              {/* Header */}
              <div className="text-center mb-8">
                <h2 id="cost-dashboard-title" className="font-serif text-2xl italic text-charcoal mb-2">
                  Cost Dashboard
                </h2>
                <p className="font-sans text-xs tracking-widest text-charcoal/60 uppercase">
                  AWS costs for your Minecraft server
                </p>
              </div>

              {/* Confirmation Screen */}
              {showConfirmation && !costData && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className="space-y-6"
                >
                  <div className="bg-charcoal/2 border border-charcoal/10 rounded-sm p-6 text-center">
                    <p className="font-sans text-sm text-charcoal mb-4">
                      Generating this report will call the AWS Cost Explorer API
                    </p>
                    <p className="font-sans text-sm text-charcoal/70 mb-4">
                      Each request costs approximately <span className="font-semibold">$0.01</span>
                    </p>
                  </div>

                  <div className="space-y-3">
                    <LuxuryButton onClick={handleGenerateReport} disabled={isLoading} className="w-full">
                      Generate Report
                    </LuxuryButton>

                    <LuxuryButton
                      onClick={onClose}
                      variant="text"
                      disabled={isLoading}
                      className="w-full text-center disabled:cursor-not-allowed"
                    >
                      Cancel
                    </LuxuryButton>
                  </div>
                </motion.div>
              )}

              {/* Loading State */}
              {isLoading && !costData && (
                <div className="py-12 flex items-center justify-center">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 2, repeat: Number.POSITIVE_INFINITY, ease: "linear" }}
                    className="w-8 h-8 border-2 border-green border-t-transparent rounded-full"
                  />
                </div>
              )}

              {/* Error State */}
              {error && !isLoading && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mb-6 p-4 bg-red-50 border border-red-200 rounded-sm"
                >
                  <p role="alert" aria-live="assertive" className="font-sans text-xs text-red-800 text-center">
                    {error}
                  </p>
                </motion.div>
              )}

              {/* Main Content */}
              {!isLoading && costData && !showConfirmation && (
                <>
                  {/* Cost Display */}
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1 }}
                    className="mb-8 text-center"
                  >
                    <div className="mb-2">
                      <p className="font-sans text-xs tracking-widest text-charcoal/60 uppercase mb-2">Total Cost</p>
                      <p className="font-serif text-5xl italic text-charcoal">${costData.totalCost}</p>
                      <p className="font-sans text-xs text-charcoal/50 mt-2">{costData.currency}</p>
                    </div>
                    <div className="w-12 h-[1px] bg-charcoal/20 mx-auto mt-4" />
                    <p className="font-sans text-xs text-charcoal/50 mt-4">
                      {formatDate(costData.period.start)} – {formatDate(costData.period.end)}
                    </p>
                    {isStale && cachedAt && (
                      <p className="font-sans text-xs text-charcoal/40 mt-2">
                        Data from {new Date(cachedAt).toLocaleDateString()} — click Refresh for latest
                      </p>
                    )}
                  </motion.div>

                  {/* Cost Breakdown Table */}
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2 }}
                    className="mb-8"
                  >
                    <div className="block font-sans text-xs tracking-widest text-charcoal/60 uppercase mb-3">
                      Service Breakdown
                    </div>
                    <CostBreakdownTable breakdown={costData.breakdown} currency={costData.currency} />
                  </motion.div>
                </>
              )}

              {/* Action Buttons */}
              {!showConfirmation && costData && (
                <div className="space-y-3">
                  <LuxuryButton onClick={handleRefresh} disabled={isLoading} className="w-full">
                    {isLoading ? "Fetching..." : "Refresh Costs"}
                  </LuxuryButton>

                  <LuxuryButton
                    onClick={onClose}
                    variant="text"
                    disabled={isLoading}
                    className="w-full text-center disabled:cursor-not-allowed"
                  >
                    Close
                  </LuxuryButton>
                </div>
              )}
            </motion.div>
          </motion.div>
        </motion.div>
      )}
    </>
  );
};
