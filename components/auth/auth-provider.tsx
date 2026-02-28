"use client";

import { usePageFocus } from "@/hooks/usePageFocus";
import { fetchAuthMe, postAuthLogout, queryKeys } from "@/lib/client-api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, createContext, useCallback, useContext, useMemo } from "react";

type UserRole = "admin" | "allowed" | "public";

interface AuthUser {
  email: string;
  role: UserRole;
}

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
  isAllowed: boolean;
  refetch: () => Promise<AuthUser | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const isPageFocused = usePageFocus();

  const authQuery = useQuery({
    queryKey: queryKeys.authMe,
    queryFn: fetchAuthMe,
    enabled: isPageFocused,
  });

  const logoutMutation = useMutation({
    mutationFn: postAuthLogout,
  });

  const user = useMemo<AuthUser | null>(() => {
    if (!authQuery.data || !authQuery.data.authenticated) {
      return null;
    }

    return { email: authQuery.data.email, role: authQuery.data.role };
  }, [authQuery.data]);

  const refetch = useCallback(async (): Promise<AuthUser | null> => {
    const result = await authQuery.refetch();
    if (!result.data || !result.data.authenticated) {
      return null;
    }

    return { email: result.data.email, role: result.data.role };
  }, [authQuery]);

  const signOut = useCallback(async (): Promise<void> => {
    await logoutMutation.mutateAsync();
    await queryClient.invalidateQueries({ queryKey: queryKeys.authMe });
    await queryClient.refetchQueries({ queryKey: queryKeys.authMe });
  }, [logoutMutation, queryClient]);

  const value: AuthContextValue = {
    user,
    isLoading: authQuery.isPending || logoutMutation.isPending,
    isAuthenticated: !!user,
    isAdmin: user?.role === "admin",
    isAllowed: user?.role === "admin" || user?.role === "allowed",
    refetch,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
