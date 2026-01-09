"use client";

import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { useState } from "react";

interface DecagonLoaderProps {
  isLoading?: boolean;
  status?: string; // "running" | "stopped" | etc.
  className?: string;
}

export const DecagonLoader = ({ status, isLoading, className }: DecagonLoaderProps) => {
  const [isHovered, setIsHovered] = useState(false);

  // Breathing animation configuration
  const breatheAnimation = {
    scale: [1, 1.12, 1],
    opacity: [0.7, 1, 0.7],
    transition: {
      duration: isHovered ? 0.6 : 3,
      repeat: Number.POSITIVE_INFINITY,
      ease: "easeInOut" as const,
    },
  };

  // Rotation animation
  const rotateAnimation = {
    rotate: 360,
    transition: {
      duration: 12, // Faster rotation
      repeat: Number.POSITIVE_INFINITY,
      ease: "linear" as const,
    },
  };

  const isRunning = status === "running";
  const isStopped = status === "stopped" || status === "hibernated";

  // Decide color based on status
  const colorClass = isLoading
    ? "stroke-charcoal/50"
    : isRunning
      ? "stroke-green"
      : status === "unknown"
        ? "stroke-red-800"
        : isStopped
          ? "stroke-charcoal/30"
          : "stroke-charcoal";

  return (
    <div data-testid="decagon-loader" className={cn("relative flex items-center justify-center w-24 h-24", className)}>
      <motion.div animate={rotateAnimation} className="absolute inset-0 flex items-center justify-center">
        <motion.svg
          viewBox="0 0 100 100"
          className={cn("w-full h-full fill-none touch-none", colorClass)}
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
          {/* Decagon Shape */}
          <polygon points="50,2 69,8 85,21 95,38 95,62 85,79 69,92 50,98 31,92 15,79 5,62 5,38 15,21 31,8" />

          {/* Inner details if valid status */}
          {isRunning && <circle cx="50" cy="50" r="2" className="fill-green stroke-none" />}
        </motion.svg>
      </motion.div>
    </div>
  );
};
