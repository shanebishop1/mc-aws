"use client";

import { motion } from "framer-motion";

interface CostBreakdownTableProps {
  breakdown: Array<{ service: string; cost: string }>;
  currency: string;
}

export const CostBreakdownTable = ({ breakdown, currency }: CostBreakdownTableProps) => {
  if (breakdown.length === 0) {
    return (
      <p className="font-sans text-sm text-charcoal/60 text-center py-4">No cost data available for this period.</p>
    );
  }

  return (
    <div data-testid="cost-breakdown-table" className="space-y-2">
      {breakdown.map((item, index) => (
        <motion.div
          key={item.service}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: index * 0.03 }}
          className="flex justify-between items-center py-2 border-b border-charcoal/10 last:border-0"
        >
          <span className="font-sans text-sm text-charcoal/80 truncate pr-4">{item.service}</span>
          <span className="font-sans text-sm font-medium text-charcoal whitespace-nowrap">
            {currency === "USD" ? "$" : currency} {item.cost}
          </span>
        </motion.div>
      ))}
    </div>
  );
};
