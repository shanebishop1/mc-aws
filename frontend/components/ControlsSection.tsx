"use client";

import { LuxuryButton } from "@/components/ui/LuxuryButton";

interface ControlsSectionProps {
  status: string;
  showStart: boolean;
  showStop: boolean;
  showResume: boolean;
  showHibernate: boolean;
  showBackupRestore: boolean;
  actionsEnabled: boolean;
  onAction: (action: string, endpoint: string) => void;
  onOpenResume: () => void;
}

export const ControlsSection = ({
  status,
  showStart,
  showStop,
  showResume,
  showHibernate,
  showBackupRestore,
  actionsEnabled,
  onAction,
  onOpenResume,
}: ControlsSectionProps) => {
  return (
    <div className="shrink-0 h-24 md:h-48 flex items-center justify-center w-full">
      {/* Controls Grid - Only renders buttons inside container */}
      {status !== "unknown" && (
        <section className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-8 items-center justify-items-center">
          {/* Left Col */}
          <div className="flex flex-col gap-6 w-full max-w-[200px] text-center md:text-right">
            {showHibernate && (
              <LuxuryButton
                variant="text"
                onClick={() => onAction("Hibernate", "/api/hibernate")}
                disabled={!actionsEnabled}
              >
                Hibernate
              </LuxuryButton>
            )}
          </div>

          {/* Center - Primary Action */}
          <div className="order-first md:order-none">
            {showStop ? (
              <LuxuryButton onClick={() => onAction("Stop", "/api/stop")} disabled={!actionsEnabled}>
                Stop Server
              </LuxuryButton>
            ) : showStart || showResume ? (
              <LuxuryButton
                onClick={() =>
                  showResume ? onOpenResume() : onAction("Start", "/api/start")
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
                  onClick={() => onAction("Restore", "/api/restore")}
                  disabled={!actionsEnabled}
                >
                  Restore
                </LuxuryButton>
                <LuxuryButton
                  variant="text"
                  onClick={() => onAction("Backup", "/api/backup")}
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
  );
}
