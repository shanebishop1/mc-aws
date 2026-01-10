"use client";

import { GoogleDriveSetupPrompt } from "@/components/GoogleDriveSetupPrompt";
import { LuxuryButton } from "@/components/ui/Button";
import { ConfirmationDialog } from "@/components/ui/ConfirmationDialog";
import { useState } from "react";

interface DeployButtonProps {
  onDeployStart?: () => void;
  onDeployComplete?: () => void;
  onError?: (error: string) => void;
}

export const DeployButton = ({ onDeployStart, onDeployComplete, onError }: DeployButtonProps) => {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showGDrivePrompt, setShowGDrivePrompt] = useState(false);
  const [isCheckingGDrive, setIsCheckingGDrive] = useState(false);

  const checkGDriveStatus = async (): Promise<boolean> => {
    try {
      const response = await fetch("/api/gdrive/status");
      const data = await response.json();
      return data.success && data.data?.configured === true;
    } catch (error) {
      console.error("[DEPLOY] Failed to check GDrive status:", error);
      return false;
    }
  };

  const handleDeploy = async () => {
    try {
      setIsCheckingGDrive(true);

      // Check Google Drive status before deployment
      const gdriveConfigured = await checkGDriveStatus();

      if (!gdriveConfigured) {
        // Show Google Drive setup prompt
        setShowGDrivePrompt(true);
        setIsCheckingGDrive(false);
        return;
      }

      // Google Drive is configured (or user skipped), proceed with deployment
      proceedWithDeployment();
    } catch (error) {
      console.error("[DEPLOY] Error during GDrive check:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      onError?.(errorMessage);
      setIsCheckingGDrive(false);
    }
  };

  const proceedWithDeployment = async () => {
    try {
      onDeployStart?.();
      setIsLoading(true);
      setIsDialogOpen(false);
      setIsCheckingGDrive(false);

      console.log("[DEPLOY] Starting deployment...");

      const response = await fetch("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || "Deployment failed");
      }

      console.log("[DEPLOY] Deployment successful:", result.data);
      onDeployComplete?.();
    } catch (error) {
      console.error("[DEPLOY] Deployment error:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      onError?.(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  const handleGDriveSetupComplete = () => {
    setShowGDrivePrompt(false);
    proceedWithDeployment();
  };

  const handleGDriveSkip = () => {
    setShowGDrivePrompt(false);
    proceedWithDeployment();
  };

  return (
    <div className="flex flex-col items-center gap-6">
      <LuxuryButton onClick={() => setIsDialogOpen(true)} disabled={isLoading}>
        {isLoading ? "Deploying..." : "Deploy Server"}
      </LuxuryButton>

      <ConfirmationDialog
        isOpen={isDialogOpen}
        onClose={() => setIsDialogOpen(false)}
        onConfirm={handleDeploy}
        title="Deploy Minecraft Server"
        description="This will create a new Minecraft server on AWS with all required infrastructure (EC2 instance, networking, storage, and Lambda functions). This process takes several minutes to complete."
        confirmText="Deploy"
        cancelText="Cancel"
        requireTypedConfirmation="deploy"
        variant="default"
        isLoading={isCheckingGDrive || isLoading}
      />

      <GoogleDriveSetupPrompt
        isOpen={showGDrivePrompt}
        onClose={() => setShowGDrivePrompt(false)}
        onSetupComplete={handleGDriveSetupComplete}
        onSkip={handleGDriveSkip}
        allowSkip={true}
        context="deploy"
      />
    </div>
  );
};
