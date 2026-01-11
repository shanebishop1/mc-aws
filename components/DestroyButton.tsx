"use client";

import { useAuth } from "@/components/auth/auth-provider";
import { ConfirmationDialog } from "@/components/ui/ConfirmationDialog";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { useState } from "react";

interface DestroyButtonProps {
  onDestroyStart?: () => void;
  onDestroyComplete?: () => void;
  onError?: (error: string) => void;
}

export const DestroyButton = ({ onDestroyStart, onDestroyComplete, onError }: DestroyButtonProps) => {
  const { isAuthenticated } = useAuth();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isDestroying, setIsDestroying] = useState(false);

  const handleClick = () => {
    if (!isAuthenticated) {
      window.open("/api/auth/login", "google-auth", "width=500,height=600,menubar=no,toolbar=no");
      return;
    }
    setIsDialogOpen(true);
  };

  const handleDestroy = async () => {
    setIsDestroying(true);
    onDestroyStart?.();

    try {
      console.log("[DESTROY] Destroying Minecraft server stack");

      const response = await fetch("/api/destroy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const result = (await response.json()) as { success: boolean; error?: string; message: string };

      if (!response.ok || !result.success) {
        const errorMessage = result.error || "Failed to destroy server";
        console.error("[DESTROY] Error:", errorMessage);
        onError?.(errorMessage);
        return;
      }

      console.log("[DESTROY] Server destroyed successfully:", result.message);
      onDestroyComplete?.();
    } catch (error) {
      console.error("[DESTROY] Unexpected error:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      onError?.(errorMessage);
    } finally {
      setIsDestroying(false);
      setIsDialogOpen(false);
    }
  };

  return (
    <>
      <motion.button
        data-testid="destroy-button"
        whileHover={{ y: -1 }}
        transition={{ duration: 0.1 }}
        whileTap={{ y: 0 }}
        onClick={handleClick}
        className={cn(
          "cursor-pointer relative px-6 py-2 overflow-hidden border transition-all duration-300",
          "font-sans text-xs tracking-[0.2em] font-medium uppercase",
          "border-red-600 text-red-600 hover:bg-red-600 hover:text-white",
          "disabled:cursor-not-allowed disabled:opacity-50"
        )}
      >
        <span className="relative z-10">Destroy</span>
        <motion.div
          className="absolute inset-0 bg-red-600"
          initial={{ scaleX: 0, originX: 0 }}
          whileHover={{ scaleX: 1 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
        />
      </motion.button>

      <ConfirmationDialog
        isOpen={isDialogOpen}
        onClose={() => setIsDialogOpen(false)}
        onConfirm={handleDestroy}
        title="Destroy Minecraft Server"
        description="This action will permanently delete the Minecraft server stack, including all infrastructure and resources. This cannot be undone. Please type &quot;destroy&quot; below to confirm this destructive action."
        confirmText="Destroy Server"
        cancelText="Cancel"
        requireTypedConfirmation="destroy"
        variant="danger"
        isLoading={isDestroying}
      />
    </>
  );
};
