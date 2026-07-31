import { useEffect, useRef, useState } from "react";

/**
 * Landing-page counter scramble, ported from the mock's `scramble()`. Digits lock in
 * left to right with a per-column stagger; the hook restarts whenever it becomes active
 * again, which is what the mock did on every navigation back to the landing screen.
 */
export function useStatScramble(active: boolean, targets: readonly string[]): string[] | null {
  const [frames, setFrames] = useState<string[] | null>(null);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  useEffect(() => {
    if (!active) {
      setFrames(null);
      return;
    }
    const DUR = 820;
    const STAGGER = 120;
    const STEP = 50;
    const start = Date.now();
    const list = targetsRef.current;

    const interval = setInterval(() => {
      const elapsed = Date.now() - start;
      if (elapsed >= DUR + STAGGER * (list.length - 1)) {
        clearInterval(interval);
        setFrames(null);
        return;
      }
      setFrames(
        list.map((target, i) => {
          const p = Math.min(1, Math.max(0, (elapsed - i * STAGGER) / DUR));
          const lock = Math.floor(p * p * target.length * 1.25);
          return target
            .split("")
            .map((ch, j) => (j < lock || ch === "." ? ch : String.fromCharCode(48 + ((Math.random() * 10) | 0))))
            .join("");
        }),
      );
    }, STEP);

    const stop = setTimeout(() => {
      clearInterval(interval);
      setFrames(null);
    }, DUR + STAGGER * list.length + 400);

    return () => {
      clearInterval(interval);
      clearTimeout(stop);
    };
  }, [active]);

  return frames;
}
