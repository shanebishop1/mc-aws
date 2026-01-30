"use client";

import { ArtDecoBorder } from "@/components/ArtDecoBorder";
import { ControlsSection } from "@/components/ControlsSection";
import { CostDashboard } from "@/components/CostDashboard";
import { EmailManagementPanel } from "@/components/EmailManagementPanel";
import { PageHeader } from "@/components/PageHeader";
import { ResumeModal } from "@/components/ResumeModal";
import { ServerStatus } from "@/components/ServerStatus";
import { useAuth } from "@/components/auth/auth-provider";
import { useButtonVisibility } from "@/hooks/useButtonVisibility";
import { useServerStatus } from "@/hooks/useServerStatus";
import { useStackStatus } from "@/hooks/useStackStatus";
import { ServerState } from "@/lib/types";
import { motion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";

export default function Home() {
  const { isAdmin, isAuthenticated } = useAuth();
  const { status, ip, hasVolume, playerCount, isInitialLoad, fetchStatus, setStatus } = useServerStatus();
  const { stackExists, isLoading: stackLoading, error: stackError } = useStackStatus();

  const [instanceId] = useState<string | undefined>(undefined);
  const [_isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isResumeModalOpen, setIsResumeModalOpen] = useState(false);
  const [isEmailPanelOpen, setIsEmailPanelOpen] = useState(false);
  const [isCostDashboardOpen, setIsCostDashboardOpen] = useState(false);
  const [awsConsoleUrl, setAwsConsoleUrl] = useState<string | undefined>(undefined);

  // Handle Google Drive OAuth callback (when this page is loaded in a popup)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gdriveStatus = params.get("gdrive");

    if (gdriveStatus && window.opener) {
      if (gdriveStatus === "success") {
        window.opener.postMessage({ type: "GDRIVE_OAUTH_SUCCESS" }, window.location.origin);
      } else if (gdriveStatus === "error") {
        const errorMsg = params.get("message") || "OAuth failed";
        window.opener.postMessage({ type: "GDRIVE_OAUTH_ERROR", error: errorMsg }, window.location.origin);
      }
    }
  }, []);

  // Fetch AWS config for console URL
  useEffect(() => {
    if (!isAdmin) return;

    fetch("/api/aws-config")
      .then((res) => res.json())
      .then((data) => {
        if (data.success && data.data.ec2ConsoleUrl) {
          setAwsConsoleUrl(data.data.ec2ConsoleUrl);
        }
      })
      .catch(() => {
        // Silently fail - AWS link is optional
      });
  }, [isAdmin]);

  // Use custom hook to derive button visibility state
  const { showResume, showStart, showStop, showHibernate, showBackupRestore, actionsEnabled } = useButtonVisibility(
    status,
    hasVolume
  );

  const buildRequestBody = useCallback(
    (extraData?: Record<string, string>): string | undefined => {
      const bodyData: Record<string, string> = instanceId ? { instanceId } : {};
      if (extraData) {
        Object.assign(bodyData, extraData);
      }
      return Object.keys(bodyData).length > 0 ? JSON.stringify(bodyData) : undefined;
    },
    [instanceId]
  );

  const handleAction = useCallback(
    async (action: string, endpoint: string, bodyData?: Record<string, string>) => {
      setIsLoading(true);

      // Optimistically update status based on action
      if (action === "Start" || action === "Resume") {
        setStatus(ServerState.Pending);
      } else if (action === "Stop") {
        setStatus(ServerState.Stopping);
      }

      try {
        const body = buildRequestBody(bodyData);
        const res = await fetch(endpoint, {
          method: "POST",
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Action failed");

        // Immediate status refresh to get actual state
        setTimeout(async () => {
          await fetchStatus();
        }, 2000);
      } catch (err: unknown) {
        const error = err as { message?: string };
        setMessage(error.message || "Unknown error");
        // Refresh status on error to get actual state
        await fetchStatus();
      } finally {
        setIsLoading(false);
        // Clear error message after 5s
        setTimeout(() => setMessage(null), 5000);
      }
    },
    [buildRequestBody, fetchStatus, setStatus]
  );

  // If the user clicked Start while logged out, continue automatically after sign-in.
  useEffect(() => {
    if (!isAuthenticated) return;
    if (!stackExists) return;
    if (!(showStart || showResume)) return;

    const pending = window.sessionStorage.getItem("mc_pending_action");
    if (pending !== "start") return;

    window.sessionStorage.removeItem("mc_pending_action");
    void handleAction("Start", "/api/start");
  }, [handleAction, isAuthenticated, stackExists, showStart, showResume]);

  const handleResumeClick = () => {
    setIsResumeModalOpen(true);
  };

  const handleResumeFromModal = (backupName?: string) => {
    setIsResumeModalOpen(false);
    handleAction("Resume", "/api/resume", backupName ? { backupName } : undefined);
  };

  // Loading state - stack status check (show main UI with connecting state instead)
  // Removed separate loading screen - ServerStatus handles "connecting" state

  // Error state - AWS connection failed
  if (stackError) {
    return (
      <main className="h-full flex flex-col items-center justify-center px-6 py-6 bg-cream">
        <ArtDecoBorder />
        <div className="flex flex-col items-center gap-4 max-w-md text-center">
          <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center">
            <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <div>
            <h2 className="font-serif text-xl italic mb-2 text-red-600">Connection Error</h2>
            <p className="font-sans text-sm text-charcoal/70">{stackError}</p>
          </div>
          <p className="font-sans text-xs text-charcoal/50">Please check your AWS credentials and try again</p>
        </div>
      </main>
    );
  }

  // No stack exists - show informational message (infra is deployed locally via CDK)
  if (!stackLoading && !stackExists) {
    return (
      <main
        data-testid="home-page"
        className="h-full flex flex-col px-6 pt-6 pb-6 sm:px-8 sm:pt-8 sm:pb-8 md:px-4 md:pt-4 md:pb-4 bg-cream selection:bg-green selection:text-white"
      >
        <ArtDecoBorder />
        {/* Header */}
        <PageHeader
          onOpenCosts={() => setIsCostDashboardOpen(true)}
          onOpenEmails={() => setIsEmailPanelOpen(true)}
          awsConsoleUrl={awsConsoleUrl}
        />

        {/* Middle Section */}
        <div className="flex-1 flex flex-col justify-center items-center w-full px-4">
          <div className="flex flex-col items-center gap-8 max-w-lg text-center">
            <div>
              <h2 className="font-serif text-3xl italic mb-4 text-charcoal">Server Not Configured</h2>
              <p className="font-sans text-sm text-charcoal/70 leading-relaxed max-w-md">
                This app can&apos;t find the AWS infrastructure (CloudFormation stack). Provision the stack locally,
                then refresh this page.
              </p>
            </div>
            <p className="font-sans text-xs text-charcoal/60 tracking-wide">
              Admin sign-in is still required for server actions.
            </p>
          </div>
        </div>

        {/* Footer - Fixed Small Height */}
        <footer className="shrink-0 h-8 md:h-20 flex flex-col items-center justify-center text-center">
          {message && (
            <motion.p
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`font-sans text-xs tracking-widest uppercase ${
                message.includes("Error") || message.includes("Failed") ? "text-red-800" : "text-green"
              }`}
            >
              {message}
            </motion.p>
          )}
          <p className="font-sans uppercase text-[10px] text-charcoal/30 tracking-[0.2em]">Shane Bishop | 2025</p>
        </footer>
      </main>
    );
  }

  // Stack exists - show server controls
  return (
    <>
      <main
        data-testid="home-page"
        className="h-full flex flex-col px-6 pt-6 pb-6 sm:px-8 sm:pt-8 sm:pb-8 md:px-4 md:pt-4 md:pb-4 bg-cream selection:bg-green selection:text-white"
      >
        <ArtDecoBorder />
        {/* Header */}
        <PageHeader
          onOpenCosts={() => setIsCostDashboardOpen(true)}
          onOpenEmails={() => setIsEmailPanelOpen(true)}
          awsConsoleUrl={awsConsoleUrl}
        />

        {/* Middle Section - Centers Status Vertically */}
        <div className="flex-1 flex flex-col justify-center items-center w-full">
          {/* Status Section */}
          <section className="flex flex-col justify-center items-center w-full">
            <ServerStatus state={status} ip={ip} playerCount={playerCount} isLoading={isInitialLoad} />
          </section>
        </div>

        {/* Controls Section */}
        <ControlsSection
          status={status}
          showStart={showStart}
          showStop={showStop}
          showResume={showResume}
          showHibernate={showHibernate}
          showBackupRestore={showBackupRestore}
          actionsEnabled={actionsEnabled}
          onAction={handleAction}
          onOpenResume={handleResumeClick}
        />

        {/* Footer - Fixed Small Height */}
        <footer className="shrink-0 h-8 md:h-20 flex flex-col items-center justify-center text-center gap-2">
          {message && (
            <motion.p
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`font-sans text-xs tracking-widest uppercase ${
                message.includes("Error") || message.includes("Failed") || status === "unknown"
                  ? "text-red-800"
                  : "text-green"
              }`}
            >
              {message}
            </motion.p>
          )}
          <p className="font-sans uppercase text-[10px] text-charcoal/30 tracking-[0.2em]">Shane Bishop | 2025</p>
        </footer>
      </main>

      {/* Resume Modal */}
      {isAdmin && (
        <ResumeModal
          isOpen={isResumeModalOpen}
          onClose={() => setIsResumeModalOpen(false)}
          onResume={handleResumeFromModal}
        />
      )}

      {/* Email Management Panel */}
      {isAdmin && <EmailManagementPanel isOpen={isEmailPanelOpen} onClose={() => setIsEmailPanelOpen(false)} />}

      {/* Cost Dashboard */}
      {isAdmin && <CostDashboard isOpen={isCostDashboardOpen} onClose={() => setIsCostDashboardOpen(false)} />}
    </>
  );
}
