import { Component, createRef, type ReactNode } from "react";

import { prefersReducedMotion } from "@/shared/lib/motion";
import styles from "./StageSwap.module.css";

interface StageSwapProps {
  /** What the stage shows; a change of key is a change of stage. */
  stageKey: string;
  /** The key's place in its order, so the stage passes the way the choice moved. */
  order: number;
  children: ReactNode;
  className?: string;
}

const cls = (name: string): string => styles[name] ?? "";

/** A leaving stage that never reports its end (a hidden window, a test DOM) goes after this. */
const LEAVE_FALLBACK_MS = 320;

/**
 * One stage at a time, passed on when its key changes: the old one leaves as a still copy of what
 * it drew — a ghost, not a second mounted tree, so nothing reads state or saves twice — while the
 * new one arrives in its place from the side the choice moved to. With reduced motion, or while the
 * window is hidden (the tray window shown later would replay it), it just swaps.
 */
export class StageSwap extends Component<StageSwapProps> {
  private readonly box = createRef<HTMLDivElement>();
  private readonly live = createRef<HTMLDivElement>();
  private ghostTimer: ReturnType<typeof setTimeout> | null = null;

  getSnapshotBeforeUpdate(prev: StageSwapProps): { ghost: HTMLElement; way: "next" | "prev" } | null {
    if (prev.stageKey === this.props.stageKey || !this.live.current) return null;
    if (prefersReducedMotion() || document.visibilityState !== "visible") return null;
    const ghost = this.live.current.cloneNode(true) as HTMLElement;
    return { ghost, way: this.props.order >= prev.order ? "next" : "prev" };
  }

  componentDidUpdate(
    _prev: StageSwapProps,
    _state: unknown,
    snapshot: { ghost: HTMLElement; way: "next" | "prev" } | null,
  ): void {
    const box = this.box.current;
    const live = this.live.current;
    if (!snapshot || !box || !live) return;
    this.dropGhosts();
    const { ghost, way } = snapshot;
    ghost.removeAttribute("id");
    ghost.setAttribute("aria-hidden", "true");
    ghost.setAttribute("inert", "");
    ghost.className = `${cls("ghost")} ${cls(way)}`;
    ghost.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    ghost.querySelectorAll("[data-testid]").forEach((node) => node.removeAttribute("data-testid"));
    // What is about the moment, not the stage (the lights-off veil), does not leave with it.
    ghost.querySelectorAll("[data-ghost-skip]").forEach((node) => node.remove());
    // Its own leave only: a swatch or spinner animating inside it bubbles an animationend too.
    const leave = (event: AnimationEvent) => {
      if (event.target !== ghost) return;
      ghost.removeEventListener("animationend", leave);
      ghost.remove();
    };
    ghost.addEventListener("animationend", leave);
    box.append(ghost);
    live.classList.remove(cls("next"), cls("prev"));
    // Restart the entrance: a class set again in the same frame does not replay.
    void live.offsetWidth;
    live.classList.add(cls("entering"), cls(way));
    this.ghostTimer = setTimeout(() => this.dropGhosts(), LEAVE_FALLBACK_MS);
  }

  componentWillUnmount(): void {
    if (this.ghostTimer) clearTimeout(this.ghostTimer);
  }

  private dropGhosts(): void {
    if (this.ghostTimer) clearTimeout(this.ghostTimer);
    this.ghostTimer = null;
    this.box.current?.querySelectorAll(`.${cls("ghost")}`).forEach((node) => node.remove());
  }

  render(): ReactNode {
    return (
      <div ref={this.box} className={`${cls("box")} ${this.props.className ?? ""}`}>
        <div
          ref={this.live}
          className={cls("live")}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) {
              event.currentTarget.classList.remove(cls("entering"), cls("next"), cls("prev"));
            }
          }}
        >
          {this.props.children}
        </div>
      </div>
    );
  }
}
