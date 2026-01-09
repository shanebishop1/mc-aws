"use client";

import { motion } from "framer-motion";

interface PageHeaderProps {
  onOpenCosts: () => void;
  onOpenEmails: () => void;
}

export const PageHeader = ({ onOpenCosts, onOpenEmails }: PageHeaderProps) => {
  return (
    <motion.header
      data-testid="page-header"
      initial={{ y: -20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.8, ease: "easeOut" }}
      className="relative shrink-0 pt-2 pb-1 md:pt-8 md:pb-4 text-center"
    >
      <h1 className="font-serif text-3xl italic tracking-wide text-charcoal">
        mc-aws <span className="not-italic font-bold">Controller</span>
      </h1>

      {/* Header Icons - Below title on mobile, absolute top-right on desktop */}
      <div className="flex justify-center gap-3 mt-2 md:absolute md:top-8 md:right-4 md:mt-0">
        {/* GitHub Button */}
        <motion.a
          href="https://github.com/shanebishop1/mc-aws"
          target="_blank"
          rel="noopener noreferrer"
          whileHover={{ scale: 1.1 }}
          transition={{ duration: 0.1 }}
          whileTap={{ scale: 0.95 }}
          className="cursor-pointer p-1 text-charcoal/40 hover:text-green transition-colors"
          title="View on GitHub"
        >
          <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z"
            />
          </svg>
        </motion.a>

        {/* Costs Button */}
        <motion.button
          onClick={onOpenCosts}
          whileHover={{ scale: 1.1 }}
          transition={{ duration: 0.1 }}
          whileTap={{ scale: 0.95 }}
          className="cursor-pointer p-1 text-charcoal/40 hover:text-green transition-colors"
          title="View AWS costs"
        >
          <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </motion.button>

        {/* Email Management Button */}
        <motion.button
          onClick={onOpenEmails}
          whileHover={{ scale: 1.1 }}
          transition={{ duration: 0.1 }}
          whileTap={{ scale: 0.95 }}
          className="cursor-pointer p-1 text-charcoal/40 hover:text-green transition-colors"
          title="Manage email access"
        >
          <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
            />
          </svg>
        </motion.button>
      </div>
    </motion.header>
  );
};
