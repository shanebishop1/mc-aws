"use client";

import { cn } from "@/lib/utils";
import { type HTMLMotionProps, motion } from "framer-motion";

interface LuxuryButtonProps extends HTMLMotionProps<"button"> {
  children: React.ReactNode;
  className?: string;
  variant?: "outline" | "text";
}

export const LuxuryButton = ({ children, className, variant = "outline", ...props }: LuxuryButtonProps) => {
  if (variant === "text") {
    return (
      <motion.button
        whileHover={{ scale: 1.05 }}
        transition={{ duration: 0.1 }}
        whileTap={{ scale: 0.95 }}
        className={cn(
          "cursor-pointer font-sans text-xs tracking-[0.2em] text-luxury-black/60",
          "hover:text-luxury-green uppercase transition-colors duration-300",
          "disabled:cursor-not-allowed disabled:text-luxury-gray",
          className
        )}
        {...props}
      >
        {children}
      </motion.button>
    );
  }

  return (
    <motion.button
      whileHover={{ y: -2 }}
      transition={{ duration: 0.1 }}
      whileTap={{ y: 1 }}
      className={cn(
        "cursor-pointer relative px-8 py-3 overflow-hidden group border border-luxury-black transition-all duration-300",
        "font-sans text-xs tracking-[0.2em] font-medium uppercase text-luxury-black",
        "hover:border-luxury-green hover:text-white hover:bg-luxury-green",
        "disabled:cursor-not-allowed",
        className
      )}
      {...props}
    >
      <span className="relative z-10 group-hover:text-white transition-colors duration-300">{children}</span>
      <motion.div
        className="absolute inset-0 bg-luxury-green"
        initial={{ scaleX: 0, originX: 0 }}
        whileHover={{ scaleX: 1 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
      />
    </motion.button>
  );
}
