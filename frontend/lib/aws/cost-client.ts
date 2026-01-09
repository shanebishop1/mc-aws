/**
 * Cost Explorer types and functions
 */

export interface CostBreakdown {
  service: string;
  cost: string;
}

export interface CostData {
  period: { start: string; end: string };
  totalCost: string;
  currency: string;
  breakdown: CostBreakdown[];
  fetchedAt: string;
}

/**
 * Calculate date range based on period type
 */
function calculateDateRange(periodType: "current-month" | "last-month" | "last-30-days"): { start: Date; end: Date } {
  const now = new Date();
  let start: Date;
  let end: Date;

  if (periodType === "current-month") {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = now;
  } else if (periodType === "last-month") {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    end = new Date(now.getFullYear(), now.getMonth(), 0); // Last day of prev month
  } else {
    start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    end = now;
  }

  return { start, end };
}

/**
 * Process cost data from API response
 */
function processCostResponse(response: unknown): { breakdown: CostBreakdown[]; currency: string; total: number } {
  const breakdown: CostBreakdown[] = [];
  let total = 0;
  let currency = "USD";

  const responseWithData = response as unknown as {
    ResultsByTime?: Array<{
      Groups?: Array<{
        Keys?: string[];
        Metrics?: {
          UnblendedCost?: {
            Amount?: string;
            Unit?: string;
          };
        };
      }>;
    }>;
  };

  for (const result of responseWithData.ResultsByTime || []) {
    for (const group of result.Groups || []) {
      const serviceName = group.Keys?.[0] || "Unknown";
      const amount = Number.parseFloat(group.Metrics?.UnblendedCost?.Amount || "0");
      currency = group.Metrics?.UnblendedCost?.Unit || "USD";
      if (amount > 0) {
        breakdown.push({ service: serviceName, cost: amount.toFixed(2) });
        total += amount;
      }
    }
  }

  // Sort by cost descending
  breakdown.sort((a, b) => Number.parseFloat(b.cost) - Number.parseFloat(a.cost));

  return { breakdown, currency, total };
}

/**
 * Get AWS costs for the specified period
 * Note: Requires @aws-sdk/client-cost-explorer to be installed
 */
export async function getCosts(
  periodType: "current-month" | "last-month" | "last-30-days" = "current-month"
): Promise<CostData> {
  // Dynamic import to avoid build issues if package not installed
  let CostExplorerClient: unknown;
  let GetCostAndUsageCommand: unknown;

  try {
    const costExplorerModule = await import("@aws-sdk/client-cost-explorer");
    CostExplorerClient = costExplorerModule.CostExplorerClient;
    GetCostAndUsageCommand = costExplorerModule.GetCostAndUsageCommand;
  } catch {
    throw new Error("@aws-sdk/client-cost-explorer package is not installed. Please install it to use cost tracking.");
  }

  if (typeof CostExplorerClient !== "function") {
    throw new Error("CostExplorerClient is not available");
  }

  if (typeof GetCostAndUsageCommand !== "function") {
    throw new Error("GetCostAndUsageCommand is not available");
  }

  const CostExplorerClientFn = CostExplorerClient as unknown as {
    new (config: { region: string }): unknown;
  };
  const costExplorer = new CostExplorerClientFn({ region: "us-east-1" });

  const { start, end } = calculateDateRange(periodType);

  const GetCostAndUsageCommandFn = GetCostAndUsageCommand as unknown as {
    new (config: object): unknown;
  };
  const command = new GetCostAndUsageCommandFn({
    TimePeriod: {
      Start: start.toISOString().split("T")[0],
      End: end.toISOString().split("T")[0],
    },
    Granularity: "MONTHLY",
    Metrics: ["UnblendedCost"],
    GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
  });

  const costExplorerWithMethod = costExplorer as unknown as {
    send(cmd: unknown): Promise<unknown>;
  };
  const response = await costExplorerWithMethod.send(command);

  const { breakdown, currency, total } = processCostResponse(response);

  return {
    period: { start: start.toISOString().split("T")[0], end: end.toISOString().split("T")[0] },
    totalCost: total.toFixed(2),
    currency,
    breakdown,
    fetchedAt: new Date().toISOString(),
  };
}
