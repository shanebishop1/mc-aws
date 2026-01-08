"use client";

import { useState, useEffect, useCallback } from "react";
import { LuxuryButton } from "@/components/ui/LuxuryButton";
import { ServerStatus } from "@/components/ServerStatus";
import { motion } from "framer-motion";

type ServerState = "running" | "stopped" | "hibernated" | "pending" | "stopping" | "terminated" | "unknown";

export default function Home() {
  const [status, setStatus] = useState<ServerState>("unknown");
  const [ip, setIp] = useState<string | undefined>(undefined);
  const [instanceId, setInstanceId] = useState<string | undefined>(undefined);
  const [_isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      if (res.ok) {
        const data = await res.json();
        setStatus(data.state);
        setInstanceId(data.instanceId);
        // Only update IP if running
        setIp(data.state === "running" ? data.publicIp : undefined);
      }
    } catch (error) {
      console.error("Failed to fetch status", error);
    }
  }, []);

  // Poll status every 30 seconds (reduced frequency)
  useEffect(() => {
    const handleFetchStatus = async () => {
      await fetchStatus();
    };
    handleFetchStatus();
    const interval = setInterval(handleFetchStatus, 30000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const handleAction = async (action: string, endpoint: string) => {
    setIsLoading(true);
    setMessage(`Initiating ${action}...`);
    try {
      const body = instanceId ? JSON.stringify({ instanceId }) : undefined;
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
          setStatus(d.state);
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

  return (
    <main className="min-h-screen flex flex-col items-center py-24 px-4 bg-luxury-cream selection:bg-luxury-green selection:text-white">
      {/* Header */}
      <motion.header
        initial={{ y: -20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.8, ease: "easeOut" }}
        className="mb-24 text-center"
      >
        <h1 className="font-serif text-3xl italic tracking-wide text-luxury-black">
          Minecraft <span className="not-italic font-bold">Controller</span>
        </h1>
        <div className="w-12 h-[1px] bg-luxury-black/20 mx-auto mt-6" />
      </motion.header>

      {/* Main Content */}
      <div className="flex-1 w-full max-w-4xl flex flex-col items-center justify-between min-h-[400px]">
        {/* Status Section */}
        <section className="flex-1 flex flex-col justify-center items-center w-full mb-20 gap-8">
          <ServerStatus state={status} ip={ip} />
          <button
            type="button"
            onClick={fetchStatus}
            className="font-sans text-[10px] tracking-widest text-luxury-black/40 hover:text-luxury-green uppercase transition-colors"
          >
            [ Refresh Status ]
          </button>
        </section>

        {/* Controls Section - 'Wine List' Style */}
        <section className="w-full grid grid-cols-1 md:grid-cols-3 gap-8 items-center justify-items-center">
          {/* Left Col */}
          <div className="flex flex-col gap-6 w-full max-w-[200px] text-center md:text-right">
            <LuxuryButton
              variant="text"
              onClick={() => handleAction("Resume", "/api/resume")}
              disabled={status !== "hibernated" && status !== "stopped"}
            >
              Resume
            </LuxuryButton>
            <LuxuryButton
              variant="text"
              onClick={() => handleAction("Hibernate", "/api/hibernate")}
              disabled={status === "hibernated"}
            >
              Hibernate
            </LuxuryButton>
          </div>

          {/* Center - Primary Action */}
          <div className="order-first md:order-none mb-8 md:mb-0">
            {status === "running" ? (
              <LuxuryButton onClick={() => handleAction("Stop", "/api/stop")}>Stop Server</LuxuryButton>
            ) : (
              <LuxuryButton onClick={() => handleAction("Start", "/api/start")}>Start Server</LuxuryButton>
            )}
          </div>

          {/* Right Col */}
          <div className="flex flex-col gap-6 w-full max-w-[200px] text-center md:text-left">
            <LuxuryButton
              variant="text"
              onClick={() => handleAction("Restore", "/api/restore")}
              disabled={status !== "running"}
            >
              Restore
            </LuxuryButton>
            <LuxuryButton
              variant="text"
              onClick={() => handleAction("Backup", "/api/backup")}
              disabled={status !== "running"}
            >
              Backup
            </LuxuryButton>
          </div>
        </section>
      </div>

      {/* Feedback / Footer */}
      <footer className="mt-24 text-center h-12">
        {message && (
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="font-sans text-xs tracking-widest text-luxury-green uppercase"
          >
            {message}
          </motion.p>
        )}
        <p className="mt-8 font-sans text-[10px] text-luxury-black/30 tracking-[0.2em]">
          ASSEMBLY 2026 {/* PHASE IV */}
        </p>
      </footer>
    </main>
  );
}
