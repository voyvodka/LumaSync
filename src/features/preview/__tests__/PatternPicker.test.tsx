/**
 * PatternPicker — aria semantics and interaction tests.
 *
 * Covers:
 *   - The selected pattern tile has aria-checked="true"; all others are false.
 *   - Clicking an unselected tile calls onSelectKind with the correct kind.
 *   - Speed buttons are disabled (aria-disabled + disabled attribute) for the
 *     two static patterns ("solid" and "gamut"), so the UI reads as
 *     intentionally inert rather than broken.
 *   - Speed buttons are enabled for animated patterns (chase / rainbow / spiral).
 *   - Clicking a speed button calls onSpeedChange with the correct value.
 *   - The active speed has aria-checked="true"; the others are false.
 *   - The "running" pulse indicator renders only when running===true.
 *   - The disabled prop gates every tile (pattern grid) to prevent interaction.
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LED_TEST_PATTERN_KIND } from "../../../shared/contracts/preview";
import { PatternPicker } from "../ui/PatternPicker";

// ---------------------------------------------------------------------------
// react-i18next stub — returns the translation key so assertions stay
// independent of the actual translated strings.
// ---------------------------------------------------------------------------
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATIC_KINDS = ["solid", "gamut"] as const;
const ANIMATED_KINDS = ["chase", "rainbow", "spiral"] as const;

function renderPicker(
  overrides: Partial<Parameters<typeof PatternPicker>[0]> = {},
) {
  const props = {
    selectedKind: "solid" as const,
    speed: "med" as const,
    running: false,
    disabled: false,
    onSelectKind: vi.fn(),
    onSpeedChange: vi.fn(),
    ...overrides,
  };
  render(<PatternPicker {...props} />);
  return props;
}

/** All three speed radio buttons (slow / med / fast). */
function speedButtons() {
  return ["slow", "med", "fast"].map((s) =>
    screen.getByRole("radio", { name: new RegExp(s, "i"), hidden: true }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PatternPicker — active tile and aria-checked", () => {
  it("the selected pattern tile has aria-checked=true; all others are false", () => {
    renderPicker({ selectedKind: "rainbow" });

    for (const kind of LED_TEST_PATTERN_KIND) {
      // Each tile's text content includes the translation key of the kind.
      const tile = screen.getByText(`ledPreview.pattern.${kind}`).closest("button");
      expect(tile).not.toBeNull();
      expect(tile?.getAttribute("aria-checked")).toBe(
        kind === "rainbow" ? "true" : "false",
      );
    }
  });

  it("clicking an unselected tile calls onSelectKind with that kind", () => {
    const { onSelectKind } = renderPicker({ selectedKind: "solid" });

    fireEvent.click(screen.getByText("ledPreview.pattern.chase").closest("button")!);

    expect(onSelectKind).toHaveBeenCalledWith("chase");
    expect(onSelectKind).toHaveBeenCalledOnce();
  });

  it("clicking the already-selected tile still calls onSelectKind (idempotent selection)", () => {
    const { onSelectKind } = renderPicker({ selectedKind: "gamut" });

    fireEvent.click(screen.getByText("ledPreview.pattern.gamut").closest("button")!);

    expect(onSelectKind).toHaveBeenCalledWith("gamut");
  });
});

describe("PatternPicker — speed control", () => {
  it.each(STATIC_KINDS)(
    "speed control is disabled when selectedKind is '%s' (static pattern)",
    (kind) => {
      renderPicker({ selectedKind: kind });

      const [slow, med, fast] = speedButtons();
      expect(slow).toBeDisabled();
      expect(med).toBeDisabled();
      expect(fast).toBeDisabled();
    },
  );

  it.each(ANIMATED_KINDS)(
    "speed control is enabled when selectedKind is '%s' (animated pattern)",
    (kind) => {
      renderPicker({ selectedKind: kind });

      const [slow, med, fast] = speedButtons();
      expect(slow).not.toBeDisabled();
      expect(med).not.toBeDisabled();
      expect(fast).not.toBeDisabled();
    },
  );

  it("the active speed button has aria-checked=true; the others are false", () => {
    renderPicker({ selectedKind: "chase", speed: "fast" });

    const [slow, med, fast] = speedButtons();
    expect(slow.getAttribute("aria-checked")).toBe("false");
    expect(med.getAttribute("aria-checked")).toBe("false");
    expect(fast.getAttribute("aria-checked")).toBe("true");
  });

  it("clicking a speed button calls onSpeedChange with the correct value", () => {
    const { onSpeedChange } = renderPicker({ selectedKind: "rainbow", speed: "med" });

    fireEvent.click(screen.getByText(/ledPreview.test.speed.slow/i));

    expect(onSpeedChange).toHaveBeenCalledWith("slow");
    expect(onSpeedChange).toHaveBeenCalledOnce();
  });
});

describe("PatternPicker — running indicator", () => {
  it("running pulse element is present when running=true", () => {
    renderPicker({ running: true });

    // The running indicator renders the i18n key inside a span.
    expect(screen.getByText("ledPreview.test.running")).toBeInTheDocument();
  });

  it("running pulse element is absent when running=false", () => {
    renderPicker({ running: false });

    expect(screen.queryByText("ledPreview.test.running")).not.toBeInTheDocument();
  });
});

describe("PatternPicker — disabled prop gates tiles", () => {
  it("all pattern tiles are disabled when disabled=true", () => {
    renderPicker({ disabled: true, selectedKind: "chase" });

    for (const kind of LED_TEST_PATTERN_KIND) {
      const tile = screen.getByText(`ledPreview.pattern.${kind}`).closest("button");
      expect(tile).toBeDisabled();
    }
  });

  it("clicking a tile does not call onSelectKind when disabled=true", () => {
    const { onSelectKind } = renderPicker({ disabled: true });

    fireEvent.click(screen.getByText("ledPreview.pattern.rainbow").closest("button")!);

    expect(onSelectKind).not.toHaveBeenCalled();
  });
});
