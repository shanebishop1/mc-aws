import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "mc-aws",
    short_name: "mc-aws",
    description: "Minecraft Server Management Interface",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f5f1e8",
    theme_color: "#f5f1e8",
    icons: [
      {
        src: "/apple-icon",
        sizes: "180x180",
        type: "image/png",
      },
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
  };
}
