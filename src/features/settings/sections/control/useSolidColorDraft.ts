import { useEffect, useRef, useState } from "react";

interface SolidDraft {
  r: number;
  g: number;
  b: number;
  brightness: number;
}

const SOLID_COMMIT_MIN_INTERVAL_MS = 50;

function isSameSolidDraft(left: SolidDraft, right: SolidDraft): boolean {
  return (
    left.r === right.r &&
    left.g === right.g &&
    left.b === right.b &&
    Math.abs(left.brightness - right.brightness) < 0.001
  );
}

export interface UseSolidColorDraftOptions {
  incoming: { r: number; g: number; b: number; brightness: number };
  onCommit: (draft: { r: number; g: number; b: number; brightness: number }) => void;
}

export function useSolidColorDraft({ incoming, onCommit }: UseSolidColorDraftOptions) {
  const [draft, setDraft] = useState<SolidDraft>(incoming);
  const commitTimerRef = useRef<number | null>(null);
  const pendingCommitRef = useRef<SolidDraft | null>(null);
  const lastCommitAtRef = useRef(0);

  useEffect(() => {
    if (pendingCommitRef.current) return;
    setDraft((prev) => (isSameSolidDraft(prev, incoming) ? prev : incoming));
  }, [incoming.brightness, incoming.b, incoming.g, incoming.r]);

  useEffect(() => {
    return () => {
      if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current);
    };
  }, []);

  const flushCommit = (payload: SolidDraft) => {
    lastCommitAtRef.current = Date.now();
    pendingCommitRef.current = null;
    onCommit(payload);
  };

  const queueCommit = (payload: SolidDraft) => {
    pendingCommitRef.current = payload;
    const elapsed = Date.now() - lastCommitAtRef.current;
    const waitMs = Math.max(0, SOLID_COMMIT_MIN_INTERVAL_MS - elapsed);
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    if (waitMs === 0) {
      flushCommit(payload);
      return;
    }
    commitTimerRef.current = window.setTimeout(() => {
      commitTimerRef.current = null;
      const latest = pendingCommitRef.current;
      if (latest) flushCommit(latest);
    }, waitMs);
  };

  const setColor = (color: { r: number; g: number; b: number }) => {
    const next = { ...draft, ...color };
    setDraft(next);
    queueCommit(next);
  };

  const setBrightness = (brightness: number) => {
    const next = { ...draft, brightness: Number.isFinite(brightness) ? brightness : draft.brightness };
    setDraft(next);
    queueCommit(next);
  };

  return { draft, setColor, setBrightness };
}
