/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** "1" builds the 3D room view spike into a production bundle (dev builds always have it). */
  readonly VITE_ROOM_VIEW_SPIKE?: string;
}
