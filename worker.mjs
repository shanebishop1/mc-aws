import worker from "./.open-next/worker.js";
import { AgentSessionDurableObject } from "./lib/agent/state/agent-session-durable-object";
import { AgentSessionIndexDurableObject } from "./lib/agent/state/agent-session-index-durable-object";
import { AgentSessionShardDurableObject } from "./lib/agent/state/agent-session-shard-durable-object";
import { setRuntimeAuthSecret } from "./lib/runtime-auth-secret";
import { setRuntimeBackendMode } from "./lib/runtime-backend-mode";
import { RuntimeStateDurableObject } from "./lib/runtime-state/runtime-state-durable-object";
import { validateWorkerStartupEnvironment } from "./lib/worker-startup";

export {
  AgentSessionDurableObject,
  AgentSessionIndexDurableObject,
  AgentSessionShardDurableObject,
  RuntimeStateDurableObject,
};

export default {
  ...worker,
  fetch(request, environment, context) {
    validateWorkerStartupEnvironment(environment);
    setRuntimeBackendMode("aws");
    setRuntimeAuthSecret(environment.AUTH_SECRET);
    return worker.fetch(request, environment, context);
  },
};
