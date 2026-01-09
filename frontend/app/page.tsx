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
            <h1 className="font-serif text-3xl italic tracking-wide text-luxury-black px-12 md:px-0">
             mc-aws <span className="not-italic font-bold">Controller</span>
           </h1>
             <div className="w-12 h-[1px] bg-luxury-black/20 mx-auto mt-2 md:mt-6" />
           
            {/* Header Icons - Top right on all screens */}
              <div className="absolute top-2 right-2 md:top-8 md:right-4 flex gap-3">
             {/* Costs Button */}
             <motion.button
               onClick={() => setIsCostDashboardOpen(true)}
               whileHover={{ scale: 1.1 }}
               whileTap={{ scale: 0.95 }}
               className="text-luxury-black/40 hover:text-luxury-green transition-colors"
               title="View AWS costs"
             >
               <svg
                 className="w-6 h-6"
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
               whileTap={{ scale: 0.95 }}
               className="text-luxury-black/40 hover:text-luxury-green transition-colors"
               title="Manage email access"
             >
               <svg
                 className="w-6 h-6"
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

