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

export function ServerStatus({ state, ip, playerCount, className, isLoading }: ServerStatusProps) {
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
    if (isLoading) return "text-luxury-black/50 animate-pulse";
    if (state === "unknown") return "text-red-800";
    return "text-luxury-green";
  };

  return (
    <div className={`relative flex flex-col items-center justify-center space-y-12 ${className}`}>
      {state === "hibernated" && <SleepingZs />}

      {/* Central Anchor */}
      <DecagonLoader
        status={state}
        isLoading={isLoading || state === "pending" || state === "stopping"}
      />

       {/* Status Text - Huge Serif Italic */}
       <div className="text-center space-y-4">
         <h2 className="text-luxury-black font-serif text-5xl md:text-6xl tracking-tight">
           Server <span className={`italic ${renderColor()}`}>{label}</span>
         </h2>

         <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-2">
           {!isLoading && ip && (
             <div className="h-6">
               <span className="font-sans text-xs tracking-[0.2em] text-luxury-black/50 uppercase">{ip}</span>
             </div>
           )}
           {!isLoading && state === "running" && playerCount !== undefined && (
             <div className="h-5">
               <span className="font-sans text-xs tracking-[0.15em] text-luxury-black/40 uppercase">
                 {playerCount === 1 ? "1 player online" : `${playerCount} players online`}
               </span>
             </div>
           )}
         </motion.div>
       </div>
    </div>
  );
}
