"use client";

import { useEffect, useState } from "react";

function getPageFocusState(): boolean {
  if (typeof document === "undefined") {
    return true;
  }

  const hasFocus = typeof document.hasFocus === "function" ? document.hasFocus() : true;
  return document.visibilityState === "visible" && hasFocus;
}

export function usePageFocus(): boolean {
  const [isFocused, setIsFocused] = useState<boolean>(() => getPageFocusState());

  useEffect(() => {
    const updateFocusState = () => {
      setIsFocused(getPageFocusState());
    };

    updateFocusState();
    document.addEventListener("visibilitychange", updateFocusState);
    window.addEventListener("focus", updateFocusState);
    window.addEventListener("blur", updateFocusState);

    return () => {
      document.removeEventListener("visibilitychange", updateFocusState);
      window.removeEventListener("focus", updateFocusState);
      window.removeEventListener("blur", updateFocusState);
    };
  }, []);

  return isFocused;
}
