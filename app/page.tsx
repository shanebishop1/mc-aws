"use client";

import { ArtDecoBorder } from "@/components/ArtDecoBorder";
import { ControlsSection } from "@/components/ControlsSection";
import { PageHeader } from "@/components/PageHeader";
import { ServerStatus } from "@/components/ServerStatus";
import { useAuth } from "@/components/auth/auth-provider";
import { useButtonVisibility } from "@/hooks/useButtonVisibility";
import { useOperationPolling } from "@/hooks/useOperationPolling";
import { usePageFocus } from "@/hooks/usePageFocus";
import { useServerStatus } from "@/hooks/useServerStatus";
import { useStackStatus } from "@/hooks/useStackStatus";
import {
  type ActionEndpoint,
  ClientApiError,
  fetchAwsConfig,
  fetchServiceStatus,
  postServerAction,
  queryKeys,
} from "@/lib/client-api";
import { ServerState } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

const CostDashboard = dynamic(() => import("@/components/CostDashboard").then((module) => module.CostDashboard), {
  ssr: false,
});
const EmailManagementPanel = dynamic(
  () => import("@/components/EmailManagementPanel").then((module) => module.EmailManagementPanel),
  { ssr: false }
);
const ResumeModal = dynamic(() => import("@/components/ResumeModal").then((module) => module.ResumeModal), {
  ssr: false,
});

type MessageKind = "progress" | "success" | "error";

function isAcceptedUnconfirmedError(error: unknown): error is ClientApiError & { operation: { status: "accepted" } } {
  return error instanceof ClientApiError && error.status === 503 && error.operation?.status === "accepted";
}

const OperationFeedback = ({ message, kind }: { message: string | null; kind: MessageKind }) => {
  if (!message) return null;

  return (
    <motion.p
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      role={kind === "error" ? "alert" : "status"}
      aria-live={kind === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      className={`font-sans text-xs tracking-widest uppercase ${kind === "error" ? "text-red-800" : "text-green"}`}
    >
      {message}
    </motion.p>
  );
};

export default function Home() {
  const isPageFocused = usePageFocus();
  const { isAdmin, isAllowed, isAuthenticated } = useAuth();
  const { status, domain, publicIp, hasVolume, playerCount, isInitialLoad, fetchStatus, setPendingAction } =
    useServerStatus();
  const { stackExists, isLoading: stackLoading, error: stackError } = useStackStatus();

  const [message, setMessage] = useState<string | null>(null);
  const [messageKind, setMessageKind] = useState<MessageKind>("progress");
  const [serviceActive, setServiceActive] = useState<boolean | undefined>(undefined);
  const messageTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionSequenceRef = useRef(0);
  const actionRequestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const { poll: pollOperation, pollStop, cancel: cancelOperationPolling } = useOperationPolling();
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

  const awsConfigQuery = useQuery({
    queryKey: queryKeys.awsConfig,
    queryFn: fetchAwsConfig,
    enabled: isAdmin && isPageFocused,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const nextUrl = awsConfigQuery.data?.data?.ec2ConsoleUrl;
    if (nextUrl) {
      setAwsConsoleUrl(nextUrl);
    }
  }, [awsConfigQuery.data]);

  const serviceStatusQuery = useQuery({
    queryKey: queryKeys.serviceStatus,
    queryFn: fetchServiceStatus,
    enabled: isAllowed && status === ServerState.Running && isPageFocused,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    if (!isAllowed || status !== ServerState.Running) {
      setServiceActive(undefined);
      return;
    }

    const nextServiceActive = serviceStatusQuery.data?.data?.serviceActive;
    if (typeof nextServiceActive === "boolean") {
      setServiceActive(nextServiceActive);
    }
  }, [isAllowed, serviceStatusQuery.data, status]);

  // Use custom hook to derive button visibility state
  const { showResume, showStart, showStop, showHibernate, showBackupRestore, actionsEnabled } = useButtonVisibility(
    status,
    hasVolume,
    serviceActive
  );

  // Helper to update status optimistically based on action
  const updateOptimisticStatus = useCallback(
    (action: string) => {
      if (action === "Start" || action === "Resume") {
        setPendingAction("start");
      } else if (action === "Stop") {
        setPendingAction("stop");
      } else if (action === "Hibernate") {
        setPendingAction("hibernate");
      }
    },
    [setPendingAction]
  );

  const showMessage = useCallback((text: string | null, kind: MessageKind = "progress", clearAfterMs?: number) => {
    if (messageTimeoutRef.current) clearTimeout(messageTimeoutRef.current);
    messageTimeoutRef.current = null;
    setMessage(text);
    setMessageKind(kind);
    if (text && clearAfterMs) {
      messageTimeoutRef.current = setTimeout(() => {
        setMessage(null);
        messageTimeoutRef.current = null;
      }, clearAfterMs);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      actionSequenceRef.current += 1;
      actionRequestRef.current?.abort();
      cancelOperationPolling();
      if (messageTimeoutRef.current) clearTimeout(messageTimeoutRef.current);
    };
  }, [cancelOperationPolling]);

  // Helper to handle action error
  const handleActionError = useCallback(
    async (err: unknown) => {
      const error = err as { message?: string };
      const errorMessage = error.message || "Unknown error";
      setPendingAction(null);
      showMessage(`Failed: ${errorMessage}`, "error");

      const hasFocus = typeof document.hasFocus === "function" ? document.hasFocus() : true;
      if (document.visibilityState === "visible" && hasFocus) {
        try {
          await fetchStatus();
        } catch {
          // The action error is authoritative; a best-effort status refresh must not escape as an unhandled rejection.
        }
      }
    },
    [fetchStatus, setPendingAction, showMessage]
  );

  const isActionCurrent = useCallback(
    (actionSequence: number) => mountedRef.current && actionSequence === actionSequenceRef.current,
    []
  );

  const shouldIgnoreActionFailure = useCallback(
    (error: unknown, actionSequence: number) =>
      (error instanceof DOMException && error.name === "AbortError") || !isActionCurrent(actionSequence),
    [isActionCurrent]
  );

  const awaitAcceptedAction = useCallback(
    async (
      action: string,
      endpoint: string,
      actionSequence: number,
      data: Awaited<ReturnType<typeof postServerAction>>
    ): Promise<boolean> => {
      if (endpoint === "/api/stop") {
        showMessage("Stop request accepted. Waiting for the server to stop…", "progress");
        await pollStop();
        if (!isActionCurrent(actionSequence)) return false;
        setPendingAction(null);
        showMessage("Stop completed successfully.", "success", 7000);
        await fetchStatus();
        return true;
      }

      const operationId = data.operation?.id;
      if (!operationId) throw new Error("The server did not return an operation ID");

      showMessage(`${action} request accepted. Waiting for completion…`, "progress");
      await pollOperation(operationId);
      if (!isActionCurrent(actionSequence)) return false;

      setPendingAction(null);
      showMessage(`${action} completed successfully.`, "success", 7000);
      await fetchStatus();
      return true;
    },
    [fetchStatus, isActionCurrent, pollOperation, pollStop, setPendingAction, showMessage]
  );

  const settleAcceptedAction = useCallback(
    async (
      action: string,
      endpoint: string,
      actionSequence: number,
      data: Awaited<ReturnType<typeof postServerAction>>
    ): Promise<boolean> => {
      try {
        return await awaitAcceptedAction(action, endpoint, actionSequence, data);
      } catch (error) {
        if (shouldIgnoreActionFailure(error, actionSequence)) return false;
        await handleActionError(error);
        return false;
      }
    },
    [awaitAcceptedAction, handleActionError, shouldIgnoreActionFailure]
  );

  const handleAction = useCallback(
    async (action: string, endpoint: string, bodyData?: Record<string, string>) => {
      const actionSequence = ++actionSequenceRef.current;
      actionRequestRef.current?.abort();
      cancelOperationPolling();
      const requestController = new AbortController();
      actionRequestRef.current = requestController;
      updateOptimisticStatus(action);
      showMessage(`${action} request in progress…`, "progress");

      try {
        const typedEndpoint = endpoint as ActionEndpoint;
        const body = bodyData ?? undefined;
        const data = await postServerAction(typedEndpoint, body, requestController.signal);
        if (requestController.signal.aborted || !isActionCurrent(actionSequence)) {
          return false;
        }
        return await settleAcceptedAction(action, endpoint, actionSequence, data);
      } catch (err: unknown) {
        if (shouldIgnoreActionFailure(err, actionSequence)) return false;
        if (isAcceptedUnconfirmedError(err)) {
          return await settleAcceptedAction(action, endpoint, actionSequence, {
            success: false,
            error: err.message,
            operation: err.operation,
            timestamp: new Date().toISOString(),
          });
        }
        await handleActionError(err);
        return false;
      } finally {
        if (actionRequestRef.current === requestController) actionRequestRef.current = null;
      }
    },
    [
      cancelOperationPolling,
      handleActionError,
      isActionCurrent,
      shouldIgnoreActionFailure,
      settleAcceptedAction,
      showMessage,
      updateOptimisticStatus,
    ]
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
    setIsEmailPanelOpen(false);
    setIsCostDashboardOpen(false);
    setIsResumeModalOpen(true);
  };

  const handleResumeFromModal = (input: { restoreMode: "fresh" | "named"; backupName?: string }) => {
    setIsResumeModalOpen(false);
    void handleAction("Resume", "/api/resume", {
      restoreMode: input.restoreMode,
      ...(input.backupName ? { backupName: input.backupName } : {}),
    });
  };

  // Loading state - stack status check (show main UI with connecting state instead)
  // Removed separate loading screen - ServerStatus handles "connecting" state

  // Error state - AWS connection failed
  if (stackError) {
    return (
      <main className="h-full flex flex-col items-center justify-center px-6 py-6 relative bg-cream">
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
          <p className="font-sans text-xs text-charcoal/50">
            Please retry in a moment. If the problem continues, contact your administrator.
          </p>
        </div>
      </main>
    );
  }

  // No stack exists - show informational message (infra is deployed locally via CDK)
  if (!stackLoading && !stackExists) {
    return (
      <main
        data-testid="home-page"
        className="h-full flex flex-col px-6 pt-6 pb-6 sm:px-8 sm:pt-8 sm:pb-8 md:px-4 md:pt-4 md:pb-4 relative bg-cream selection:bg-green selection:text-white"
      >
        <ArtDecoBorder />
        {/* Header */}
        <PageHeader
          onOpenCosts={() => {
            setIsEmailPanelOpen(false);
            setIsResumeModalOpen(false);
            setIsCostDashboardOpen(true);
          }}
          onOpenEmails={() => {
            setIsCostDashboardOpen(false);
            setIsResumeModalOpen(false);
            setIsEmailPanelOpen(true);
          }}
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
          <OperationFeedback message={message} kind={messageKind} />
          <p className="font-sans uppercase text-[10px] text-charcoal/70 tracking-[0.2em]">Shane Bishop | 2025</p>
        </footer>
      </main>
    );
  }

  // Stack exists - show server controls
  return (
    <>
      <main
        data-testid="home-page"
        className="h-full flex flex-col px-6 pt-6 pb-6 sm:px-8 sm:pt-8 sm:pb-8 md:px-4 md:pt-4 md:pb-4 relative bg-cream selection:bg-green selection:text-white"
      >
        <ArtDecoBorder />
        {/* Header */}
        <PageHeader
          onOpenCosts={() => {
            setIsEmailPanelOpen(false);
            setIsResumeModalOpen(false);
            setIsCostDashboardOpen(true);
          }}
          onOpenEmails={() => {
            setIsCostDashboardOpen(false);
            setIsResumeModalOpen(false);
            setIsEmailPanelOpen(true);
          }}
          awsConsoleUrl={awsConsoleUrl}
        />

        {/* Middle Section - Centers Status Vertically */}
        <div className="flex-1 flex flex-col justify-center items-center w-full">
          {/* Status Section */}
          <section className="flex flex-col justify-center items-center w-full">
            <ServerStatus
              state={status}
              domain={domain}
              publicIp={publicIp}
              playerCount={playerCount}
              isLoading={isInitialLoad}
            />
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
          onRestoreStateChange={(_isRestoring, nextMessage) => {
            showMessage(nextMessage, "progress");
          }}
        />

        {/* Footer - Fixed Small Height */}
        <footer className="shrink-0 h-8 md:h-20 flex flex-col items-center justify-center text-center gap-2">
          <OperationFeedback message={message} kind={messageKind} />
          <p className="font-sans uppercase text-[10px] text-charcoal/70 tracking-[0.2em]">Shane Bishop | 2025</p>
        </footer>
      </main>

      {/* Resume Modal */}
      {isAdmin && isResumeModalOpen && (
        <ResumeModal isOpen onClose={() => setIsResumeModalOpen(false)} onResume={handleResumeFromModal} />
      )}

      {/* Email Management Panel */}
      {isAdmin && isEmailPanelOpen && <EmailManagementPanel isOpen onClose={() => setIsEmailPanelOpen(false)} />}

      {/* Cost Dashboard */}
      {isAdmin && isCostDashboardOpen && <CostDashboard isOpen onClose={() => setIsCostDashboardOpen(false)} />}
    </>
  );
}
