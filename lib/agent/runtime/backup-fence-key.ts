import { createPrivateKey, createPublicKey } from "node:crypto";

const MAX_PKCS8_BASE64_LENGTH = 512;

/**
 * Validates the control-plane Ed25519 private key and derives the public PEM
 * that may be provisioned into the credential-less host executor.
 */
export function deriveBackupFencePublicKeyPem(privateKeyPkcs8Base64: string): string {
  const encoded = privateKeyPkcs8Base64.trim();
  if (
    !encoded ||
    encoded.length > MAX_PKCS8_BASE64_LENGTH ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    throw new Error("Backup fence private key must be canonical base64 PKCS#8.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== encoded) {
    throw new Error("Backup fence private key must be canonical base64 PKCS#8.");
  }
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
  } catch {
    throw new Error("Backup fence private key is not valid PKCS#8.");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Backup fence private key must use Ed25519.");
  }
  return createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString();
}
