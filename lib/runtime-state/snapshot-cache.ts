export const snapshotCacheKeys = {
  status: "status:latest",
  serviceStatus: "service-status:latest",
  stackStatus: "stack-status:latest",
  costs: "costs:latest",
  emails: "emails:latest",
} as const;

export const snapshotCacheTtlSeconds = {
  status: 5,
  serviceStatus: 5,
  stackStatus: 30,
  emails: 30,
} as const;
