import { AsyncLocalStorage } from "node:async_hooks";

const executionContextStorage = new AsyncLocalStorage();

function runWithOperationExecutionContext(context, callback) {
  return executionContextStorage.run(context, callback);
}

function getOperationExecutionContext() {
  return executionContextStorage.getStore() || null;
}

export { getOperationExecutionContext, runWithOperationExecutionContext };
