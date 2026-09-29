import {
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";

import { prefersReducedMotion } from "@/shared/lib/motion";
import { useFlip } from "@/shared/lib/useFlip";
import { SCENE_LIMITS, type StoredScene, type SuggestedSceneId } from "@/shared/contracts/scenes";
import { IconButton } from "@/shared/ui/IconButton/IconButton";
import { IconCheck, IconDragHandle, IconPencil, IconPlus, IconTrash } from "@/shared/ui/icons";
import { RowNote } from "@/shared/ui/SettingRow/SettingRow";
import { SpinSwap } from "@/shared/ui/SpinSwap/SpinSwap";

import {
  SUGGESTED_SCENE_ORDER,
  isSceneAvailable,
  sceneName,
  sceneSwatch,
  suggestedScene,
  withScene,
  withSceneMovedTo,
  withSceneName,
  withoutScene,
} from "../model/sceneLibrary";
import { editScenes } from "../state/scenesStore";
import styles from "./SceneLibrary.module.css";
import { useArrivals } from "./useArrivals";

/** How long a delete waits for its second press: the webview does not always blur a clicked button. */
const ARMED_MS = 3000;
/** A deleted row's fade; the edit lands when it ends, or after this where no animationend comes. */
const LEAVE_FALLBACK_MS = 200;
/** Movement before a press on a row becomes a drag, so a click stays a click. */
const DRAG_SLOP_PX = 4;
/** A row's height where layout gives none (the test DOM). */
const ROW_FALLBACK_PX = 36;

interface SceneLibraryProps {
  scenes: readonly StoredScene[];
  /** The button that opened it: focus goes back there when focus leaves the library. */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}

interface Drag {
  id: string;
  from: number;
  to: number;
  dy: number;
}

/**
 * The library popover: the user's scenes to reorder by dragging, rename and delete, then the
 * suggested ones not yet in the list to add. A row that arrives grows in, one that goes folds away.
 * It is portalled after the page, so it takes focus when it opens and closes when focus leaves it.
 */
export function SceneLibrary({ scenes, anchorRef, onClose }: SceneLibraryProps) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const [drag, setDrag] = useState<Drag | null>(null);
  const [announce, setAnnounce] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pointer = useRef<(Drag & { startY: number; startScroll: number; height: number; moving: boolean }) | null>(null);
  const inList = new Set(scenes.map((scene) => scene.suggestedId).filter(Boolean));
  const suggestions = SUGGESTED_SCENE_ORDER.filter((id) => !inList.has(id));
  const full = scenes.length >= SCENE_LIMITS.maxScenes;
  const { arrived: entering, settled } = useArrivals(scenes.map((scene) => scene.id));
  const { arrived: returning, settled: returned } = useArrivals(suggestions);
  // Both lists and the heading between them move as one: a suggestion added travels up to its
  // place in the user's list, the rows under a deleted one close up, and the popover's height
  // follows. A dropped drag is already in place, so nothing moves then.
  const travellers = useRef(new Map<string, string>());
  useFlip(
    rootRef,
    [...scenes.map((scene) => scene.id), "suggested-heading", ...suggestions.map((id) => `suggested-${id}`)],
    { aliases: travellers.current, resize: true },
  );

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  /** After an edit re-renders the list: the control named, else the library itself. */
  const refocus = (testId?: string) =>
    requestAnimationFrame(() => {
      const target = testId ? rootRef.current?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) : null;
      (target ?? rootRef.current)?.focus({ preventScroll: true });
    });

  const edit = (change: (list: readonly StoredScene[]) => StoredScene[], focusAfter?: string) => {
    setFailed(false);
    void editScenes(change).catch((error: unknown) => {
      console.error("[LumaSync] saving the scenes failed:", error);
      setFailed(true);
    });
    refocus(focusAfter);
  };

  /** Folds the row away, then makes the edit that takes it out. */
  const leave = (key: string, change: (list: readonly StoredScene[]) => StoredScene[]) => {
    if (leaving.has(key)) return;
    const done = () => {
      setLeaving((keys) => {
        const next = new Set(keys);
        next.delete(key);
        return next;
      });
      edit(change);
    };
    if (prefersReducedMotion()) {
      done();
      return;
    }
    setLeaving((keys) => new Set(keys).add(key));
    leaveEnds.current.set(key, done);
    setTimeout(() => finishLeave(key), LEAVE_FALLBACK_MS);
  };
  const leaveEnds = useRef(new Map<string, () => void>());
  const finishLeave = (key: string) => {
    const done = leaveEnds.current.get(key);
    leaveEnds.current.delete(key);
    done?.();
  };

  const add = (suggestedId: SuggestedSceneId) => {
    const scene = suggestedScene(suggestedId, crypto.randomUUID());
    travellers.current.set(scene.id, `suggested-${suggestedId}`);
    edit((list) => withScene(list, scene));
  };

  const moveTo = (id: string, to: number, focusAfter?: string) => {
    const name = sceneName(scenes.find((scene) => scene.id === id)!, t);
    setAnnounce(t("lights:scenes.movedTo", { name, position: to + 1, count: scenes.length }));
    edit((list) => withSceneMovedTo(list, id, to), focusAfter);
  };

  const onRowPointerDown = (event: ReactPointerEvent<HTMLLIElement>, id: string, index: number) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button:not([data-handle]), input")) return;
    const row = event.currentTarget;
    row.setPointerCapture?.(event.pointerId);
    pointer.current = {
      id,
      from: index,
      to: index,
      dy: 0,
      startY: event.clientY,
      startScroll: rootRef.current?.scrollTop ?? 0,
      height: row.getBoundingClientRect().height || ROW_FALLBACK_PX,
      moving: false,
    };
  };
  const onRowPointerMove = (event: ReactPointerEvent<HTMLLIElement>) => {
    const p = pointer.current;
    const root = rootRef.current;
    if (!p || !root) return;
    // Near an edge of a list taller than the popover, it scrolls under the row being dragged.
    const box = root.getBoundingClientRect();
    if (p.moving && event.clientY < box.top + 24) root.scrollTop -= 8;
    else if (p.moving && event.clientY > box.bottom - 24) root.scrollTop += 8;
    const dy = event.clientY - p.startY + (root.scrollTop - p.startScroll);
    if (!p.moving && Math.abs(dy) < DRAG_SLOP_PX) return;
    p.moving = true;
    p.dy = dy;
    p.to = Math.max(0, Math.min(scenes.length - 1, p.from + Math.round(dy / p.height)));
    setDrag({ id: p.id, from: p.from, to: p.to, dy });
  };
  const onRowPointerUp = () => {
    const p = pointer.current;
    pointer.current = null;
    // One render: the new order and no offsets, so the dropped row stays where it was let go.
    if (p?.moving && p.to !== p.from) moveTo(p.id, p.to);
    setDrag(null);
  };

  const offsetOf = (id: string, index: number): number | undefined => {
    if (!drag) return undefined;
    if (id === drag.id) return drag.dy;
    const height = pointer.current?.height ?? ROW_FALLBACK_PX;
    if (drag.from < drag.to && index > drag.from && index <= drag.to) return -height;
    if (drag.from > drag.to && index >= drag.to && index < drag.from) return height;
    return 0;
  };

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className={styles.library}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next && (rootRef.current?.contains(next) || anchorRef.current?.contains(next))) return;
        // Tabbing past either end leaves the page for the popover's portal: close, and go home.
        onClose();
        if (!next) anchorRef.current?.focus();
      }}
      data-testid="scene-library"
    >
      <h3 className={styles.heading}>{t("lights:scenes.yours")}</h3>
      {scenes.length === 0 ? (
        <p className={styles.empty}>{t("lights:scenes.empty")}</p>
      ) : (
        <ul className={styles.list} data-dragging={drag ? true : undefined} data-testid="scene-library-yours">
          {scenes.map((scene, index) => (
            <SceneEntry
              key={scene.id}
              scene={scene}
              entering={entering.has(scene.id) && !travellers.current.has(scene.id)}
              leaving={leaving.has(scene.id)}
              offset={offsetOf(scene.id, index)}
              dragged={drag?.id === scene.id}
              onPointerDown={(event) => onRowPointerDown(event, scene.id, index)}
              onPointerMove={onRowPointerMove}
              onPointerUp={onRowPointerUp}
              onAnimationDone={() => (leaving.has(scene.id) ? finishLeave(scene.id) : settled(scene.id))}
              onKeyMove={(delta) => {
                const to = index + delta;
                if (to >= 0 && to < scenes.length) moveTo(scene.id, to, `scene-handle-${scene.id}`);
              }}
              onRename={(name) => edit((list) => withSceneName(list, scene.id, name), `scene-rename-${scene.id}`)}
              onRemove={() => leave(scene.id, (list) => withoutScene(list, scene.id))}
            />
          ))}
        </ul>
      )}
      {suggestions.length > 0 ? (
        <>
          <h3 className={styles.heading} data-flip-id="suggested-heading">
            {t("lights:scenes.suggestedTitle")}
          </h3>
          {full ? (
            <RowNote tone="status" testId="scene-library-full">
              {t("lights:scenes.full", { max: SCENE_LIMITS.maxScenes })}
            </RowNote>
          ) : null}
          <ul className={styles.list} data-testid="scene-library-suggested">
            {suggestions.map((suggestedId) => {
              const preview = suggestedScene(suggestedId, suggestedId);
              const name = sceneName(preview, t);
              return (
                <li
                  key={suggestedId}
                  className={styles.row}
                  data-flip-id={`suggested-${suggestedId}`}
                  data-entering={returning.has(suggestedId) || undefined}
                  onAnimationEnd={(event) => {
                    if (event.target === event.currentTarget) returned(suggestedId);
                  }}
                >
                  <span className={styles.handleSpace} aria-hidden />
                  <span className={styles.swatch} style={{ background: sceneSwatch(preview) }} aria-hidden />
                  <span className={styles.name}>{name}</span>
                  <IconButton
                    className={styles.action}
                    label={t("lights:scenes.add", { name })}
                    icon={<IconPlus />}
                    disabled={full}
                    onClick={() => add(suggestedId)}
                    data-testid={`scene-add-${suggestedId}`}
                  />
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {failed ? (
        <RowNote tone="error" testId="scene-library-failed">
          {t("lights:scenes.saveFailed")}
        </RowNote>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}

interface SceneEntryProps {
  scene: StoredScene;
  entering: boolean;
  leaving: boolean;
  /** Where a drag has put it, in px from its place; `undefined` when nothing is dragged. */
  offset: number | undefined;
  dragged: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLLIElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLLIElement>) => void;
  onPointerUp: () => void;
  /** Its own entrance or exit ended. */
  onAnimationDone: () => void;
  onKeyMove: (delta: -1 | 1) => void;
  onRename: (name: string) => void;
  onRemove: () => void;
}

/** One of the user's scenes: dragged by its handle or its body, renamed in place, deleted on a second press. */
function SceneEntry({
  scene,
  entering,
  leaving,
  offset,
  dragged,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onAnimationDone,
  onKeyMove,
  onRename,
  onRemove,
}: SceneEntryProps) {
  const { t } = useTranslation();
  const name = sceneName(scene, t);
  const available = isSceneAvailable(scene);
  const noteId = useId();
  const hintId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [armed, setArmed] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const renameRef = useRef<HTMLButtonElement | null>(null);
  // Enter closes the field and its blur would close it again; Esc closes it keeping nothing.
  const fieldOpen = useRef(false);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ARMED_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const open = () => {
    fieldOpen.current = true;
    setDraft(scene.name ?? "");
    setEditing(true);
  };
  const close = (keep: boolean) => {
    if (!fieldOpen.current) return;
    fieldOpen.current = false;
    const byKey = document.activeElement === inputRef.current;
    setEditing(false);
    if (keep && draft.trim() !== (scene.name ?? "")) onRename(draft);
    else if (byKey) requestAnimationFrame(() => renameRef.current?.focus());
  };

  return (
    <li
      className={styles.row}
      data-unavailable={!available || undefined}
      data-entering={entering || undefined}
      data-leaving={leaving || undefined}
      data-dragged={dragged || undefined}
      data-flip-id={scene.id}
      style={offset === undefined ? undefined : { transform: `translateY(${offset}px)` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) onAnimationDone();
      }}
      data-testid={`scene-entry-${scene.id}`}
    >
      <button
        type="button"
        className={styles.handle}
        data-handle
        aria-label={t("lights:scenes.reorder", { name })}
        aria-describedby={hintId}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          onKeyMove(event.key === "ArrowUp" ? -1 : 1);
        }}
        data-testid={`scene-handle-${scene.id}`}
      >
        <IconDragHandle />
      </button>
      <span id={hintId} className="sr-only">
        {t("lights:scenes.reorderHint")}
      </span>
      <span className={styles.swatch} style={{ background: sceneSwatch(scene) }} aria-hidden />
      {editing ? (
        <input
          ref={inputRef}
          autoFocus
          className={styles.input}
          value={draft}
          placeholder={name}
          maxLength={SCENE_LIMITS.nameMaxCodePoints * 2}
          aria-label={t("lights:scenes.rename", { name })}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              close(true);
            } else if (event.key === "Escape") {
              // The popover would close on the same key.
              event.preventDefault();
              event.stopPropagation();
              close(false);
            }
          }}
          onBlur={() => close(true)}
          data-testid={`scene-name-input-${scene.id}`}
        />
      ) : (
        <span className={styles.name}>
          {name}
          {available ? null : (
            <span id={noteId} className={styles.note}>
              {" · "}
              {t("lights:scenes.unavailableShort")}
            </span>
          )}
        </span>
      )}
      <span className={styles.actions} data-armed={armed || undefined}>
        <IconButton
          ref={renameRef}
          className={styles.action}
          label={t("lights:scenes.rename", { name })}
          icon={<IconPencil />}
          onClick={open}
          data-testid={`scene-rename-${scene.id}`}
        />
        <IconButton
          className={styles.action}
          label={armed ? t("lights:scenes.removeConfirm", { name }) : t("lights:scenes.remove", { name })}
          icon={
            <SpinSwap
              value={armed ? "armed" : "rest"}
              turn={(value) => (value === "armed" ? "cw" : "ccw")}
              render={(value) => (value === "armed" ? <IconCheck /> : <IconTrash />)}
            />
          }
          aria-describedby={available ? undefined : noteId}
          data-danger={armed || undefined}
          onClick={() => (armed ? onRemove() : setArmed(true))}
          onBlur={() => setArmed(false)}
          onMouseLeave={() => setArmed(false)}
          data-testid={`scene-remove-${scene.id}`}
        />
      </span>
      <span className="sr-only" aria-live="polite">
        {armed ? t("lights:scenes.removeConfirm", { name }) : ""}
      </span>
    </li>
  );
}
