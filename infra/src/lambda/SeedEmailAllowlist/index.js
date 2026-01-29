import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

const ssm = new SSMClient({});

export const handler = async (event) => {
  const paramName = process.env.PARAM_NAME || "/minecraft/email-allowlist";
  const seedValue = process.env.SEED_VALUE || "";

  console.log("[SEED_ALLOWLIST] RequestType:", event.RequestType);

  if (event.RequestType === "Delete") {
    return { PhysicalResourceId: paramName };
  }

  try {
    const existing = await ssm.send(new GetParameterCommand({ Name: paramName }));
    const existingValue = existing?.Parameter?.Value || "";

    if (existingValue.trim()) {
      console.log("[SEED_ALLOWLIST] Parameter exists; skipping:", paramName);
      return { PhysicalResourceId: paramName };
    }

    if (!seedValue.trim()) {
      console.log("[SEED_ALLOWLIST] Parameter empty and seed empty; leaving as-is:", paramName);
      return { PhysicalResourceId: paramName };
    }

    console.log("[SEED_ALLOWLIST] Parameter empty; seeding:", paramName);
    await ssm.send(
      new PutParameterCommand({
        Name: paramName,
        Value: seedValue,
        Type: "String",
        Overwrite: true,
      })
    );

    return { PhysicalResourceId: paramName };
  } catch (error) {
    const errorWithName = error;
    if (errorWithName && errorWithName.name !== "ParameterNotFound") {
      console.error("[SEED_ALLOWLIST] Failed to check parameter:", error);
      throw error;
    }
  }

  console.log("[SEED_ALLOWLIST] Parameter missing; creating:", paramName);

  await ssm.send(
    new PutParameterCommand({
      Name: paramName,
      Value: seedValue,
      Type: "String",
      Overwrite: false,
    })
  );

  return { PhysicalResourceId: paramName };
};
