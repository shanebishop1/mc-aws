"use client";

export const ArtDecoBorder = () => {
  // Rounded scallop edge pattern
  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      {/* Top edge */}
      <svg className="absolute top-0 left-0 w-full h-3" preserveAspectRatio="none">
        <defs>
          <pattern id="scallop-top" width="12" height="12" patternUnits="userSpaceOnUse">
            <path d="M0,0 Q6,10 12,0 Z" className="fill-green" />
          </pattern>
        </defs>
        <rect width="100%" height="12" fill="url(#scallop-top)" />
      </svg>

      {/* Bottom edge */}
      <svg className="absolute bottom-0 left-0 w-full h-3 rotate-180" preserveAspectRatio="none">
        <rect width="100%" height="12" fill="url(#scallop-top)" />
      </svg>

      {/* Left edge */}
      <svg className="absolute top-0 left-0 h-full w-3" preserveAspectRatio="none">
        <defs>
          <pattern id="scallop-left" width="12" height="12" patternUnits="userSpaceOnUse">
            <path d="M0,0 Q10,6 0,12 Z" className="fill-green" />
          </pattern>
        </defs>
        <rect width="12" height="100%" fill="url(#scallop-left)" />
      </svg>

      {/* Right edge */}
      <svg className="absolute top-0 right-0 h-full w-3 rotate-180" preserveAspectRatio="none">
        <rect width="12" height="100%" fill="url(#scallop-left)" />
      </svg>
    </div>
  );
};
