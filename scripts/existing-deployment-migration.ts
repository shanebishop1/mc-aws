export const LEGACY_RULE_SET_LOGICAL_ID = "MinecraftRuleSet298765D1";
export const LEGACY_ACTIVATION_LOGICAL_ID = "ActivateRuleSet3E62562C";
export const INSTANCE_LOGICAL_ID = "MinecraftServerACE914F3";

export function isStableMigrationStackStatus(status: unknown): boolean {
  return status === "CREATE_COMPLETE" || status === "UPDATE_COMPLETE" || status === "UPDATE_ROLLBACK_COMPLETE";
}

export const ownershipTagsForStack = (stackName: string) => ({
  McAwsProject: "mc-aws",
  McAwsStack: stackName,
  McAwsManagedRoot: "true",
});

// biome-ignore lint/suspicious/noExplicitAny: AWS CLI fixture/template shapes are intentionally open JSON documents.
type JsonRecord = Record<string, any>;

export interface CloudFormationTemplate extends JsonRecord {
  Resources: Record<string, JsonRecord>;
  Parameters?: Record<string, JsonRecord>;
}

export interface PinnedInstanceTemplate {
  template: CloudFormationTemplate;
  parameterOverrides: Record<string, string>;
  imageParameterName?: string;
}

export interface StackIdentity {
  accountId: string;
  region: string;
  stackId: string;
  stackName: string;
}

export interface OwnershipInspection {
  instanceId: string;
  imageId: string;
  rootDeviceName: string;
  rootVolumeId: string;
  missingInstanceTags: string[];
  missingVolumeTags: string[];
}

export interface OwnershipTagOperations {
  inspect: () => OwnershipInspection;
  createTags: (resourceId: string, tags: Record<string, string>) => void;
  deleteTags: (resourceId: string, tags: Record<string, string>) => void;
}

export interface CloudAssemblyIdentityDocuments {
  manifest: JsonRecord;
  assetManifest: JsonRecord;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const AMI_ID_PATTERN = /^ami-[a-f0-9]{8,17}$/;
const SSM_AMI_PARAMETER_TYPE = "AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>";
const PINNED_AMI_PARAMETER_TYPE = "AWS::EC2::Image::Id";

function exactRecord(value: unknown, context: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} is malformed.`);
  return value as JsonRecord;
}

function accountFromRoleArn(value: unknown, context: string): string {
  if (typeof value !== "string") throw new Error(`${context} has no publishing role ARN.`);
  const match = /^arn:(?:\$\{AWS::Partition\}|aws(?:-[a-z]+)?):iam::(\d{12}):role\/.+$/.exec(value);
  if (!match) throw new Error(`${context} has a malformed publishing role ARN.`);
  return match[1];
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: assembly identity validation is intentionally centralized and fail-closed.
export function assertSynthesizedAssemblyIdentity(
  identity: StackIdentity,
  documents: CloudAssemblyIdentityDocuments
): void {
  const artifacts = exactRecord(documents.manifest.artifacts, "Cloud assembly artifacts");
  const stackArtifact = exactRecord(artifacts.MinecraftStack, "MinecraftStack cloud assembly artifact");
  if (stackArtifact.type !== "aws:cloudformation:stack") {
    throw new Error("MinecraftStack cloud assembly artifact has an unexpected type.");
  }
  if (stackArtifact.environment !== `aws://${identity.accountId}/${identity.region}`) {
    throw new Error("Synthesized MinecraftStack environment does not match the confirmed stack identity.");
  }

  const assetArtifact = exactRecord(artifacts["MinecraftStack.assets"], "MinecraftStack asset artifact");
  if (assetArtifact.type !== "cdk:asset-manifest" || assetArtifact.properties?.file !== "MinecraftStack.assets.json") {
    throw new Error("MinecraftStack asset artifact does not reference the expected asset manifest.");
  }

  const stackProperties = exactRecord(stackArtifact.properties, "MinecraftStack artifact properties");
  const templateAssetUrl = stackProperties.stackTemplateAssetObjectUrl;
  const bucketMatch = typeof templateAssetUrl === "string" ? /^s3:\/\/([^/]+)\/.+$/.exec(templateAssetUrl) : null;
  if (!bucketMatch) throw new Error("MinecraftStack template asset bucket identity is malformed.");
  const expectedBucket = bucketMatch[1];
  const escapedAccount = identity.accountId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedRegion = identity.region.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^cdk-[a-z0-9-]+-assets-${escapedAccount}-${escapedRegion}$`).test(expectedBucket)) {
    throw new Error("MinecraftStack template asset bucket does not encode the confirmed account and region.");
  }

  let destinationCount = 0;
  for (const [assetKind, assets] of [
    ["file", exactRecord(documents.assetManifest.files, "File assets")],
    ["docker image", exactRecord(documents.assetManifest.dockerImages, "Docker image assets")],
  ] as const) {
    for (const [assetId, assetValue] of Object.entries(assets)) {
      const asset = exactRecord(assetValue, `${assetKind} asset ${assetId}`);
      const destinations = exactRecord(asset.destinations, `${assetKind} asset ${assetId} destinations`);
      if (!Object.keys(destinations).length) throw new Error(`${assetKind} asset ${assetId} has no destination.`);
      for (const [destinationId, destinationValue] of Object.entries(destinations)) {
        destinationCount += 1;
        const context = `${assetKind} asset ${assetId} destination ${destinationId}`;
        const destination = exactRecord(destinationValue, context);
        if (destination.region !== identity.region) throw new Error(`${context} targets an unexpected region.`);
        if (accountFromRoleArn(destination.assumeRoleArn, context) !== identity.accountId) {
          throw new Error(`${context} targets an unexpected account.`);
        }
        if (assetKind === "file" && destination.bucketName !== expectedBucket) {
          throw new Error(`${context} targets an unexpected asset bucket.`);
        }
      }
    }
  }
  if (!destinationCount) throw new Error("MinecraftStack asset manifest contains no publish destinations.");
}

export function assertExclusiveTaggingAcknowledged(
  stage: string,
  execute: boolean,
  confirmedExclusiveTagging: boolean
): void {
  if (stage === "tags" && execute && !confirmedExclusiveTagging) {
    throw new Error(
      "Tagging refused. Pass --confirm-exclusive-tagging only after pausing every other stack, EC2 lifecycle, and tag writer for the duration of this stage."
    );
  }
}

export function normalizePnpmArguments(arguments_: string[]): string[] {
  return arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
}

function resource(template: CloudFormationTemplate, logicalId: string, expectedType: string): JsonRecord {
  const candidate = template.Resources?.[logicalId];
  if (!candidate || candidate.Type !== expectedType) {
    throw new Error(`Expected ${logicalId} to be a managed ${expectedType} resource.`);
  }
  return candidate;
}

function assertRetainOrDeletePolicy(candidate: JsonRecord, logicalId: string): void {
  for (const policyName of ["DeletionPolicy", "UpdateReplacePolicy"]) {
    const value = candidate[policyName];
    if (value !== undefined && value !== "Delete" && value !== "Retain") {
      throw new Error(`${logicalId} has unexpected ${policyName}=${JSON.stringify(value)}; refusing to rewrite it.`);
    }
  }
}

export function buildLegacyRetentionTemplate(liveTemplate: CloudFormationTemplate): CloudFormationTemplate {
  const retained = clone(liveTemplate);
  const ruleSet = resource(retained, LEGACY_RULE_SET_LOGICAL_ID, "AWS::SES::ReceiptRuleSet");
  const activation = resource(retained, LEGACY_ACTIVATION_LOGICAL_ID, "Custom::AWS");

  for (const [logicalId, candidate] of [
    [LEGACY_RULE_SET_LOGICAL_ID, ruleSet],
    [LEGACY_ACTIVATION_LOGICAL_ID, activation],
  ] as const) {
    assertRetainOrDeletePolicy(candidate, logicalId);
    candidate.DeletionPolicy = "Retain";
    candidate.UpdateReplacePolicy = "Retain";
  }

  return retained;
}

export function assertLegacyResourcesRetained(template: CloudFormationTemplate): void {
  for (const [logicalId, type] of [
    [LEGACY_RULE_SET_LOGICAL_ID, "AWS::SES::ReceiptRuleSet"],
    [LEGACY_ACTIVATION_LOGICAL_ID, "Custom::AWS"],
  ] as const) {
    const candidate = resource(template, logicalId, type);
    if (candidate.DeletionPolicy !== "Retain" || candidate.UpdateReplacePolicy !== "Retain") {
      throw new Error(`${logicalId} is not protected by both Retain policies.`);
    }
  }
}

export function legacyResourcesPresentAndRetained(template: CloudFormationTemplate): boolean {
  const ruleSetPresent = Boolean(template.Resources[LEGACY_RULE_SET_LOGICAL_ID]);
  const activationPresent = Boolean(template.Resources[LEGACY_ACTIVATION_LOGICAL_ID]);
  if (ruleSetPresent !== activationPresent) {
    throw new Error("Only one legacy SES resource remains managed; refusing an ambiguous migration state.");
  }
  if (ruleSetPresent) assertLegacyResourcesRetained(template);
  return ruleSetPresent;
}

function exactInstanceUserDataString(template: CloudFormationTemplate): string {
  const instance = resource(template, INSTANCE_LOGICAL_ID, "AWS::EC2::Instance");
  const properties = exactRecord(instance.Properties, `${INSTANCE_LOGICAL_ID} properties`);
  const userData = properties.UserData;
  if (
    !userData ||
    typeof userData !== "object" ||
    Array.isArray(userData) ||
    Object.keys(userData).length !== 1 ||
    typeof userData["Fn::Base64"] !== "string"
  ) {
    throw new Error(`${INSTANCE_LOGICAL_ID} UserData must be exactly one literal Fn::Base64 string.`);
  }
  return userData["Fn::Base64"];
}

function exactUtf8UserData(actualUserData: Uint8Array): string {
  if (!(actualUserData instanceof Uint8Array) || actualUserData.byteLength === 0) {
    throw new Error("Actual EC2 UserData must be nonempty decoded bytes.");
  }
  const bytes = Buffer.from(actualUserData.buffer, actualUserData.byteOffset, actualUserData.byteLength);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("Actual EC2 UserData is not valid UTF-8.");
  }
  if (!Buffer.from(decoded, "utf8").equals(bytes)) {
    throw new Error("Actual EC2 UserData does not round-trip through a literal UTF-8 Fn::Base64 string.");
  }
  return decoded;
}

export function decodeInstanceUserDataAttribute(expectedInstanceId: string, response: unknown): Buffer {
  if (!/^i-[a-f0-9]{8,17}$/.test(expectedInstanceId)) throw new Error("Expected EC2 instance ID is malformed.");
  const attribute = exactRecord(response, "EC2 UserData attribute response");
  if (attribute.InstanceId !== expectedInstanceId) {
    throw new Error("EC2 UserData attribute response does not match the ownership-proven instance.");
  }
  const userData = exactRecord(attribute.UserData, "EC2 UserData attribute");
  const encoded = userData.Value;
  if (
    typeof encoded !== "string" ||
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new Error("EC2 UserData attribute is not nonempty canonical base64.");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== encoded) {
    throw new Error("EC2 UserData attribute does not round-trip as canonical base64.");
  }
  return decoded;
}

export function adoptActualInstanceUserData(
  liveTemplate: CloudFormationTemplate,
  actualUserData: Uint8Array
): CloudFormationTemplate {
  exactInstanceUserDataString(liveTemplate);
  const actual = exactUtf8UserData(actualUserData);
  const adopted = clone(liveTemplate);
  adopted.Resources[INSTANCE_LOGICAL_ID].Properties.UserData["Fn::Base64"] = actual;
  return adopted;
}

function isCloudFormationUserDataRepresentation(candidate: string, physical: string): boolean {
  if (candidate === physical) return true;
  const candidateCodePoints = [...candidate];
  const physicalCodePoints = [...physical];
  if (candidateCodePoints.length !== physicalCodePoints.length) return false;

  let replacedNonAscii = 0;
  for (let index = 0; index < physicalCodePoints.length; index += 1) {
    const physicalCodePoint = physicalCodePoints[index];
    const candidateCodePoint = candidateCodePoints[index];
    if ((physicalCodePoint.codePointAt(0) ?? 0) <= 0x7f) {
      if (candidateCodePoint !== physicalCodePoint) return false;
      continue;
    }
    if (candidateCodePoint !== "?") return false;
    replacedNonAscii += 1;
  }
  return replacedNonAscii > 0;
}

export function assertInstanceUserDataTransition(
  expectedTemplate: CloudFormationTemplate,
  candidateTemplate: CloudFormationTemplate,
  actualUserData: Uint8Array
): void {
  const actual = exactUtf8UserData(actualUserData);
  const expected = exactInstanceUserDataString(expectedTemplate);
  const candidate = exactInstanceUserDataString(candidateTemplate);
  if (
    !isCloudFormationUserDataRepresentation(expected, actual) ||
    !isCloudFormationUserDataRepresentation(candidate, actual)
  ) {
    throw new Error(
      `Template UserData is neither the exact physical UTF-8 text nor its complete CloudFormation non-ASCII question-mark representation (physicalCodePoints=${[...actual].length}, expectedCodePoints=${[...expected].length}, candidateCodePoints=${[...candidate].length}).`
    );
  }
}

function deployedParameter(
  deployedParameters: JsonRecord[],
  parameterName: string
): { ParameterKey: string; ParameterValue: string; ResolvedValue?: string; UsePreviousValue?: boolean } {
  const matches = deployedParameters.filter((parameter) => parameter?.ParameterKey === parameterName);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one deployed value for ImageId parameter ${parameterName}.`);
  }
  const match = matches[0];
  if (typeof match.ParameterValue !== "string" || !match.ParameterValue) {
    throw new Error(`Deployed ImageId parameter ${parameterName} has a malformed ParameterValue.`);
  }
  if (match.ResolvedValue !== undefined && typeof match.ResolvedValue !== "string") {
    throw new Error(`Deployed ImageId parameter ${parameterName} has a malformed ResolvedValue.`);
  }
  if (match.UsePreviousValue !== undefined && typeof match.UsePreviousValue !== "boolean") {
    throw new Error(`Deployed ImageId parameter ${parameterName} has malformed UsePreviousValue semantics.`);
  }
  return match as {
    ParameterKey: string;
    ParameterValue: string;
    ResolvedValue?: string;
    UsePreviousValue?: boolean;
  };
}

interface ParameterUsage {
  directRefs: number;
  subInterpolations: number;
}

function countSubInterpolations(value: unknown, parameterName: string): number {
  const template = typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
  if (typeof template !== "string") return 0;
  let count = 0;
  for (const match of template.matchAll(/\$\{(!?)([^}]+)\}/g)) {
    if (match[1] !== "!" && match[2] === parameterName) count += 1;
  }
  return count;
}

function countParameterUsage(value: unknown, parameterName: string): ParameterUsage {
  if (!value || typeof value !== "object") return { directRefs: 0, subInterpolations: 0 };
  if (Array.isArray(value)) {
    return value.reduce<ParameterUsage>(
      (usage, item) => {
        const nested = countParameterUsage(item, parameterName);
        return {
          directRefs: usage.directRefs + nested.directRefs,
          subInterpolations: usage.subInterpolations + nested.subInterpolations,
        };
      },
      { directRefs: 0, subInterpolations: 0 }
    );
  }
  const record = value as JsonRecord;
  const nested = countParameterUsage(Object.values(record), parameterName);
  return {
    directRefs: (record.Ref === parameterName ? 1 : 0) + nested.directRefs,
    subInterpolations:
      (Object.hasOwn(record, "Fn::Sub") ? countSubInterpolations(record["Fn::Sub"], parameterName) : 0) +
      nested.subInterpolations,
  };
}

function assertExclusiveImageParameterRef(template: CloudFormationTemplate, parameterName: string): void {
  const scannedTemplate = clone(template);
  if (scannedTemplate.Parameters) delete scannedTemplate.Parameters[parameterName];
  const usage = countParameterUsage(scannedTemplate, parameterName);
  if (usage.directRefs !== 1 || usage.subInterpolations !== 0) {
    throw new Error(
      `ImageId parameter ${parameterName} must be used only by the deployed instance ImageId; found ${usage.directRefs} direct Ref(s) and ${usage.subInterpolations} Fn::Sub interpolation(s) across the template.`
    );
  }
}

function exactImageParameterName(imageId: unknown): string {
  const imageReference = exactRecord(imageId, `${INSTANCE_LOGICAL_ID} ImageId`);
  const parameterName = imageReference.Ref;
  if (
    Object.keys(imageReference).length !== 1 ||
    typeof parameterName !== "string" ||
    !/^[A-Za-z][A-Za-z0-9]*$/.test(parameterName)
  ) {
    throw new Error(`${INSTANCE_LOGICAL_ID} ImageId must be a literal AMI or one exact parameter Ref.`);
  }
  return parameterName;
}

function pinImageParameterDefinition(
  liveTemplate: CloudFormationTemplate,
  pinnedTemplate: CloudFormationTemplate,
  parameterName: string,
  deployed: { ParameterValue: string; ResolvedValue?: string },
  physicalImageId: string
): void {
  const definition = exactRecord(liveTemplate.Parameters?.[parameterName], `ImageId parameter ${parameterName}`);
  const pinnedDefinition = pinnedTemplate.Parameters?.[parameterName];
  if (!pinnedDefinition) throw new Error(`ImageId parameter ${parameterName} disappeared while pinning.`);
  assertExclusiveImageParameterRef(liveTemplate, parameterName);

  if (definition.Type === SSM_AMI_PARAMETER_TYPE) {
    if (!AMI_ID_PATTERN.test(deployed.ResolvedValue ?? "") || deployed.ResolvedValue !== physicalImageId) {
      throw new Error(
        `ResolvedValue for dynamic ImageId parameter ${parameterName} does not exactly match the physical instance AMI.`
      );
    }
    pinnedDefinition.Type = PINNED_AMI_PARAMETER_TYPE;
    if (Object.hasOwn(pinnedDefinition, "Default")) pinnedDefinition.Default = physicalImageId;
    return;
  }

  if (definition.Type !== PINNED_AMI_PARAMETER_TYPE) {
    throw new Error(
      `ImageId parameter ${parameterName} has unsupported type ${JSON.stringify(definition.Type)}; refusing to reinterpret it.`
    );
  }
  if (!AMI_ID_PATTERN.test(deployed.ParameterValue) || deployed.ParameterValue !== physicalImageId) {
    throw new Error(
      `ParameterValue for pinned ImageId parameter ${parameterName} does not exactly match the physical instance AMI.`
    );
  }
  if (deployed.ResolvedValue !== undefined && deployed.ResolvedValue !== physicalImageId) {
    throw new Error(
      `ResolvedValue for pinned ImageId parameter ${parameterName} does not exactly match the physical instance AMI.`
    );
  }
  if (Object.hasOwn(pinnedDefinition, "Default")) pinnedDefinition.Default = physicalImageId;
}

export function pinDeployedInstanceImage(
  liveTemplate: CloudFormationTemplate,
  deployedParameters: JsonRecord[],
  physicalImageId: string
): PinnedInstanceTemplate {
  if (!AMI_ID_PATTERN.test(physicalImageId)) throw new Error("Physical instance ImageId is malformed.");
  const liveInstance = resource(liveTemplate, INSTANCE_LOGICAL_ID, "AWS::EC2::Instance");
  const properties = exactRecord(liveInstance.Properties, `${INSTANCE_LOGICAL_ID} properties`);
  const imageId = properties.ImageId;

  if (typeof imageId === "string") {
    if (!AMI_ID_PATTERN.test(imageId) || imageId !== physicalImageId) {
      throw new Error("Literal deployed instance ImageId does not exactly match the physical instance AMI.");
    }
    return { template: clone(liveTemplate), parameterOverrides: {} };
  }

  const parameterName = exactImageParameterName(imageId);
  if (!liveTemplate.Parameters?.[parameterName]) {
    throw new Error(`ImageId Ref ${parameterName} does not resolve to one template parameter definition.`);
  }
  const deployed = deployedParameter(deployedParameters, parameterName);
  const pinned = clone(liveTemplate);
  pinImageParameterDefinition(liveTemplate, pinned, parameterName, deployed, physicalImageId);

  const pinnedInstance = resource(pinned, INSTANCE_LOGICAL_ID, "AWS::EC2::Instance");
  if (!templatesEqual(liveInstance, pinnedInstance) || !templatesEqual(imageId, pinnedInstance.Properties.ImageId)) {
    throw new Error("Pinning the ImageId parameter unexpectedly changed the deployed EC2 resource expression.");
  }
  return {
    template: pinned,
    parameterOverrides: { [parameterName]: physicalImageId },
    imageParameterName: parameterName,
  };
}

export function isRetentionStageComplete(
  liveTemplate: CloudFormationTemplate,
  deployedParameters: JsonRecord[],
  physicalImageId: string,
  actualUserData: Uint8Array
): boolean {
  const retained = buildLegacyRetentionTemplate(liveTemplate);
  if (!templatesEqual(retained, liveTemplate)) return false;

  const pinned = pinDeployedInstanceImage(liveTemplate, deployedParameters, physicalImageId);
  if (!templatesEqual(pinned.template, liveTemplate)) return false;

  try {
    assertInstanceUserDataTransition(liveTemplate, liveTemplate, actualUserData);
  } catch {
    return false;
  }
  return true;
}

export function buildRetentionStageTemplate(
  liveTemplate: CloudFormationTemplate,
  deployedParameters: JsonRecord[],
  physicalImageId: string,
  actualUserData: Uint8Array
): PinnedInstanceTemplate {
  const retained = buildLegacyRetentionTemplate(liveTemplate);
  const pinned = pinDeployedInstanceImage(retained, deployedParameters, physicalImageId);
  return {
    ...pinned,
    template: adoptActualInstanceUserData(pinned.template, actualUserData),
  };
}

export function assertPinnedInstanceImageTransition(
  liveTemplate: CloudFormationTemplate,
  candidateTemplate: CloudFormationTemplate,
  candidateParameters: JsonRecord[],
  physicalImageId: string,
  requireExplicitParameterValue = false
): PinnedInstanceTemplate {
  const pinned = pinDeployedInstanceImage(candidateTemplate, candidateParameters, physicalImageId);
  if (!templatesEqual(pinned.template, candidateTemplate)) {
    throw new Error("Candidate template does not already contain the exact pinned ImageId parameter definition.");
  }
  const liveInstance = resource(liveTemplate, INSTANCE_LOGICAL_ID, "AWS::EC2::Instance");
  const candidateInstance = resource(candidateTemplate, INSTANCE_LOGICAL_ID, "AWS::EC2::Instance");
  if (!templatesEqual(liveInstance.Properties.ImageId, candidateInstance.Properties.ImageId)) {
    throw new Error("Candidate template changed the deployed EC2 ImageId expression.");
  }
  if (requireExplicitParameterValue && pinned.imageParameterName) {
    const parameter = deployedParameter(candidateParameters, pinned.imageParameterName);
    if (parameter.UsePreviousValue === true || parameter.ParameterValue !== physicalImageId) {
      throw new Error("Candidate ImageId parameter does not explicitly supply the exact physical AMI.");
    }
  }
  return pinned;
}

export function buildPinnedInstanceBridgeTemplate(
  liveTemplate: CloudFormationTemplate,
  currentTemplate: CloudFormationTemplate,
  deployedParameters: JsonRecord[],
  physicalImageId: string,
  actualUserData: Uint8Array
): PinnedInstanceTemplate {
  const adoptedLive = adoptActualInstanceUserData(liveTemplate, actualUserData);
  legacyResourcesPresentAndRetained(adoptedLive);
  const pinnedLive = pinDeployedInstanceImage(adoptedLive, deployedParameters, physicalImageId);
  const liveInstance = resource(pinnedLive.template, INSTANCE_LOGICAL_ID, "AWS::EC2::Instance");
  resource(currentTemplate, INSTANCE_LOGICAL_ID, "AWS::EC2::Instance");

  for (const legacyId of [LEGACY_RULE_SET_LOGICAL_ID, LEGACY_ACTIVATION_LOGICAL_ID]) {
    if (currentTemplate.Resources[legacyId]) {
      throw new Error(`Current template still contains legacy resource ${legacyId}; refusing bridge creation.`);
    }
  }

  const bridge = clone(currentTemplate);
  bridge.Resources[INSTANCE_LOGICAL_ID] = clone(liveInstance);
  for (const parameterName of Object.keys(pinnedLive.parameterOverrides)) {
    const definition = pinnedLive.template.Parameters?.[parameterName];
    if (!definition) throw new Error(`Pinned ImageId parameter ${parameterName} has no template definition.`);
    bridge.Parameters ??= {};
    bridge.Parameters[parameterName] = clone(definition);
    assertExclusiveImageParameterRef(bridge, parameterName);
  }
  if (!templatesEqual(liveInstance, bridge.Resources[INSTANCE_LOGICAL_ID])) {
    throw new Error("Bridge creation unexpectedly changed the deployed EC2 resource expression.");
  }
  return { template: bridge, parameterOverrides: pinnedLive.parameterOverrides };
}

export function templateParameterNames(template: CloudFormationTemplate): string[] {
  return Object.keys(template.Parameters ?? {}).sort();
}

export function buildChangeSetParameters(
  template: CloudFormationTemplate,
  liveTemplate: CloudFormationTemplate,
  parameterOverrides: Record<string, string> = {},
  environment: Record<string, string | undefined> = process.env
): JsonRecord[] {
  const templateNames = templateParameterNames(template);
  const templateNameSet = new Set(templateNames);
  for (const [name, value] of Object.entries(parameterOverrides)) {
    if (!templateNameSet.has(name) || typeof value !== "string" || !value) {
      throw new Error(`Change-set parameter override ${name} is unknown or malformed.`);
    }
  }

  const liveNames = new Set(templateParameterNames(liveTemplate));
  const parameters: JsonRecord[] = [];
  for (const name of templateNames) {
    const override = parameterOverrides[name];
    if (override !== undefined) {
      parameters.push({ ParameterKey: name, ParameterValue: override });
      continue;
    }
    if (liveNames.has(name)) {
      parameters.push({ ParameterKey: name, UsePreviousValue: true });
      continue;
    }
    const definition = template.Parameters?.[name];
    if (definition && Object.hasOwn(definition, "Default")) continue;
    const envName = `MC_AWS_MIGRATION_PARAMETER_${name}`;
    const value = environment[envName];
    if (value === undefined) throw new Error(`New required parameter ${name} needs environment variable ${envName}.`);
    parameters.push({ ParameterKey: name, ParameterValue: value });
  }
  return parameters;
}

function tagsByKey(tags: Array<{ Key?: string; Value?: string }> | undefined, context: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const tag of tags ?? []) {
    if (!tag.Key || tag.Value === undefined) continue;
    if (result.has(tag.Key)) throw new Error(`${context} has duplicate tag ${tag.Key}.`);
    result.set(tag.Key, tag.Value);
  }
  return result;
}

function inspectOwnershipTags(tags: Map<string, string>, context: string, stackName: string): string[] {
  const missing: string[] = [];
  for (const [key, expected] of Object.entries(ownershipTagsForStack(stackName))) {
    const actual = tags.get(key);
    if (actual === undefined) missing.push(key);
    else if (actual !== expected) {
      throw new Error(`${context} has conflicting ownership tag ${key}=${JSON.stringify(actual)}.`);
    }
  }
  return missing;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: identity validation is intentionally centralized and fail-closed.
export function inspectInstanceAndRootVolume(
  identity: StackIdentity,
  expectedPhysicalInstanceId: string,
  describeInstances: JsonRecord,
  describeVolumes: JsonRecord
): OwnershipInspection {
  const instances = (describeInstances.Reservations ?? []).flatMap(
    (reservation: JsonRecord) => reservation.Instances ?? []
  );
  if (instances.length !== 1) throw new Error(`Expected exactly one EC2 instance, found ${instances.length}.`);
  const instance = instances[0];
  if (instance.InstanceId !== expectedPhysicalInstanceId)
    throw new Error("EC2 instance identity changed during inspection.");
  if (!/^ami-[a-f0-9]{8,17}$/.test(instance.ImageId ?? "")) throw new Error("Instance has a malformed ImageId.");

  const instanceTags = tagsByKey(instance.Tags, `Instance ${expectedPhysicalInstanceId}`);
  const requiredCloudFormationTags = {
    "aws:cloudformation:stack-id": identity.stackId,
    "aws:cloudformation:stack-name": identity.stackName,
    "aws:cloudformation:logical-id": INSTANCE_LOGICAL_ID,
  };
  for (const [key, expected] of Object.entries(requiredCloudFormationTags)) {
    if (instanceTags.get(key) !== expected) {
      throw new Error(`Instance ${expectedPhysicalInstanceId} does not have exact CloudFormation identity tag ${key}.`);
    }
  }

  const rootDeviceName = instance.RootDeviceName;
  if (typeof rootDeviceName !== "string" || !rootDeviceName) throw new Error("Instance has no root device name.");
  const rootMappings = (instance.BlockDeviceMappings ?? []).filter(
    (mapping: JsonRecord) => mapping.DeviceName === rootDeviceName && mapping.Ebs?.VolumeId
  );
  if (rootMappings.length !== 1) throw new Error("Instance does not have exactly one EBS root mapping.");
  const rootMapping = rootMappings[0];
  if (rootMapping.Ebs.DeleteOnTermination !== true) {
    throw new Error("Legacy root mapping no longer has DeleteOnTermination=true; investigate before migration.");
  }
  const rootVolumeId = rootMapping.Ebs.VolumeId;

  const volumes = describeVolumes.Volumes ?? [];
  if (volumes.length !== 1 || volumes[0].VolumeId !== rootVolumeId) {
    throw new Error("Root volume identity changed during inspection.");
  }
  const volume = volumes[0];
  const matchingAttachments = (volume.Attachments ?? []).filter(
    (attachment: JsonRecord) =>
      attachment.InstanceId === expectedPhysicalInstanceId &&
      attachment.Device === rootDeviceName &&
      attachment.State === "attached"
  );
  if (volume.State !== "in-use" || matchingAttachments.length !== 1 || (volume.Attachments ?? []).length !== 1) {
    throw new Error(`Volume ${rootVolumeId} is not uniquely attached as the inspected instance root volume.`);
  }

  return {
    instanceId: expectedPhysicalInstanceId,
    imageId: instance.ImageId,
    rootDeviceName,
    rootVolumeId,
    missingInstanceTags: inspectOwnershipTags(
      instanceTags,
      `Instance ${expectedPhysicalInstanceId}`,
      identity.stackName
    ),
    missingVolumeTags: inspectOwnershipTags(
      tagsByKey(volume.Tags, `Volume ${rootVolumeId}`),
      `Volume ${rootVolumeId}`,
      identity.stackName
    ),
  };
}

export function assertOwnershipTagsComplete(inspection: OwnershipInspection): void {
  if (inspection.missingInstanceTags.length || inspection.missingVolumeTags.length) {
    throw new Error("Exact McAws ownership tags have not been established on both the instance and root volume.");
  }
}

function assertOwnershipIdentityUnchanged(
  expected: OwnershipInspection,
  actual: OwnershipInspection,
  context: string
): void {
  if (actual.instanceId !== expected.instanceId || actual.rootVolumeId !== expected.rootVolumeId) {
    throw new Error(`${context}: instance or root volume identity changed.`);
  }
}

function selectedOwnershipTags(stackName: string, keys: string[]): Record<string, string> {
  const expected = ownershipTagsForStack(stackName);
  return Object.fromEntries(
    keys.map((key) => {
      if (!Object.hasOwn(expected, key)) throw new Error(`Unexpected ownership tag key ${JSON.stringify(key)}.`);
      return [key, expected[key as keyof typeof expected]];
    })
  );
}

export function establishOwnershipTags(
  stackName: string,
  initial: OwnershipInspection,
  operations: OwnershipTagOperations
): OwnershipInspection {
  let addedVolumeTags: Record<string, string> = {};
  let addedInstanceTags: Record<string, string> = {};
  try {
    const beforeVolumeWrite = operations.inspect();
    assertOwnershipIdentityUnchanged(initial, beforeVolumeWrite, "Before root-volume tagging");
    addedVolumeTags = selectedOwnershipTags(stackName, beforeVolumeWrite.missingVolumeTags);
    if (Object.keys(addedVolumeTags).length) {
      operations.createTags(initial.rootVolumeId, addedVolumeTags);
    }

    const afterVolumeWrite = operations.inspect();
    assertOwnershipIdentityUnchanged(initial, afterVolumeWrite, "After root-volume tagging");
    if (afterVolumeWrite.missingVolumeTags.length) {
      throw new Error("Root-volume ownership tags were not established after the write.");
    }

    const beforeInstanceWrite = operations.inspect();
    assertOwnershipIdentityUnchanged(initial, beforeInstanceWrite, "Before instance tagging");
    if (beforeInstanceWrite.missingVolumeTags.length) {
      throw new Error("Root-volume ownership tags changed before instance tagging.");
    }
    addedInstanceTags = selectedOwnershipTags(stackName, beforeInstanceWrite.missingInstanceTags);
    if (Object.keys(addedInstanceTags).length) {
      operations.createTags(initial.instanceId, addedInstanceTags);
    }

    const after = operations.inspect();
    assertOwnershipIdentityUnchanged(initial, after, "After instance tagging");
    assertOwnershipTagsComplete(after);
    return after;
  } catch (error) {
    const cleanupErrors: string[] = [];
    for (const [resourceId, tags] of [
      [initial.instanceId, addedInstanceTags],
      [initial.rootVolumeId, addedVolumeTags],
    ] as const) {
      if (!Object.keys(tags).length) continue;
      try {
        operations.deleteTags(resourceId, tags);
      } catch (cleanupError) {
        cleanupErrors.push(`${resourceId}: ${(cleanupError as Error).message}`);
      }
    }
    const cleanupSuffix = cleanupErrors.length
      ? ` CRITICAL: cleanup of invocation-added tags also failed (${cleanupErrors.join("; ")}).`
      : " Invocation-added tags were removed.";
    throw new Error(`${(error as Error).message}${cleanupSuffix}`);
  }
}

export function assertSafeBridgeChangeSet(changes: JsonRecord[], legacyResourcesManaged = true): void {
  const instanceChange = changes.find((change) => change.ResourceChange?.LogicalResourceId === INSTANCE_LOGICAL_ID);
  if (instanceChange) {
    const details = instanceChange.ResourceChange;
    throw new Error(
      `Bridge change set touches ${INSTANCE_LOGICAL_ID} (${details.Action}, replacement=${details.Replacement ?? "n/a"}).`
    );
  }

  for (const legacyId of legacyResourcesManaged ? [LEGACY_RULE_SET_LOGICAL_ID, LEGACY_ACTIVATION_LOGICAL_ID] : []) {
    const matching = changes.filter((change) => change.ResourceChange?.LogicalResourceId === legacyId);
    if (matching.length !== 1 || matching[0].ResourceChange.Action !== "Remove") {
      throw new Error(`Bridge change set must contain exactly one Remove action for ${legacyId}.`);
    }
    const policyAction = matching[0].ResourceChange.PolicyAction;
    if (policyAction !== undefined && policyAction !== "Retain") {
      throw new Error(`Bridge removal for ${legacyId} has effective PolicyAction=${JSON.stringify(policyAction)}.`);
    }
  }
}

export function assertSafeRetentionChangeSet(changes: JsonRecord[]): void {
  const allowedLogicalIds = new Set([LEGACY_RULE_SET_LOGICAL_ID, LEGACY_ACTIVATION_LOGICAL_ID]);
  for (const change of changes) {
    const details = change.ResourceChange;
    if (!details || !allowedLogicalIds.has(details.LogicalResourceId)) {
      const changeDetails = (details?.Details ?? []).map((detail: JsonRecord) => ({
        attribute: detail.Target?.Attribute,
        name: detail.Target?.Name,
        requiresRecreation: detail.Target?.RequiresRecreation,
        evaluation: detail.Evaluation,
        changeSource: detail.ChangeSource,
        beforeAfterEqual:
          detail.Target?.BeforeValue !== undefined && detail.Target.BeforeValue === detail.Target.AfterValue,
        beforeLength: typeof detail.Target?.BeforeValue === "string" ? detail.Target.BeforeValue.length : undefined,
        afterLength: typeof detail.Target?.AfterValue === "string" ? detail.Target.AfterValue.length : undefined,
      }));
      throw new Error(
        `Retention change set unexpectedly touches ${details?.LogicalResourceId ?? "an unknown resource"} ` +
          `(action=${details?.Action ?? "unknown"}, replacement=${details?.Replacement ?? "unknown"}, ` +
          `scope=${JSON.stringify(details?.Scope ?? [])}, details=${JSON.stringify(changeDetails)}).`
      );
    }
    if (details.Action !== "Modify" || (details.Replacement && details.Replacement !== "False")) {
      throw new Error(`Retention change for ${details.LogicalResourceId} is not a non-replacing Modify action.`);
    }
  }
}

export function templatesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function assertStandardDeploymentInstanceSafe(
  liveTemplate: CloudFormationTemplate,
  currentTemplate: CloudFormationTemplate
): void {
  const liveInstance = resource(liveTemplate, INSTANCE_LOGICAL_ID, "AWS::EC2::Instance");
  const currentInstance = resource(currentTemplate, INSTANCE_LOGICAL_ID, "AWS::EC2::Instance");
  const imageId = currentInstance.Properties?.ImageId;
  if (typeof imageId !== "string" || !/^ami-[a-f0-9]{8,17}$/.test(imageId)) {
    throw new Error(
      "Standard deployment blocked: the synthesized EC2 ImageId is dynamic or unpinned, so CloudFormation could re-resolve it and replace the live instance even when the template is unchanged. Use a reviewed pinned-instance bridge or pin the desired AMI explicitly."
    );
  }
  if (!templatesEqual(liveInstance, currentInstance)) {
    throw new Error(
      "Standard deployment blocked: the deployed EC2 resource differs from current CDK and could replace the live root volume. Use the documented bridge for non-instance updates; resolve the instance/data migration explicitly before a normal deploy."
    );
  }
}
