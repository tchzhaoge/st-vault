import type * as HlsModule from 'hls.js';
type EngineModule = typeof HlsModule;
let pending: Promise<EngineModule> | undefined;
// Playback preparation begins on selection, alongside the live-session request.
export function loadPlayerEngine(): Promise<EngineModule> {
  return (pending ??= import('hls.js').catch((error: unknown) => {
    pending = undefined;
    throw error;
  }));
}
