import { useCallback, useState } from "react";

/** A boolean UI preference persisted in localStorage (details-rail visibility,
 *  rail-section collapse). Read once on mount; storage failures degrade to
 *  plain in-memory state so private mode never breaks the control. */
export function useLocalFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : raw === "1";
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: boolean) => {
      setValue(v);
      try {
        localStorage.setItem(key, v ? "1" : "0");
      } catch {
        /* storage unavailable — keep the in-memory value */
      }
    },
    [key],
  );
  return [value, set];
}
