"use client";

import { useEffect, useLayoutEffect } from "react";

// Use useLayoutEffect on client to run before paint
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export const IOSViewportFix = () => {
  useIsomorphicLayoutEffect(() => {
    function updateVH() {
      const vh = window.innerHeight * 0.01;
      document.documentElement.style.setProperty("--vh", `${vh}px`);
    }

    // Set immediately before first paint
    updateVH();
    
    window.addEventListener("resize", updateVH);
    window.addEventListener("orientationchange", updateVH);
    
    return () => {
      window.removeEventListener("resize", updateVH);
      window.removeEventListener("orientationchange", updateVH);
    };
  }, []);

  return null;
}
