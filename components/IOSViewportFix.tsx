"use client";

import { useEffect, useLayoutEffect } from "react";

// Use useLayoutEffect on client to run before paint
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export const IOSViewportFix = () => {
  useIsomorphicLayoutEffect(() => {
    function updateViewportVars() {
      const vh = window.innerHeight * 0.01;
      document.documentElement.style.setProperty("--vh", `${vh}px`);

      const visualViewport = window.visualViewport;
      if (!visualViewport) {
        document.documentElement.style.setProperty("--safe-top", "0px");
        document.documentElement.style.setProperty("--safe-bottom", "0px");
        return;
      }

      const safeTop = Math.max(0, Math.round(visualViewport.offsetTop));
      const safeBottom = Math.max(0, Math.round(window.innerHeight - visualViewport.height - visualViewport.offsetTop));

      document.documentElement.style.setProperty("--safe-top", `${safeTop}px`);
      document.documentElement.style.setProperty("--safe-bottom", `${safeBottom}px`);
    }

    // Set immediately before first paint
    updateViewportVars();

    window.addEventListener("resize", updateViewportVars);
    window.addEventListener("orientationchange", updateViewportVars);
    window.visualViewport?.addEventListener("resize", updateViewportVars);
    window.visualViewport?.addEventListener("scroll", updateViewportVars);

    return () => {
      window.removeEventListener("resize", updateViewportVars);
      window.removeEventListener("orientationchange", updateViewportVars);
      window.visualViewport?.removeEventListener("resize", updateViewportVars);
      window.visualViewport?.removeEventListener("scroll", updateViewportVars);
    };
  }, []);

  return <div data-testid="ios-viewport-fix" style={{ display: "none" }} />;
};
