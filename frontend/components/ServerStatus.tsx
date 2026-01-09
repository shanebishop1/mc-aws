"use client";

import { DecagonLoader } from "@/components/ui/DecagonLoader";
import { motion } from "framer-motion";
import { SleepingZs } from "./SleepingZs";

interface ServerStatusProps {
  state: "running" | "stopped" | "hibernated" | "pending" | "stopping" | "terminated" | "unknown";
  ip?: string;
  playerCount?: number;
  className?: string;
  isLoading?: boolean;
}

export const ServerStatus = ({ state, ip, playerCount, className, isLoading }: ServerStatusProps) => {
  // Mapping state to display text
  const stateLabels: Record<string, string> = {
    running: "Online",
    stopped: "Stopped",
    hibernated: "Hibernated",
    pending: "Starting...",
    stopping: "Stopping...",
    terminated: "Terminated",
    unknown: "Unknown",
  };

  const label = isLoading ? "Connecting..." : stateLabels[state] || state;

  // Determine color: Neutral for loading, Red for unknown/error, Green for running, Black for others
  const renderColor = () => {
    if (isLoading) return "text-charcoal/50 animate-pulse";
    if (state === "unknown") return "text-red-800";
    return "text-green";
  };

  return (
    <div className={`relative flex flex-col items-center justify-center space-y-12 ${className}`}>
      {/* Always render to prevent layout shift - component handles visibility internally */}
      <SleepingZs show={state === "hibernated"} />

      {/* Central Anchor */}
      <DecagonLoader status={state} isLoading={isLoading || state === "pending" || state === "stopping"} />

      {/* Status Text - Huge Serif Italic */}
      <div className="text-center space-y-4">
        <h2 className="text-charcoal font-serif text-5xl md:text-6xl tracking-tight">
          Server<br className="sm:hidden" /> <span className={`italic ${renderColor()}`}>{label}</span>
        </h2>

        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-2">
          {/* IP address - always reserve space to prevent layout shift */}
          <div className="h-6 flex items-center justify-center">
            {!isLoading && ip ? (
              <span className="font-sans text-xs tracking-[0.2em] text-charcoal/50 uppercase">{ip}</span>
            ) : (
              <span className="font-sans text-xs tracking-[0.2em] text-transparent uppercase">0.0.0.0</span>
            )}
          </div>
          {/* Player count - always reserve space to prevent layout shift */}
          <div className="h-5 flex items-center justify-center">
            {!isLoading && state === "running" && playerCount !== undefined ? (
              <span className="font-sans text-xs tracking-[0.15em] text-charcoal/40 uppercase">
                {playerCount === 1 ? "1 player online" : `${playerCount} players online`}
              </span>
            ) : (
              <span className="font-sans text-xs tracking-[0.15em] text-transparent uppercase">0 players online</span>
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
};
