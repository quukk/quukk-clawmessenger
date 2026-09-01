import { useEffect, useMemo, useRef } from 'react';

export type RequestFence = {
  begin(): number;
  isCurrent(generation: number): boolean;
};

export function useRequestFence(): RequestFence {
  const state = useRef({ mounted: false, generation: 0 });

  useEffect(() => {
    state.current.mounted = true;
    return () => {
      state.current.mounted = false;
      state.current.generation += 1;
    };
  }, []);

  return useMemo(
    () => ({
      begin: () => ++state.current.generation,
      isCurrent: (generation) =>
        state.current.mounted && state.current.generation === generation,
    }),
    [],
  );
}
