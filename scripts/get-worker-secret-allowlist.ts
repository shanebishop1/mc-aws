import { workerSecretAllowlist } from "@/lib/runtime-config-schema";

for (const key of workerSecretAllowlist) {
  console.log(key);
}
