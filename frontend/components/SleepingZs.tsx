"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";

interface ZParticle {
  id: number;
  startX: number;
  startY: number;
  size: number;
  duration: number;
  delay: number;
}

export function SleepingZs() {
  const [particles, setParticles] = useState<ZParticle[]>([]);
  const [counter, setCounter] = useState(0);

  useEffect(() => {
    // Create new Z particles periodically
    const interval = setInterval(() => {
      setCounter((c) => c + 1);

      const newParticle: ZParticle = {
        id: Date.now(),
        startX: Math.random() * 20 - 10, // Random offset from center
        startY: Math.random() * 10,
        size: 18 + Math.random() * 10, // 18-28px
        duration: 3.5 + Math.random() * 1.5, // 3.5-5s
        delay: 0,
      };

      setParticles((prev) => [...prev.slice(-5), newParticle]); // Keep max 6 particles
    }, 800); // New Z every 800ms

    return () => clearInterval(interval);
  }, []);

  // Remove particles after animation completes
  useEffect(() => {
    const cleanup = setTimeout(() => {
      setParticles((prev) => prev.slice(1));
    }, 6500);
    return () => clearTimeout(cleanup);
  }, [counter]);

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      <AnimatePresence>
        {particles.map((particle) => (
          <motion.span
            key={particle.id}
            initial={{
              opacity: 0,
              x: particle.startX,
              y: particle.startY,
              scale: 0.5,
            }}
            animate={{
              opacity: [0, 0.7, 0.7, 0.4, 0],
              x: particle.startX + 80 + Math.random() * 30,
              y: particle.startY - 100 - Math.random() * 30,
              scale: [0.5, 1, 1, 0.9, 0.8],
            }}
            transition={{
              duration: particle.duration,
              ease: "easeOut",
            }}
            className="absolute font-serif font-semibold italic text-luxury-black/40"
            style={{
              fontSize: particle.size,
              left: "55%",
              top: "25%",
            }}
          >
            z
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  );
}
