import { env } from "@/lib/env";

export type DnsMode = "cloudflare" | "duckdns" | "none";

export interface DnsModeConfig {
  mode: DnsMode;
  hostname?: string;
}

export const resolveDnsModeFromValues = (values: {
  MC_CONNECTION_MODE?: string;
  CLOUDFLARE_MC_DOMAIN?: string;
  CLOUDFLARE_ZONE_ID?: string;
  CLOUDFLARE_DNS_API_TOKEN?: string;
  DUCKDNS_DOMAIN?: string;
  DUCKDNS_TOKEN?: string;
}): DnsModeConfig => {
  if (values.MC_CONNECTION_MODE === "raw_ip") return { mode: "none" };
  if (
    values.MC_CONNECTION_MODE === "cloudflare" &&
    values.CLOUDFLARE_MC_DOMAIN?.trim() &&
    values.CLOUDFLARE_ZONE_ID?.trim() &&
    values.CLOUDFLARE_DNS_API_TOKEN?.trim()
  ) {
    return { mode: "cloudflare", hostname: values.CLOUDFLARE_MC_DOMAIN.trim() };
  }
  if (values.MC_CONNECTION_MODE === "duckdns" && values.DUCKDNS_DOMAIN?.trim() && values.DUCKDNS_TOKEN?.trim()) {
    return { mode: "duckdns", hostname: `${values.DUCKDNS_DOMAIN.trim()}.duckdns.org` };
  }
  const cloudflareDomain = values.CLOUDFLARE_MC_DOMAIN?.trim();
  if (cloudflareDomain && values.CLOUDFLARE_ZONE_ID?.trim() && values.CLOUDFLARE_DNS_API_TOKEN?.trim()) {
    return { mode: "cloudflare", hostname: cloudflareDomain };
  }

  const duckdnsDomain = values.DUCKDNS_DOMAIN?.trim();
  if (duckdnsDomain && values.DUCKDNS_TOKEN?.trim()) {
    return { mode: "duckdns", hostname: `${duckdnsDomain}.duckdns.org` };
  }

  return { mode: "none" };
};

export const resolveDnsMode = (): DnsModeConfig => {
  return resolveDnsModeFromValues({
    MC_CONNECTION_MODE: env.MC_CONNECTION_MODE,
    CLOUDFLARE_MC_DOMAIN: env.CLOUDFLARE_MC_DOMAIN,
    CLOUDFLARE_ZONE_ID: env.CLOUDFLARE_ZONE_ID,
    CLOUDFLARE_DNS_API_TOKEN: env.CLOUDFLARE_DNS_API_TOKEN,
    DUCKDNS_DOMAIN: env.DUCKDNS_DOMAIN,
    DUCKDNS_TOKEN: env.DUCKDNS_TOKEN,
  });
};
