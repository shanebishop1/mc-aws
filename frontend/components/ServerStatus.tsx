"use client";

import { motion } from "framer-motion";
import { DecagonLoader } from "@/components/ui/DecagonLoader";

interface ServerStatusProps {
  state: "running" | "stopped" | "hibernated" | "pending" | "stopping" | "terminated" | "unknown";
  ip?: string;
  className?: string;
}

export function ServerStatus({ state, ip, className }: ServerStatusProps) {
  const isOnline = state === "running";
  
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

  return (
    <div className={`flex flex-col items-center justify-center space-y-12 ${className}`}>
      {/* Central Anchor */}
      <DecagonLoader status={state} isLoading={state === "pending" || state === "stopping"} />

      {/* Status Text - Huge Serif Italic */}
      <div className="text-center space-y-4">
        <h2 className="text-luxury-black font-serif text-5xl md:text-6xl tracking-tight">
          Server <span className="italic text-luxury-green">{stateLabels[state] || state}</span>
        </h2>
        
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="h-6"
        >
          {ip && (
            <span className="font-sans text-xs tracking-[0.2em] text-luxury-black/50 uppercase">
              {ip}
            </span>
          )}
        </motion.div>
      </div>
    </div>
  );
}
