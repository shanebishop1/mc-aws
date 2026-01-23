"use client";

import { motion } from "framer-motion";
import { useAuth } from "./auth-provider";

export function LoginButton() {
  const { isLoading, isAuthenticated, refetch } = useAuth();

  if (isLoading) {
    return null;
  }

  const handleSignIn = () => {
    const popup = window.open("/api/auth/login?popup=1", "google-auth", "width=500,height=600,menubar=no,toolbar=no");

    // If a popup is blocked, fall back to full-page navigation.
    if (!popup) {
      window.location.href = "/api/auth/login";
      return;
    }

    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (typeof event.data !== "object" || event.data === null) return;
      if ((event.data as { type?: string }).type !== "MC_AUTH_SUCCESS") return;
      cleanup();
      void refetch();
    }

    const poll = window.setInterval(() => {
      if (popup.closed) {
        cleanup();
        void refetch();
      }
    }, 500);

    function cleanup() {
      window.clearInterval(poll);
      window.removeEventListener("message", handleMessage);
    }

    window.addEventListener("message", handleMessage);
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
        className="cursor-pointer p-1 rounded-full bg-white/60 ring-1 ring-charcoal/10 hover:bg-white/80 opacity-90 hover:opacity-100 transition-colors"
        title="Sign in with Google"
        aria-label="Sign in with Google"
      >
        <svg className="w-7 h-7" viewBox="0 0 24 24" width="24" height="24" role="img" aria-hidden="true">
          <path
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            fill="#4285F4"
          />
          <path
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            fill="#34A853"
          />
          <path
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            fill="#FBBC05"
          />
          <path
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            fill="#EA4335"
          />
          <path d="M1 1h22v22H1z" fill="none" />
        </svg>
      </motion.button>
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3 sm:flex-nowrap animate-in slide-in-from-right-4 fade-in duration-300">
      <motion.button
        type="button"
        onClick={handleSignOut}
        whileHover={{ scale: 1.04 }}
        transition={{ duration: 0.1 }}
        whileTap={{ scale: 0.97 }}
        className="cursor-pointer px-3 py-1.5 text-sm font-medium rounded-md bg-white/70 ring-1 ring-charcoal/10 hover:bg-white text-charcoal/60 hover:text-charcoal opacity-90 hover:opacity-100 transition-colors"
      >
        Sign out
      </motion.button>
    </div>
  );
}
