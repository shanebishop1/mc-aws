"use client";

import { PageHeader } from "@/components/PageHeader";
import { ServerStatus } from "@/components/ServerStatus";
import { ControlsSection } from "@/components/ControlsSection";
import { LuxuryButton } from "@/components/ui/Button";
import { ResumeModal } from "@/components/ResumeModal";
import { EmailManagementPanel } from "@/components/EmailManagementPanel";
import { CostDashboard } from "@/components/CostDashboard";
import { useButtonVisibility } from "@/hooks/useButtonVisibility";
import { useServerStatus } from "@/hooks/useServerStatus";
import { motion } from "framer-motion";
import { useState } from "react";

export default function Home() {
  const { status, ip, hasVolume, playerCount, isInitialLoad, fetchStatus } = useServerStatus();
  const [instanceId] = useState<string | undefined>(undefined);
  const [_isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isResumeModalOpen, setIsResumeModalOpen] = useState(false);
  const [isEmailPanelOpen, setIsEmailPanelOpen] = useState(false);
  const [isCostDashboardOpen, setIsCostDashboardOpen] = useState(false);

  // Use custom hook to derive button visibility state
  const { showResume, showStart, showStop, showHibernate, showBackupRestore, actionsEnabled } = useButtonVisibility(
    status,
    hasVolume
  );

  const buildRequestBody = (backupName?: string): string | undefined => {
    const bodyData: { instanceId?: string; backupName?: string } = instanceId ? { instanceId } : {};
    if (backupName) {
      bodyData.backupName = backupName;
    }
    return Object.keys(bodyData).length > 0 ? JSON.stringify(bodyData) : undefined;
  };

  const handleAction = async (action: string, endpoint: string, backupName?: string) => {
    setIsLoading(true);
    setMessage(`Initiating ${action}...`);
    try {
      const body = buildRequestBody(backupName);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Action failed");
      setMessage(data.message || `${action} initiated successfully.`);

      // Immediate status refresh
      setTimeout(async () => {
        await fetchStatus();
      }, 2000);
    } catch (err: unknown) {
      const error = err as { message?: string };
      setMessage(error.message || "Unknown error");
    } finally {
      setIsLoading(false);
      // Clear message after 5s
      setTimeout(() => setMessage(null), 5000);
    }
  };

  const handleResumeClick = () => {
    setIsResumeModalOpen(true);
  };

  const handleResumeFromModal = (backupName?: string) => {
    setIsResumeModalOpen(false);
    handleAction("Resume", "/api/resume", backupName);
  };

  return (
    <>
      <main className="h-full flex flex-col px-4 md:pb-0 bg-cream selection:bg-green selection:text-white">
        {/* Header */}
        <PageHeader onOpenCosts={() => setIsCostDashboardOpen(true)} onOpenEmails={() => setIsEmailPanelOpen(true)} />

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
        <footer className="shrink-0 h-8 md:h-20 flex flex-col items-center justify-center text-center">
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
          <p className="font-sans uppercase text-[10px] text-charcoal/30 tracking-[0.2em]">
            Shane Bishop | 2026 {/* PHASE IV */}
          </p>
        </footer>
      </main>

      {/* Resume Modal */}
      <ResumeModal
        isOpen={isResumeModalOpen}
        onClose={() => setIsResumeModalOpen(false)}
        onResume={handleResumeFromModal}
      />

      {/* Email Management Panel */}
      <EmailManagementPanel isOpen={isEmailPanelOpen} onClose={() => setIsEmailPanelOpen(false)} />

      {/* Cost Dashboard */}
      <CostDashboard isOpen={isCostDashboardOpen} onClose={() => setIsCostDashboardOpen(false)} />
    </>
  );
}
