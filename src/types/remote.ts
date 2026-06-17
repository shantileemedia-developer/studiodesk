export type RcPermissionGrant = {
  desktopAccess: 'none' | 'view' | 'full';
  dawControl: boolean;
};

export type RemoteInputEvent =
  | { type: 'pointerdown' | 'pointermove' | 'pointerup'; nx: number; ny: number; button: number; buttons: number }
  | { type: 'click' | 'dblclick' | 'contextmenu'; nx: number; ny: number; button: number }
  | { type: 'wheel'; nx: number; ny: number; deltaX: number; deltaY: number }
  | { type: 'keydown' | 'keyup'; key: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; repeat: boolean }
  | { type: 'artist-cursor'; nx: number; ny: number }
  | { type: 'view-sync'; zoom: number; scrollLeft: number; scrollTop: number }
  | { type: 'input-value'; nx: number; ny: number; value: string }
  | { type: 'remote-command'; command: 'open-audio-dialog' | 'open-audio-settings' };
