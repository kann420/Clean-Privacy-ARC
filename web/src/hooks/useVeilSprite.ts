import { useCallback, useEffect, useRef } from "react";

/**
 * Veil, the Clean Privacy mascot. The spritesheet is an 8 x 11 grid; each row is one
 * clip and the playlist is the mock's, unchanged. Ported from the mock's `petRef`.
 */
export const PET_COLS = 8;
export const PET_ROWS = 11;

export const PET_CLIPS = {
  idle: { row: 0, frames: 7, fps: 8 },
  runRight: { row: 1, frames: 8, fps: 13 },
  runLeft: { row: 2, frames: 8, fps: 13 },
  waving: { row: 3, frames: 4, fps: 7 },
  jumping: { row: 4, frames: 5, fps: 9 },
  failed: { row: 5, frames: 8, fps: 8 },
  waiting: { row: 6, frames: 6, fps: 7 },
  running: { row: 7, frames: 6, fps: 12 },
  review: { row: 8, frames: 6, fps: 7 },
  lookA: { row: 9, frames: 8, fps: 9 },
  lookB: { row: 10, frames: 8, fps: 9 },
} as const;

type ClipName = keyof typeof PET_CLIPS;

export const PET_PLAYLIST: readonly [ClipName, number][] = [
  ["idle", 2],
  ["waving", 2],
  ["lookA", 1],
  ["lookB", 1],
  ["idle", 1],
  ["jumping", 2],
  ["runRight", 2],
  ["runLeft", 2],
  ["running", 2],
  ["waiting", 2],
  ["review", 2],
  ["failed", 1],
  ["idle", 2],
];

export function useVeilSprite(): (element: HTMLDivElement | null) => void {
  const element = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      element.current = node;
      stop();
      if (!node) return;

      let step = 0;
      let loop = 0;
      let frame = 0;
      const draw = () => {
        const entry = PET_PLAYLIST[step];
        if (!entry) return;
        const clip = PET_CLIPS[entry[0]];
        if (element.current) {
          element.current.style.backgroundPosition =
            (frame * 100) / (PET_COLS - 1) + "% " + (clip.row * 100) / (PET_ROWS - 1) + "%";
        }
        frame++;
        if (frame >= clip.frames) {
          frame = 0;
          if (++loop >= entry[1]) {
            loop = 0;
            step = (step + 1) % PET_PLAYLIST.length;
          }
        }
        timer.current = window.setTimeout(draw, 1000 / clip.fps);
      };
      draw();
    },
    [stop],
  );

  useEffect(() => stop, [stop]);

  return attach;
}
