import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";

/**
 * Scroll-entry for landing sections. One device, used everywhere, so the page
 * has a single reveal rhythm instead of a different animation per section.
 *
 * `once: true` — the page animates as you arrive at a section and then stays
 * put. Re-firing on every scroll-back is the thing that makes marketing pages
 * feel restless. Under `prefers-reduced-motion` the whole thing collapses to
 * static: `initial={false}` skips the enter state entirely rather than playing
 * it faster.
 */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  /** Seconds. Used to stagger siblings; keep under ~0.25 so nothing lags. */
  delay?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={{ duration: 0.55, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}
