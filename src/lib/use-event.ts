import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Returns a callback whose identity never changes but whose body is always the latest render's.
 *
 * This matters here beyond tidiness. The prototype's scripted demo memoised its step list with
 * an empty dependency array, so every step invoked the *first* render's handlers. `letItGo` read
 * `pending` straight out of that dead closure, found an empty array, and returned early — the
 * demo's whole "let it go" beat silently did nothing. An `eslint-disable` on the dependency
 * array is what hid it.
 *
 * Handing out stable-but-current callbacks means a consumer can hold one forever without going
 * stale, so that failure mode cannot recur.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useEvent<T extends (...args: any[]) => any>(fn: T): T {
  const ref = useRef(fn);

  useLayoutEffect(() => {
    ref.current = fn;
  });

  return useCallback((...args: Parameters<T>): ReturnType<T> => ref.current(...args), []) as T;
}
