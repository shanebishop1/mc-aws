import { ImageResponse } from "next/og";

export const size = {
  width: 180,
  height: 180,
};

export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "center",
          background: "linear-gradient(135deg, #4a7c59 0%, #2f5a3a 100%)",
          color: "#f8f5ec",
          display: "flex",
          fontSize: 86,
          fontWeight: 800,
          height: "100%",
          justifyContent: "center",
          letterSpacing: -2,
          width: "100%",
        }}
      >
        MC
      </div>
    ),
    {
      ...size,
    },
  );
}
