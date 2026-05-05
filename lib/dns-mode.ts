import { env } from "@/lib/env";

export type DnsMode = "cloudflare" | "duckdns" | "none";

export interface DnsModeConfig {
  mode: DnsMode;
  hostname?: string;
}

export const resolveDnsModeFromValues = (values: {
  CLOUDFLARE_MC_DOMAIN?: string;
  DUCKDNS_DOMAIN?: string;
}): DnsModeConfig => {
  const cloudflareDomain = values.CLOUDFLARE_MC_DOMAIN?.trim();
  if (cloudflareDomain) {
    return { mode: "cloudflare", hostname: cloudflareDomain };
  }

  const duckdnsDomain = values.DUCKDNS_DOMAIN?.trim();
  if (duckdnsDomain) {
    return { mode: "duckdns", hostname: `${duckdnsDomain}.duckdns.org` };
  }

  return { mode: "none" };
};

export const resolveDnsMode = (): DnsModeConfig => {
  return resolveDnsModeFromValues({
    CLOUDFLARE_MC_DOMAIN: env.CLOUDFLARE_MC_DOMAIN,
    DUCKDNS_DOMAIN: env.DUCKDNS_DOMAIN,
  });
};
