import { AUTH_SECRET_REQUIREMENTS, validateProductionAuthSecret } from "../../lib/auth-secret";

if (!validateProductionAuthSecret(process.env.AUTH_SECRET).valid) {
  console.error(AUTH_SECRET_REQUIREMENTS);
  process.exit(1);
}
