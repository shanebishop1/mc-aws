"use client";

import { useAuth } from "./auth-provider";

export function LoginButton() {
  const { user, isLoading, isAuthenticated } = useAuth();

  if (isLoading) {
    return <span className="text-sm text-gray-500">Loading...</span>;
  }

  if (!isAuthenticated) {
    return (
      <button
        type="button"
        onClick={() => {
          window.location.href = "/api/auth/login";
        }}
        className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors"
      >
        Sign in with Google
      </button>
    );
  }

  const handleSignOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.reload();
  };

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-gray-700">{user?.email}</span>
      <button
        type="button"
        onClick={handleSignOut}
        className="px-3 py-1.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
      >
        Sign out
      </button>
    </div>
  );
}
