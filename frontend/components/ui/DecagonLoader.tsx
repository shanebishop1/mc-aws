"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface DecagonLoaderProps {
  isLoading?: boolean;
  status?: string; // "running" | "stopped" | etc.
  className?: string;
}

export function DecagonLoader({ isLoading, status, className }: DecagonLoaderProps) {
  // Breathing animation configuration
  const breatheAnimation = {
    scale: [1, 1.05, 1],
    opacity: [0.8, 1, 0.8],
    transition: {
      duration: 4,
      repeat: Infinity,
      ease: "easeInOut" as const,
    },
  };

  // Rotation animation
  const rotateAnimation = {
    rotate: 360,
    transition: {
      duration: 30, // Slow rotation 30s
      repeat: Infinity,
      ease: "linear" as const,
    },
  };

  const isRunning = status === "running";
  const isStopped = status === "stopped" || status === "hibernated";
  
  // Decide color based on status
  const colorClass = isRunning 
    ? "stroke-luxury-green" 
    : isStopped 
      ? "stroke-luxury-black/30" 
      : "stroke-luxury-black";

  return (
    <div className={cn("relative flex items-center justify-center w-24 h-24", className)}>
      <motion.div
        animate={rotateAnimation}
        className="absolute inset-0 flex items-center justify-center"
      >
        <motion.svg
          viewBox="0 0 100 100"
          className={cn("w-full h-full fill-none stroke-[0.5px]", colorClass)}
          whileHover={{ scale: 1.1 }}
          animate={isRunning ? breatheAnimation : {}}
        >
          {/* Decagon Shape */}
          <polygon points="50,2 69,8 85,21 95,38 95,62 85,79 69,92 50,98 31,92 15,79 5,62 5,38 15,21 31,8" />
          
          {/* Inner details if valid status */}
          {isRunning && (
            <circle cx="50" cy="50" r="2" className="fill-luxury-green stroke-none" />
          )}
        </motion.svg>
      </motion.div>
    </div>
  );
}
