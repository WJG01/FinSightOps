// lib/useSimulatedProgress.js
import { useEffect, useRef, useState } from "react";

/**
 * Advances through `stages` on a timer to *simulate* progress while the real
 * async work runs elsewhere (e.g. auditStore). Caps at the second-to-last
 * stage until `isDone` becomes true, then immediately completes everything.
 *
 * @param {Array} stages          - list of stage definitions (just needs .length)
 * @param {boolean} isRunning     - true while the real audit is in flight
 * @param {boolean} isDone        - true once the real audit has finished
 * @param {number} stepMs         - how long each simulated stage "takes"
 */
export function useSimulatedProgress(stages, isRunning, isDone, stepMs = 1800) {
  const [activeIndex, setActiveIndex] = useState(-1); // -1 = nothing started yet
  const intervalRef = useRef(null);

  useEffect(() => {
    if (!isRunning) {
      // Not running and not done (e.g. no run at all) → reset to idle.
      if (!isDone) {
        setActiveIndex(-1);
      }
      return;
    }

    setActiveIndex(0);

    intervalRef.current = setInterval(() => {
      setActiveIndex((prev) => {
        // Never simulate past the second-to-last stage — the LAST stage
        // only lights up for real once isDone flips true (see effect below).
        const cap = stages.length - 2;
        if (prev >= cap) return prev;
        return prev + 1;
      });
    }, stepMs);

    return () => clearInterval(intervalRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning, stages.length, stepMs]);

  // Real completion arrived — snap straight to fully done, cancel simulation.
  useEffect(() => {
    if (isDone) {
      clearInterval(intervalRef.current);
      setActiveIndex(stages.length - 1);
    }
  }, [isDone, stages.length]);

  return activeIndex; // index of the currently "active" stage, -1 if idle
}