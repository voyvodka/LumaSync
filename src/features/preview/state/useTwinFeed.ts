/**
 * useTwinFeed — the twin's layout and its latest frame.
 *
 * The layout comes with the subscribe answer and then on `preview://twin-layout`;
 * frames come on the subscribed channel. A frame is drawn only against the
 * layout it was cut for, and only when it has one colour per LED of it — so a
 * frame from before a layout change never lights the wrong positions.
 *
 * Rust sends one frame while answering the subscribe, before the layout is
 * known here; the newest such frame is held and drawn once the layout lands,
 * or a still mode (Solid, Off) would leave the twin blank.
 */

import { useEffect, useRef, useState } from "react";

import type { TwinLayout } from "@/shared/contracts/preview";
import { subscribeTwinFrames } from "../previewApi";
import { listenTwinLayout, type UnlistenFn } from "../previewEventsApi";
import { decodeTwinFrame, type TwinFrame } from "../twinFrame";

export interface TwinFeed {
  layout: TwinLayout | null;
  frame: TwinFrame | null;
}

function fits(frame: TwinFrame, layout: TwinLayout): boolean {
  return frame.layoutRevision === layout.layoutRevision && frame.leds.length === (layout.leds?.totalLeds ?? 0);
}

export function useTwinFeed(): TwinFeed {
  const [feed, setFeed] = useState<TwinFeed>({ layout: null, frame: null });
  const layoutRef = useRef<TwinLayout | null>(null);
  const heldRef = useRef<TwinFrame | null>(null);

  useEffect(() => {
    let alive = true;
    let unlisten: UnlistenFn | null = null;

    const adopt = (layout: TwinLayout) => {
      if (!alive) return;
      const current = layoutRef.current;
      if (current && layout.layoutRevision <= current.layoutRevision) return;
      layoutRef.current = layout;
      const held = heldRef.current;
      heldRef.current = null;
      setFeed({ layout, frame: held && fits(held, layout) ? held : null });
    };

    listenTwinLayout(adopt)
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch((error) => {
        console.error("[LumaSync] useTwinFeed layout listen failed:", error);
      });

    void subscribeTwinFrames((buffer) => {
      if (!alive) return;
      const frame = decodeTwinFrame(buffer);
      if (!frame) return;
      const layout = layoutRef.current;
      if (!layout || frame.layoutRevision > layout.layoutRevision) {
        heldRef.current = frame;
        return;
      }
      if (fits(frame, layout)) setFeed({ layout, frame });
    }).then((result) => {
      if (result.layout) adopt(result.layout);
    });

    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return feed;
}
