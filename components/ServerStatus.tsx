"use client";

import { DecagonLoader } from "@/components/ui/DecagonLoader";
import { AnimatePresence, motion } from "framer-motion";
import { SleepingZs } from "./SleepingZs";

import { ServerState } from "@/lib/types";

interface ServerStatusProps {
  state: ServerState;
  domain?: string;
  playerCount?: number;
  className?: string;
  isLoading?: boolean;
}

export const ServerStatus = ({ state, domain, playerCount, className, isLoading }: ServerStatusProps) => {
  const stateLabels: Record<ServerState, string> = {
    [ServerState.Running]: "Online",
    [ServerState.Stopped]: "Stopped",
    [ServerState.Hibernating]: "Hibernating",
    [ServerState.Pending]: "Starting...",
    [ServerState.Stopping]: "Stopping...",
    [ServerState.Terminated]: "Terminated",
    [ServerState.Unknown]: "Unknown",
  };

  const label = isLoading ? "Connecting..." : stateLabels[state] || state;

  // Determine color: Neutral for loading, Red for unknown/error, Green for running, Black for others
  const renderColor = () => {
    if (isLoading) return "text-charcoal/50 animate-pulse";
    if (state === "unknown") return "text-red-800";
    return "text-green";
  };

  return (
    <div
      data-testid="server-status"
      className={`relative flex flex-col items-center justify-center space-y-12 ${className}`}
    >
      {/* Always render to prevent layout shift - component handles visibility internally */}
      <SleepingZs show={state === ServerState.Hibernating} />

      {/* Central Anchor */}
      <DecagonLoader status={state} isLoading={isLoading || state === "pending" || state === "stopping"} />

      {/* Status Text - Huge Serif Italic */}
      <div className="w-full text-center space-y-4">
        <h2
          className={`w-full text-charcoal font-serif text-5xl md:text-6xl tracking-tight
            flex flex-wrap items-baseline justify-center gap-x-[0.3em]`}
        >
          <motion.span
            layout="position"
            transition={{
              layout: {
                type: "spring",
                stiffness: 500,
                damping: 45,
              },
            }}
          >
            Server
          </motion.span>
          {/* In a flex container, <br> doesn't reliably force a new line; basis-full does. */}
          <span className="basis-full block sm:hidden" aria-hidden="true" />
          <motion.span
            layout
            transition={{
              layout: {
                type: "spring",
                stiffness: 500,
                damping: 45,
              },
            }}
            className="relative inline-flex overflow-hidden pb-2 whitespace-nowrap pr-[0.12em] -mr-[0.12em]"
          >
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={label}
                initial={{ opacity: 0, y: 60 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{
                  opacity: 0,
                  y: -80,
                  position: "absolute",
                  top: 0,
                  left: 0,
                }}
                transition={{ duration: 0.4 }}
                className={`italic ${renderColor()} whitespace-nowrap`}
              >
                {label}
              </motion.span>
            </AnimatePresence>
          </motion.span>
        </h2>

        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-2">
          {/* Domain - always reserve space to prevent layout shift */}
          <div className="h-6 flex items-center justify-center">
            {!isLoading && domain ? (
              <span className="font-sans text-xs tracking-[0.2em] text-charcoal/50 uppercase">{domain}</span>
            ) : (
              <span className="font-sans text-xs tracking-[0.2em] text-transparent uppercase">mc.example.com</span>
            )}
          </div>
          {/* Player count - always reserve space to prevent layout shift */}
          <div className="h-5 flex items-center justify-center">
            {!isLoading && state === "running" && playerCount !== undefined ? (
              <span className="font-sans text-xs tracking-[0.15em] text-green uppercase">
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
