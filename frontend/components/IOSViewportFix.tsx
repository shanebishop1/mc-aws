"use client";

import { useEffect } from "react";

export function IOSViewportFix() {
  useEffect(() => {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    
    if (!isIOS) return;

    function updateVH() {
      const vh = window.innerHeight * 0.01;
      document.documentElement.style.setProperty("--vh", `${vh}px`);
    }

    updateVH();
    window.addEventListener("resize", updateVH);
    
    return () => window.removeEventListener("resize", updateVH);
  }, []);

  return null;
}
