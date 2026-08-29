const transientErrorNames = new Set([
  "Throttling",
  "ThrottlingException",
  "TooManyRequestsException",
  "RequestTimeout",
  "TimeoutError",
  "InternalServerError",
  "ServiceUnavailable",
  "ProvisionedThroughputExceededException",
  "TransactionConflictException",
  "EC2ThrottledException",
]);

class RetryableLifecycleError extends Error {
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "RetryableLifecycleError";
    this.code = options.code || "retryable_lifecycle_failure";
    this.retainLifecycleLock = options.retainLifecycleLock === true;
  }
}

class TerminalLifecycleError extends Error {
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "TerminalLifecycleError";
    this.code = options.code || "terminal_lifecycle_failure";
  }
}

function classifyLifecycleFailure(error) {
  if (error?.name === "LifecycleLockConflictError") {
    return { retryable: false, retainLock: false, code: "operation_conflict" };
  }
  if (error instanceof TerminalLifecycleError || error?.ssmTerminal === true) {
    return { retryable: false, retainLock: false, code: error.code || "terminal_execution_failure" };
  }
  if (error instanceof RetryableLifecycleError || error?.retainLifecycleLock === true) {
    return {
      retryable: true,
      retainLock: error?.retainLifecycleLock === true,
      code: error?.code || "remote_command_unresolved",
    };
  }
  const httpStatus = error?.$metadata?.httpStatusCode;
  if (transientErrorNames.has(error?.name) || httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599)) {
    return { retryable: true, retainLock: false, code: "transient_aws_failure" };
  }
  // Untagged infrastructure failures are retried. Deterministic validation and
  // business failures must be raised as TerminalLifecycleError at their source.
  return { retryable: true, retainLock: false, code: "lifecycle_execution_failed" };
}

export { RetryableLifecycleError, TerminalLifecycleError, classifyLifecycleFailure };
