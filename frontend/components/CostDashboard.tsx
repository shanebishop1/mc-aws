"use client";

import { LuxuryButton } from "@/components/ui/LuxuryButton";
import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";
import type { CostsResponse } from "@/lib/types";

interface CostDashboardProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CostDashboard({ isOpen, onClose }: CostDashboardProps) {
  const [costData, setCostData] = useState<CostsResponse["data"] | null>(null);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasRefreshed, setHasRefreshed] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(true);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setError(null);
      setHasRefreshed(false);
      // Don't reset costData or showConfirmation - keep cache
    }
  }, [isOpen]);

  const fetchCosts = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/costs");
      const data: CostsResponse = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to fetch cost data");
      }

      setCostData(data.data || null);
      setCachedAt(data.cachedAt || Date.now());
      setHasRefreshed(false);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to fetch cost data";
      setError(errorMessage);
      console.error("Failed to fetch costs:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleGenerateReport = () => {
    setShowConfirmation(false);
    fetchCosts();
  };

  const handleRefresh = async () => {
    setIsLoading(true);
    setError(null);
    setHasRefreshed(true);

    try {
      const res = await fetch("/api/costs?refresh=true");
      const data: CostsResponse = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to fetch cost data");
      }

      setCostData(data.data || null);
      setCachedAt(data.cachedAt || Date.now());
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to fetch cost data";
      setError(errorMessage);
      console.error("Failed to fetch costs:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleClickOutside = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const formatDate = (dateStr: string): string => {
    const date = new Date(`${dateStr}T00:00:00Z`);
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  const isStale = cachedAt ? Date.now() - cachedAt > 86400000 : false; // 1 day

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
            className="relative w-full max-w-2xl mx-4 bg-luxury-cream rounded-sm shadow-xl border border-luxury-black/10"
          >
            {/* Close Button */}
            <button
              type="button"
              onClick={onClose}
              disabled={isLoading}
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
                  Cost Dashboard
                </h2>
                <p className="font-sans text-xs tracking-widest text-luxury-black/60 uppercase">
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
                  <div className="bg-luxury-black/2 border border-luxury-black/10 rounded-sm p-6 text-center">
                    <p className="font-sans text-sm text-luxury-black mb-4">
                      Generating this report will call the AWS Cost Explorer API
                    </p>
                    <p className="font-sans text-sm text-luxury-black/70 mb-4">
                      Each request costs approximately <span className="font-semibold">$0.01</span>
                    </p>
                  </div>

                  <div className="space-y-3">
                    <LuxuryButton
                      onClick={handleGenerateReport}
                      disabled={isLoading}
                      className="w-full"
                    >
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
                    className="w-8 h-8 border-2 border-luxury-green border-t-transparent rounded-full"
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
                  <p className="font-sans text-xs text-red-800 text-center">{error}</p>
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
                      <p className="font-sans text-xs tracking-widest text-luxury-black/60 uppercase mb-2">
                        Total Cost
                      </p>
                      <p className="font-serif text-5xl italic text-luxury-black">
                        ${costData.totalCost}
                      </p>
                      <p className="font-sans text-xs text-luxury-black/50 mt-2">
                        {costData.currency}
                      </p>
                    </div>
                    <div className="w-12 h-[1px] bg-luxury-black/20 mx-auto mt-4" />
                    <p className="font-sans text-xs text-luxury-black/50 mt-4">
                      {formatDate(costData.period.start)} – {formatDate(costData.period.end)}
                    </p>
                    {isStale && (
                      <p className="font-sans text-xs text-luxury-black/40 mt-2">
                        Data from {new Date(cachedAt!).toLocaleDateString()} — click Refresh for latest
                      </p>
                    )}
                  </motion.div>

                  {/* Cost Breakdown Table */}
                  {costData.breakdown && costData.breakdown.length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.2 }}
                      className="mb-8"
                    >
                      <div className="block font-sans text-xs tracking-widest text-luxury-black/60 uppercase mb-3">
                        Service Breakdown
                      </div>
                      <div className="max-h-64 overflow-y-auto border border-luxury-black/10 rounded-sm">
                        <div className="space-y-0">
                          {costData.breakdown.map((item, index) => (
                            <motion.div
                              key={`${item.service}-${index}`}
                              initial={{ opacity: 0, x: -10 }}
                              animate={{ opacity: 1, x: 0 }}
                              transition={{ delay: 0.2 + index * 0.05 }}
                              className={`flex justify-between items-center p-3 font-sans text-xs ${
                                index % 2 === 0
                                  ? "bg-luxury-black/2"
                                  : "bg-transparent"
                              } border-b border-luxury-black/5 last:border-b-0`}
                            >
                              <span className="text-luxury-black">{item.service}</span>
                              <span className="text-luxury-black font-semibold">
                                ${item.cost}
                              </span>
                            </motion.div>
                          ))}
                        </div>
                      </div>
                    </motion.div>
                  )}

                  {/* Empty Breakdown State */}
                  {(!costData.breakdown || costData.breakdown.length === 0) && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="mb-8 py-8 text-center"
                    >
                      <p className="font-sans text-xs tracking-widest text-luxury-black/50 uppercase">
                        No service costs recorded for this period
                      </p>
                    </motion.div>
                  )}
                </>
              )}

              {/* Action Buttons */}
              {!showConfirmation && costData && (
                <div className="space-y-3">
                  <LuxuryButton
                    onClick={handleRefresh}
                    disabled={isLoading}
                    className="w-full"
                  >
                    {isLoading ? "Fetching..." : hasRefreshed ? "Refresh" : "Refresh Costs"}
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
    </AnimatePresence>
  );
}
