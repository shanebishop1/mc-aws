"use client";

import { cn } from "@/lib/utils";
import { type HTMLMotionProps, motion } from "framer-motion";

interface LuxuryButtonProps extends HTMLMotionProps<"button"> {
  children: React.ReactNode;
  className?: string;
  variant?: "outline" | "text" | "pill";
}

export const LuxuryButton = ({ children, className, variant = "outline", ...props }: LuxuryButtonProps) => {
  if (variant === "text") {
    return (
      <motion.button
        data-testid="luxury-button-text"
        whileHover={{ scale: 1.05 }}
        transition={{ duration: 0.1 }}
        whileTap={{ scale: 0.95 }}
        className={cn(
          "cursor-pointer font-sans text-xs tracking-[0.2em] text-charcoal/60",
          "hover:text-green uppercase transition-colors duration-300",
          "disabled:cursor-not-allowed disabled:text-gray",
          className
        )}
        {...props}
      >
        {children}
      </motion.button>
    );
  }

  if (variant === "pill") {
    return (
      <motion.button
        data-testid="luxury-button-pill"
        whileHover={{ scale: 1.05, backgroundColor: "rgba(255, 255, 255, 0.9)" }}
        transition={{ duration: 0.1 }}
        whileTap={{ scale: 0.95 }}
        className={cn(
          "cursor-pointer px-5 py-2 rounded-full border border-charcoal/10 bg-white/40 backdrop-blur-sm",
          "font-sans text-[10px] tracking-[0.15em] font-medium uppercase text-charcoal/70",
          "hover:border-charcoal/30 hover:text-charcoal hover:shadow-sm transition-all duration-300",
          "disabled:cursor-not-allowed disabled:opacity-50",
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
      data-testid="luxury-button"
      whileHover={{ y: -2 }}
      transition={{ duration: 0.1 }}
      whileTap={{ y: 1 }}
      className={cn(
        "cursor-pointer relative px-8 py-3 overflow-hidden group border border-charcoal transition-all duration-300",
        "font-sans text-xs tracking-[0.2em] font-medium uppercase text-charcoal",
        "hover:border-green hover:text-white hover:bg-green",
        "disabled:cursor-not-allowed",
        className
      )}
      {...props}
    >
      <span className="relative z-10 group-hover:text-white transition-colors duration-300">{children}</span>
      <motion.div
        className="absolute inset-0 bg-green"
        initial={{ scaleX: 0, originX: 0 }}
        whileHover={{ scaleX: 1 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
      />
    </motion.button>
  );
};
