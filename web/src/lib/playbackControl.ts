import type { ListenTrack, SavedSession } from './listen';

export type PlaybackAction = 'start' | 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'seek' | 'volume' |
  'shuffle' | 'repeat' | 'add_next' | 'append' | 'remove' | 'move' | 'play_index';
export interface PlaybackCommand {
  action: PlaybackAction;
  snapshot?: SavedSession;
  tracks?: readonly ListenTrack[];
  index?: number;
  to_index?: number;
  position?: number;
  volume?: number;
  shuffle?: boolean;
}
let controller: ((command: PlaybackCommand) => boolean) | null = null;
export function registerPlaybackController(handler: (command: PlaybackCommand) => boolean) { controller = handler; }
export function routePlayback(command: PlaybackCommand) { return controller?.(command) ?? false; }
