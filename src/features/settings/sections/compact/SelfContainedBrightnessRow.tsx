import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const BRIGHTNESS_COMMIT_MIN_INTERVAL_MS = 50;

/** Throttled range input. `initialPercent` re-syncs on external drift, but only
 *  while the user is not dragging — otherwise an echo commit snaps the thumb. */

interface SelfContainedBrightnessRowProps {
  initialPercent: number;
  disabled: boolean;
  /**
   * Mono mini-notice rendered under the slider when the row is disabled
   * for a firmware-level reason (Adalight, primarily). Mirrors the
   * SolidColorPanel surface in full mode so users see the same copy
   * regardless of which window they're in.
   */
  brightnessDisabledReason?: string;
  onCommit: (next: number) => void;
}

export function SelfContainedBrightnessRow({
  initialPercent,
  disabled,
  brightnessDisabledReason,
  onCommit,
}: SelfContainedBrightnessRowProps) {
  const { t } = useTranslation();
  const [localPercent, setLocalPercent] = useState(initialPercent);
  const isDraggingRef = useRef(false);

  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  const pendingPercentRef = useRef(initialPercent);
  const throttleRef = useRef<{ timer: number | null; lastAt: number }>({
    timer: null,
    lastAt: 0,
  });

  useEffect(() => {
    return () => {
      if (throttleRef.current.timer !== null) {
        window.clearTimeout(throttleRef.current.timer);
        throttleRef.current.timer = null;
      }
    };
  }, []);

  useEffect(() => {
    if (isDraggingRef.current) return;
    setLocalPercent(initialPercent);
    pendingPercentRef.current = initialPercent;
  }, [initialPercent]);

  const flushCommit = useCallback(() => {
    throttleRef.current.lastAt = Date.now();
    throttleRef.current.timer = null;
    onCommitRef.current(pendingPercentRef.current / 100);
  }, []);

  const scheduleCommit = useCallback(
    (nextPercent: number) => {
      pendingPercentRef.current = nextPercent;
      const now = Date.now();
      const elapsed = now - throttleRef.current.lastAt;
      const waitMs = Math.max(0, BRIGHTNESS_COMMIT_MIN_INTERVAL_MS - elapsed);
      if (throttleRef.current.timer !== null) {
        window.clearTimeout(throttleRef.current.timer);
        throttleRef.current.timer = null;
      }
      if (waitMs === 0) {
        flushCommit();
      } else {
        throttleRef.current.timer = window.setTimeout(flushCommit, waitMs);
      }
    },
    [flushCommit],
  );

  const handlePointerEnd = useCallback(() => {
    isDraggingRef.current = false;
    if (throttleRef.current.timer !== null) {
      window.clearTimeout(throttleRef.current.timer);
      throttleRef.current.timer = null;
    }
    flushCommit();
  }, [flushCommit]);

  // CSS variable drives the `linear-gradient` stop in `.lm-compact-slider`'s
  // track pseudo-element so the amber fill grows live with the thumb.
  const sliderStyle = { ["--lm-fill" as string]: `${localPercent}%` } as React.CSSProperties;

  return (
    <div className="lm-compact-slider-row">
      <div className="srow">
        <span>{t("common:mode.brightness")}</span>
        <b>{localPercent}%</b>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={localPercent}
        disabled={disabled}
        aria-disabled={disabled}
        title={brightnessDisabledReason}
        className="lm-compact-slider"
        style={sliderStyle}
        onPointerDown={() => {
          isDraggingRef.current = true;
        }}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onChange={(e) => {
          const next = Number(e.target.value);
          setLocalPercent(next);
          scheduleCommit(next);
        }}
      />
      {brightnessDisabledReason && (
        <div className="lm-compact-brightness-note" role="note">
          {brightnessDisabledReason}
        </div>
      )}
    </div>
  );
}
