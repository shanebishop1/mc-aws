"use client";

import { useAuth } from "./auth-provider";

export function LoginButton() {
  const { user, isLoading, isAuthenticated } = useAuth();

  if (isLoading) {
    return <span className="text-sm text-charcoal/50">Loading...</span>;
  }

  if (!isAuthenticated) {
    return null;
  }

  const handleSignOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.reload();
  };

  return (
    <div className="flex items-center gap-3">
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
