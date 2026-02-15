import { ImageResponse } from "next/og";

export const size = {
  width: 180,
  height: 180,
};

export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        backgroundColor: "#1A4222",
        display: "flex",
        height: "100%",
        justifyContent: "center",
        width: "100%",
        borderRadius: 34,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: 112,
          height: 112,
        }}
      >
        <div
          style={{
            backgroundColor: "#4A7C23",
            height: 56,
          }}
        />
        <div
          style={{
            backgroundColor: "#8B5A2B",
            height: 56,
          }}
        />
      </div>
    </div>,
    {
      ...size,
    }
  );
}
