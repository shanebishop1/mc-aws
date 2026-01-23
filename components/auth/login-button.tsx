"use client";

import { useAuth } from "./auth-provider";
import { motion } from "framer-motion";

export function LoginButton() {
  const { user, isLoading, isAuthenticated, refetch } = useAuth();

  if (isLoading) {
    return null;
  }

  const handleSignIn = () => {
    const popup = window.open(
      "/api/auth/login?popup=1",
      "google-auth",
      "width=500,height=600,menubar=no,toolbar=no"
    );

    // If a popup is blocked, fall back to full-page navigation.
    if (!popup) {
      window.location.href = "/api/auth/login";
      return;
    }

    let poll: number | undefined;

    const cleanup = () => {
      if (poll !== undefined) {
        window.clearInterval(poll);
      }
      window.removeEventListener("message", handleMessage);
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (typeof event.data !== "object" || event.data === null) return;
      if ((event.data as { type?: string }).type !== "MC_AUTH_SUCCESS") return;
      cleanup();
      void refetch();
    };

    window.addEventListener("message", handleMessage);

    poll = window.setInterval(() => {
      if (popup.closed) {
        cleanup();
        void refetch();
      }
    }, 500);
  };

  const handleSignOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.reload();
  };

  if (!isAuthenticated) {
    return (
      <motion.button
        type="button"
        onClick={handleSignIn}
        whileHover={{ scale: 1.1 }}
        transition={{ duration: 0.1 }}
        whileTap={{ scale: 0.95 }}
        className="cursor-pointer p-1 text-charcoal/40 hover:text-green transition-colors"
        title="Sign in with Google"
        aria-label="Sign in with Google"
      >
        <svg className="w-7 h-7" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M21.35 11.1H12v2.8h5.35c-.23 1.2-1.38 3.52-5.35 3.52-3.22 0-5.85-2.66-5.85-5.92S8.78 6.58 12 6.58c1.84 0 3.07.78 3.77 1.46l2.57-2.47C16.74 4.1 14.6 3 12 3 7.03 3 3 7.03 3 12s4.03 9 9 9c5.2 0 8.65-3.65 8.65-8.8 0-.59-.07-1.04-.15-1.5z" />
        </svg>
      </motion.button>
    );
  }

  return (
    <div className="flex items-center gap-3 animate-in slide-in-from-right-4 fade-in duration-300">
      <span className="text-sm text-charcoal/70">{user?.email}</span>
      <button
        type="button"
        onClick={handleSignOut}
        className="px-3 py-1.5 text-sm font-medium text-charcoal/70 border border-charcoal/20 rounded-md hover:bg-cream/50 transition-colors"
      >
        Sign out
      </button>
    </div>
  );
}
