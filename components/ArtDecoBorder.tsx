"use client";

export const ArtDecoBorder = () => {
  // Rounded scallop edge pattern
  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      {/* Top edge */}
      <svg className="absolute top-0 left-0 w-full h-5" preserveAspectRatio="none">
        <defs>
          <pattern id="scallop-top" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M0,0 Q10,18 20,0 Z" className="fill-green" />
          </pattern>
        </defs>
        <rect width="100%" height="20" fill="url(#scallop-top)" />
      </svg>

      {/* Bottom edge */}
      <svg className="absolute bottom-0 left-0 w-full h-5 rotate-180" preserveAspectRatio="none">
        <rect width="100%" height="20" fill="url(#scallop-top)" />
      </svg>

      {/* Left edge */}
      <svg className="absolute top-0 left-0 h-full w-5" preserveAspectRatio="none">
        <defs>
          <pattern id="scallop-left" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M0,0 Q18,10 0,20 Z" className="fill-green" />
          </pattern>
        </defs>
        <rect width="20" height="100%" fill="url(#scallop-left)" />
      </svg>

      {/* Right edge */}
      <svg className="absolute top-0 right-0 h-full w-5 rotate-180" preserveAspectRatio="none">
        <rect width="20" height="100%" fill="url(#scallop-left)" />
      </svg>
    </div>
  );
};
