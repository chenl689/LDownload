export interface ThrottledPublisher {
  schedule(): void;
  cancel(): void;
  flush(): void;
}

/** Coalesce bursty progress callbacks into a bounded renderer update rate. */
export function createThrottledPublisher(
  publish: () => void,
  intervalMs = 125,
): ThrottledPublisher {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return {
    schedule(): void {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        publish();
      }, intervalMs);
    },
    cancel,
    flush(): void {
      if (!timer) return;
      cancel();
      publish();
    },
  };
}
