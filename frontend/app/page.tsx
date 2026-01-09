"use client";

import { ServerStatus } from "@/components/ServerStatus";
import { LuxuryButton } from "@/components/ui/LuxuryButton";
import { ResumeModal } from "@/components/ResumeModal";
import { EmailManagementPanel } from "@/components/EmailManagementPanel";
import { CostDashboard } from "@/components/CostDashboard";
import { useButtonVisibility } from "@/hooks/useButtonVisibility";
import { motion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";

type ServerState = "running" | "stopped" | "hibernated" | "pending" | "stopping" | "terminated" | "unknown";

const fetchPlayerCount = async (setPlayerCount: (count: number | undefined) => void) => {
  try {
    const playerRes = await fetch("/api/players");
    if (playerRes.ok) {
      const playerData = await playerRes.json();
      if (playerData.success && playerData.data) {
        setPlayerCount(playerData.data.count);
      }
    }
  } catch (error) {
    console.error("Failed to fetch player count", error);
  }
};

export default function Home() {
  const [status, setStatus] = useState<ServerState>("unknown");
  const [hasVolume, setHasVolume] = useState<boolean | undefined>(undefined);
  const [ip, setIp] = useState<string | undefined>(undefined);
  const [instanceId, setInstanceId] = useState<string | undefined>(undefined);
  const [playerCount, setPlayerCount] = useState<number | undefined>(undefined);
  const [_isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [isResumeModalOpen, setIsResumeModalOpen] = useState(false);
  const [isEmailPanelOpen, setIsEmailPanelOpen] = useState(false);
  const [isCostDashboardOpen, setIsCostDashboardOpen] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      if (res.ok) {
        const data = await res.json();
        setStatus(data.data.state);
        setInstanceId(data.data.instanceId);
        setHasVolume(data.data.hasVolume);
        // Only update IP if running
        setIp(data.data.state === "running" ? data.data.publicIp : undefined);
        
        // Fetch player count if server is running
        if (data.data.state === "running") {
          await fetchPlayerCount(setPlayerCount);
        } else {
          setPlayerCount(undefined);
        }
      }
    } catch (error) {
      console.error("Failed to fetch status", error);
    } finally {
      setIsInitialLoad(false);
    }
  }, []);

   // Poll status every 5 seconds
  useEffect(() => {
    const handleFetchStatus = async () => {
      await fetchStatus();
    };
    handleFetchStatus();
    const interval = setInterval(handleFetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Use custom hook to derive button visibility state
  const {
    showResume,
    showStart,
    showStop,
    showHibernate,
    showBackupRestore,
    actionsEnabled,
  } = useButtonVisibility(status, hasVolume);

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
        const res = await fetch("/api/status");
        if (res.ok) {
          const d = await res.json();
          setStatus(d.data.state);
          setHasVolume(d.data.hasVolume);
        }
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
        <main className="h-full flex flex-col px-4 md:pb-0 bg-luxury-cream selection:bg-luxury-green selection:text-white">
        {/* Header - Fixed Height */}
          <motion.header
             initial={{ y: -20, opacity: 0 }}
             animate={{ y: 0, opacity: 1 }}
             transition={{ duration: 0.8, ease: "easeOut" }}
              className="relative shrink-0 pt-2 pb-1 md:pt-8 md:pb-4 text-center"
           >
            <h1 className="font-serif text-3xl italic tracking-wide text-luxury-black">
              mc-aws <span className="not-italic font-bold">Controller</span>
            </h1>

            {/* Header Icons - Below title on mobile, absolute top-right on desktop */}
            <div className="flex justify-center gap-3 mt-2 md:absolute md:top-8 md:right-4 md:mt-0">
              {/* GitHub Button */}
              <motion.a
                href="https://github.com/shanebishop1/mc-aws"
                target="_blank"
                rel="noopener noreferrer"
                whileHover={{ scale: 1.1 }}
                transition={{ duration: 0.1 }}
                whileTap={{ scale: 0.95 }}
                className="cursor-pointer p-1 text-luxury-black/40 hover:text-luxury-green transition-colors"
                title="View on GitHub"
              >
                <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
                  <path
                    fillRule="evenodd"
                    clipRule="evenodd"
                    d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z"
                  />
                </svg>
              </motion.a>

              {/* Costs Button */}
              <motion.button
                onClick={() => setIsCostDashboardOpen(true)}
                whileHover={{ scale: 1.1 }}
                transition={{ duration: 0.1 }}
                whileTap={{ scale: 0.95 }}
                className="cursor-pointer p-1 text-luxury-black/40 hover:text-luxury-green transition-colors"
                title="View AWS costs"
              >
                <svg
                  className="w-7 h-7"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                 <path
                   strokeLinecap="round"
                   strokeLinejoin="round"
                   strokeWidth={1.5}
                   d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                 />
               </svg>
             </motion.button>
             
              {/* Email Management Button */}
              <motion.button
                onClick={() => setIsEmailPanelOpen(true)}
                whileHover={{ scale: 1.1 }}
                transition={{ duration: 0.1 }}
                whileTap={{ scale: 0.95 }}
                className="cursor-pointer p-1 text-luxury-black/40 hover:text-luxury-green transition-colors"
                title="Manage email access"
              >
                <svg
                  className="w-7 h-7"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                 <path
                   strokeLinecap="round"
                   strokeLinejoin="round"
                   strokeWidth={1.5}
                   d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                 />
               </svg>
             </motion.button>
           </div>
         </motion.header>

         {/* Middle Section - Centers Status Vertically */}
         <div className="flex-1 flex flex-col justify-center items-center w-full">
            {/* Status Section */}
            <section className="flex flex-col justify-center items-center w-full">
              <ServerStatus state={status} ip={ip} playerCount={playerCount} isLoading={isInitialLoad} />
            </section>
         </div>

         {/* Controls Section - Fixed Height Container (always reserves space) */}
           <div className="shrink-0 h-24 md:h-48 flex items-center justify-center w-full">
          {/* Controls Grid - Only renders buttons inside container */}
          {status !== "unknown" && (
             <section className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-8 items-center justify-items-center">
              {/* Left Col */}
              <div className="flex flex-col gap-6 w-full max-w-[200px] text-center md:text-right">
                {showHibernate && (
                  <LuxuryButton
                    variant="text"
                    onClick={() => handleAction("Hibernate", "/api/hibernate")}
                    disabled={!actionsEnabled}
                  >
                    Hibernate
                  </LuxuryButton>
                )}
              </div>

              {/* Center - Primary Action */}
              <div className="order-first md:order-none">
                {showStop ? (
                  <LuxuryButton onClick={() => handleAction("Stop", "/api/stop")} disabled={!actionsEnabled}>
                    Stop Server
                  </LuxuryButton>
                ) : showStart || showResume ? (
                  <LuxuryButton
                    onClick={() =>
                      showResume ? handleResumeClick() : handleAction("Start", "/api/start")
                    }
                    disabled={!actionsEnabled}
                  >
                    {showResume ? "Resume" : "Start Server"}
                  </LuxuryButton>
                ) : null}
              </div>

              {/* Right Col */}
              <div className="flex flex-col gap-6 w-full max-w-[200px] text-center md:text-left">
                {showBackupRestore && (
                  <>
                    <LuxuryButton
                      variant="text"
                      onClick={() => handleAction("Restore", "/api/restore")}
                      disabled={!actionsEnabled}
                    >
                      Restore
                    </LuxuryButton>
                    <LuxuryButton
                      variant="text"
                      onClick={() => handleAction("Backup", "/api/backup")}
                      disabled={!actionsEnabled}
                    >
                      Backup
                    </LuxuryButton>
                  </>
                )}
              </div>
            </section>
          )}
        </div>

         {/* Footer - Fixed Small Height */}
           <footer className="shrink-0 h-8 md:h-20 flex flex-col items-center justify-center text-center">
          {message && (
            <motion.p
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`font-sans text-xs tracking-widest uppercase ${
                message.includes("Error") || message.includes("Failed") || status === "unknown"
                  ? "text-red-800"
                  : "text-luxury-green"
              }`}
            >
              {message}
            </motion.p>
          )}
            <p className="font-sans uppercase text-[10px] text-luxury-black/30 tracking-[0.2em]">
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
       <EmailManagementPanel
         isOpen={isEmailPanelOpen}
         onClose={() => setIsEmailPanelOpen(false)}
       />

       {/* Cost Dashboard */}
       <CostDashboard
         isOpen={isCostDashboardOpen}
         onClose={() => setIsCostDashboardOpen(false)}
       />
    </>
  );
}

