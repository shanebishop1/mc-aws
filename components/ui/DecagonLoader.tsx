"use client";

import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { useState } from "react";

import { ServerState } from "@/lib/types";

interface DecagonLoaderProps {
  isLoading?: boolean;
  status?: ServerState;
  className?: string;
}

const getStrokeColorClass = (status: ServerState | undefined, isLoading: boolean | undefined): string => {
  if (isLoading) return "stroke-charcoal/50";
  if (status === ServerState.Running) return "stroke-green";
  if (status === "unknown") return "stroke-red-800";
  if (status === ServerState.Stopped || status === ServerState.Hibernating) return "stroke-charcoal/30";
  return "stroke-charcoal";
};

const getFillOpacity = (status: ServerState | undefined, isLoading: boolean | undefined): number => {
  if (status === ServerState.Running) return 0.35;
  if (status === ServerState.Pending || isLoading) return 0.2;
  if (status === ServerState.Stopped || status === ServerState.Hibernating) return 0.08;
  return 0.12;
};

const rotateAnimation = {
  rotate: 360,
  transition: { duration: 12, repeat: Number.POSITIVE_INFINITY, ease: "linear" as const },
};

export const DecagonLoader = ({ status, isLoading, className }: DecagonLoaderProps) => {
  const [isHovered, setIsHovered] = useState(false);

  const breatheAnimation = {
    scale: [1, 1.12, 1],
    opacity: [0.7, 1, 0.7],
    transition: {
      duration: isHovered ? 0.6 : 3,
      repeat: Number.POSITIVE_INFINITY,
      ease: "easeInOut" as const,
    },
  };

  const isRunning = status === ServerState.Running;
  const colorClass = getStrokeColorClass(status, isLoading);
  const fillOpacity = getFillOpacity(status, isLoading);

  return (
    <div data-testid="decagon-loader" className={cn("relative flex items-center justify-center w-24 h-24", className)}>
      <motion.div animate={rotateAnimation} className="absolute inset-0 flex items-center justify-center">
        <motion.svg
          viewBox="0 0 100 100"
          className={cn("w-full h-full touch-none", colorClass)}
          initial={{ strokeWidth: 1.5 }}
          onHoverStart={() => setIsHovered(true)}
          onHoverEnd={() => setIsHovered(false)}
          onTapStart={() => setIsHovered(true)}
          onTap={() => setIsHovered(false)}
          whileHover={{
            scale: 1.1,
            strokeWidth: 3.0,
          }}
          whileTap={{
            scale: 1.1,
            strokeWidth: 3.0,
          }}
          transition={{
            scale: { duration: 0.2 },
            strokeWidth: { duration: 0.2 },
          }}
          animate={isRunning || isLoading ? breatheAnimation : { scale: 1, strokeWidth: 1.5 }}
        >
          {/* Decagon Shape with animated fill */}
          <motion.polygon
            points="50,2 69,8 85,21 95,38 95,62 85,79 69,92 50,98 31,92 15,79 5,62 5,38 15,21 31,8"
            className="fill-green"
            initial={{ fillOpacity: 0.08 }}
            animate={{ fillOpacity }}
            transition={{ duration: 0.8, ease: "easeInOut" }}
          />

          {/* Inner details if valid status */}
          {isRunning && <circle cx="50" cy="50" r="2" className="fill-green stroke-none" />}
        </motion.svg>
      </motion.div>
    </div>
  );
};
