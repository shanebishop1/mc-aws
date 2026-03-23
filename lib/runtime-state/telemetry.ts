export const runtimeStateTelemetryEventName = "runtime_state.operation";

export type RuntimeStateTelemetryOutcome = "HIT" | "MISS" | "THROTTLE" | "FALLBACK";

export interface RuntimeStateTelemetryEvent {
  event: typeof runtimeStateTelemetryEventName;
  operation: string;
  outcome: RuntimeStateTelemetryOutcome;
  source: string;
  route?: string;
  key?: string;
  reason?: string;
  retryAfterSeconds?: number;
  timestamp: string;
}

export interface RuntimeStateTelemetryInput {
  operation: string;
  outcome: RuntimeStateTelemetryOutcome;
  source: string;
  route?: string;
  key?: string;
  reason?: string;
  retryAfterSeconds?: number;
}

export const createRuntimeStateTelemetryEvent = ({
  operation,
  outcome,
  source,
  route,
  key,
  reason,
  retryAfterSeconds,
}: RuntimeStateTelemetryInput): RuntimeStateTelemetryEvent => {
  return {
    event: runtimeStateTelemetryEventName,
    operation,
    outcome,
    source,
    route,
    key,
    reason,
    retryAfterSeconds,
    timestamp: new Date().toISOString(),
  };
};

export const emitRuntimeStateTelemetry = (
  input: RuntimeStateTelemetryInput,
  logger: (event: RuntimeStateTelemetryEvent) => void = (event) => {
    console.log("[RUNTIME-STATE]", event);
  }
): RuntimeStateTelemetryEvent => {
  const event = createRuntimeStateTelemetryEvent(input);
  logger(event);
  return event;
};
