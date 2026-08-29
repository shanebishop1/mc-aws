import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  PutRetentionPolicyCommand,
} from "@aws-sdk/client-cloudwatch-logs";

const logs = new CloudWatchLogsClient({});

async function updateExistingRetention(logGroupNames, retentionInDays) {
  let updated = 0;
  for (const logGroupName of logGroupNames) {
    const response = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: logGroupName, limit: 1 }));
    const group = (response.logGroups || []).find((candidate) => candidate.logGroupName === logGroupName);
    if (group) {
      try {
        await logs.send(new PutRetentionPolicyCommand({ logGroupName, retentionInDays }));
        updated += 1;
      } catch (error) {
        if (error?.name !== "ResourceNotFoundException") throw error;
      }
    }
  }
  console.log(`[LOG_RETENTION] Applied ${retentionInDays}-day retention to ${updated} existing Lambda log group(s)`);
}

export const handler = async (event) => {
  const logGroupNames = event.ResourceProperties?.LogGroupNames || event.OldResourceProperties?.LogGroupNames;
  const retentionInDays = Number(event.ResourceProperties?.RetentionInDays || 30);
  const physicalResourceId = event.PhysicalResourceId || `${event.StackId}:lambda-log-retention:v1`;
  if (event.RequestType === "Delete") return { PhysicalResourceId: physicalResourceId };
  if (
    !Array.isArray(logGroupNames) ||
    logGroupNames.length < 1 ||
    logGroupNames.length > 20 ||
    new Set(logGroupNames).size !== logGroupNames.length ||
    logGroupNames.some((name) => typeof name !== "string" || !/^\/aws\/lambda\/[A-Za-z0-9-_]{1,64}$/.test(name)) ||
    retentionInDays !== 30
  ) {
    throw new Error("Invalid log retention migration properties");
  }
  await updateExistingRetention(logGroupNames, retentionInDays);
  return { PhysicalResourceId: physicalResourceId };
};

export { updateExistingRetention };
