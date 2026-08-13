// lib/useSimulatedProgress.js
import { useEffect, useRef, useState } from "react";

/**
 * Advances through `stages` on a timer to *simulate* progress while the real
 * async work runs elsewhere (e.g. auditStore).
 *
 * - Caps at the second-to-last stage until isDone becomes true.
 * - Even if isDone flips true almost instantly, the simulator won't snap to
 *   100% until at least `minDurationMs` has elapsed since it started —
 *   this is what prevents the "flash" when the backend finishes very fast.
 *
 * @param {Array} stages          - stage definitions (just needs .length)
 * @param {boolean} isRunning     - true while the real audit is in flight
 * @param {boolean} isDone        - true once the real audit has finished
 * @param {number} stepMs         - how long each simulated stage "takes"
 * @param {number} minDurationMs  - minimum total time the simulator must run
 *                                  before it's allowed to complete
 */
export function useSimulatedProgress(
  stages,
  isRunning,
  isDone,
  stepMs = 1800,
  minDurationMs = 6000, // tune: floor for how long the animation must play
) {
  const [activeIndex, setActiveIndex] = useState(-1);
  const intervalRef = useRef(null);
  const startedAtRef = useRef(null);
  const pendingDoneTimeoutRef = useRef(null);

  useEffect(() => {
    if (!isRunning) {
      if (!isDone) {
        setActiveIndex(-1);
        startedAtRef.current = null;
      }
      return;
    }

    startedAtRef.current = Date.now();
    setActiveIndex(0);

    intervalRef.current = setInterval(() => {
      setActiveIndex((prev) => {
        const cap = stages.length - 2;
        if (prev >= cap) return prev;
        return prev + 1;
      });
    }, stepMs);

    return () => clearInterval(intervalRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning, stages.length, stepMs]);

  useEffect(() => {
    if (!isDone) return;

    const elapsed = startedAtRef.current ? Date.now() - startedAtRef.current : minDurationMs;
    const remaining = Math.max(minDurationMs - elapsed, 0);

    // Wait out whatever's left of the minimum duration before completing,
    // so fast backend responses still show the full animation.
    pendingDoneTimeoutRef.current = setTimeout(() => {
      clearInterval(intervalRef.current);
      setActiveIndex(stages.length - 1);
    }, remaining);

    return () => clearTimeout(pendingDoneTimeoutRef.current);
  }, [isDone, stages.length, minDurationMs]);

  return activeIndex;
}