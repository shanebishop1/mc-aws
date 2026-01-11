"use client";

import { useEffect, useMemo, useState } from "react";

const CORNER_SIZE = 20;
const BASE_SCALLOP_SIZE = 20;

export const ArtDecoBorder = () => {
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const updateDimensions = () => {
      setDimensions({ width: window.innerWidth, height: window.innerHeight });
    };

    updateDimensions();

    // ResizeObserver on documentElement for smooth updates
    const resizeObserver = new ResizeObserver(updateDimensions);
    resizeObserver.observe(document.documentElement);

    return () => resizeObserver.disconnect();
  }, []);

  const { width, height } = dimensions;

  // Calculate scallop sizes that fit evenly
  const edgeWidth = width - CORNER_SIZE * 2;
  const edgeHeight = height - CORNER_SIZE * 2;

  const horizontalScallopCount = Math.max(1, Math.round(edgeWidth / BASE_SCALLOP_SIZE));
  const verticalScallopCount = Math.max(1, Math.round(edgeHeight / BASE_SCALLOP_SIZE));

  const hScallop = edgeWidth / horizontalScallopCount;
  const vScallop = edgeHeight / verticalScallopCount;

  // Build a single path for the entire border
  const borderPath = useMemo(() => {
    if (width === 0) return "";

    let d = "";

    // Start at top-left after corner
    d += `M ${CORNER_SIZE},0 `;

    // Top edge scallops (left to right)
    for (let i = 0; i < horizontalScallopCount; i++) {
      const x1 = CORNER_SIZE + i * hScallop;
      const x2 = x1 + hScallop;
      const cpY = CORNER_SIZE * 0.95;
      d += `Q ${x1 + hScallop / 2},${cpY} ${x2},0 `;
    }

    // Top-right corner arc (curves outward into the corner)
    d += `A ${CORNER_SIZE},${CORNER_SIZE} 0 0,0 ${width},${CORNER_SIZE} `;

    // Right edge scallops (top to bottom)
    for (let i = 0; i < verticalScallopCount; i++) {
      const y1 = CORNER_SIZE + i * vScallop;
      const y2 = y1 + vScallop;
      const cpX = width - CORNER_SIZE * 0.95;
      d += `Q ${cpX},${y1 + vScallop / 2} ${width},${y2} `;
    }

    // Bottom-right corner arc
    d += `A ${CORNER_SIZE},${CORNER_SIZE} 0 0,0 ${width - CORNER_SIZE},${height} `;

    // Bottom edge scallops (right to left)
    for (let i = 0; i < horizontalScallopCount; i++) {
      const x1 = width - CORNER_SIZE - i * hScallop;
      const x2 = x1 - hScallop;
      const cpY = height - CORNER_SIZE * 0.95;
      d += `Q ${x1 - hScallop / 2},${cpY} ${x2},${height} `;
    }

    // Bottom-left corner arc
    d += `A ${CORNER_SIZE},${CORNER_SIZE} 0 0,0 0,${height - CORNER_SIZE} `;

    // Left edge scallops (bottom to top)
    for (let i = 0; i < verticalScallopCount; i++) {
      const y1 = height - CORNER_SIZE - i * vScallop;
      const y2 = y1 - vScallop;
      const cpX = CORNER_SIZE * 0.95;
      d += `Q ${cpX},${y1 - vScallop / 2} 0,${y2} `;
    }

    // Top-left corner arc (back to start)
    d += `A ${CORNER_SIZE},${CORNER_SIZE} 0 0,0 ${CORNER_SIZE},0 `;

    d += "Z";

    return d;
  }, [width, height, horizontalScallopCount, verticalScallopCount, hScallop, vScallop]);

  // Don't render until we have dimensions
  if (dimensions.width === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      <svg width={width} height={height} className="absolute inset-0">
        <path
          d={`M 0,0 L ${width},0 L ${width},${height} L 0,${height} Z ${borderPath}`}
          className="fill-green"
          fillRule="evenodd"
        />
      </svg>
    </div>
  );
};
