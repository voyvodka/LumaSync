import { useTranslation } from "react-i18next";

import { DECOR_LIGHT_FIXTURES, type DecorLightFixture, type HueChannelPlacement, type LightStructure } from "@/shared/contracts/roomMap";
import { InfoTip } from "@/shared/ui/InfoTip/InfoTip";

import { DECOR_LOWEST_M, decorLightHeight } from "../../model/decorLight";
import { hangHeight } from "../../model/hueHang";
import { DecimalField } from "../DecimalField";
import { DecorDrivePicker } from "../dock/DecorDrivePicker";
import { DockPicker } from "../dock/DockPicker";
import { DockSlider } from "../dock/DockSlider";
import { Actions, FieldRow, InspectorRows, Mark, Meta, NameField, RowLink, Status } from "../dock/InspectorParts";
import { FAMILY_KEY } from "../view/viewLightLabel";
import { DecorGlyph } from "./DecorGlyph";
import { GlyphHeight } from "./fieldGlyphs";

const FIXTURES = Object.values(DECOR_LIGHT_FIXTURES);

export function DecorLightInspector({
  light,
  name,
  roomWidthMeters,
  roomDepthMeters,
  roomHeightMeters,
  channels,
  onMove,
  onHeightChange,
  onUpdate,
  onDriveWithHue,
  onRename,
  onToggleLock,
  onClose,
}: {
  light: LightStructure;
  /** What it is called when it has no name of its own: its fixture, numbered among its likes. */
  name: string;
  roomWidthMeters: number;
  roomDepthMeters: number;
  roomHeightMeters: number;
  channels: readonly HueChannelPlacement[];
  onMove: (x: number, y: number) => void;
  /** Its lit part's height in metres; `undefined` puts it back where its fixture hangs. */
  onHeightChange: (height: number | undefined) => void;
  onUpdate: (patch: { fixture: DecorLightFixture }) => void;
  onDriveWithHue: (channelIndex: number) => void;
  onRename: (label: string) => void;
  onToggleLock: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const locked = !!light.locked;
  const height = decorLightHeight(light, roomHeightMeters);
  const hangsAt = hangHeight(light.fixture, roomHeightMeters);
  const metres = (m: number) => m.toFixed(2);
  const hung = light.dropMeters === undefined || (hangsAt !== null && Math.abs(hangsAt - height) <= 0.005);

  return (
    <InspectorRows
      first={
        <>
          <Mark>
            <span style={{ color: "var(--lm-ink-dim)", display: "grid" }}>
              <DecorGlyph />
            </span>
          </Mark>
          <NameField
            first
            value={light.label}
            fallback={name}
            label={t("roomMap:inspector.furnitureNameLabel")}
            disabled={locked}
            onCommit={onRename}
          />
          <Status>
            <Meta>{t("roomMap:inspector.decorNotDriven")}</Meta>
          </Status>
          {!locked && <DecorDrivePicker channels={channels} onDrive={onDriveWithHue} />}
          <InfoTip label={t("common:hintFor", { label: t("roomMap:inspector.decorDriveLabel") })}>{t("roomMap:inspector.decorDriveInfo")}</InfoTip>
          <Actions locked={locked} onToggleLock={onToggleLock} onClose={onClose} />
        </>
      }
      second={
        <>
          <FieldRow>
            <DecimalField
              label={t("roomMap:inspector.xLabel")}
              prefix="X"
              value={light.x}
              min={0}
              max={roomWidthMeters}
              unit="m"
              disabled={locked}
              onCommit={(x) => onMove(x, light.y)}
            />
            <DecimalField
              label={t("roomMap:inspector.yLabel")}
              prefix="Y"
              value={light.y}
              min={0}
              max={roomDepthMeters}
              unit="m"
              disabled={locked}
              onCommit={(y) => onMove(light.x, y)}
            />
          </FieldRow>
          <DockSlider
            label={t("roomMap:inspector.decorHeightLabel")}
            prefix={<GlyphHeight />}
            min={DECOR_LOWEST_M}
            max={roomHeightMeters}
            step={0.01}
            value={height}
            disabled={locked}
            onChange={onHeightChange}
            ariaValueText={t("roomMap:inspector.hueHeightReadout", { metres: metres(height) })}
            readout={t("roomMap:inspector.hueHeightReadout", { metres: metres(height) })}
          />
          {hangsAt !== null && !locked && (
            // Its room is kept while it is hung, so the slider does not narrow under a drag that unhangs it.
            <span style={hung ? { visibility: "hidden" } : undefined} inert={hung}>
              <RowLink onClick={() => onHeightChange(undefined)}>{t("roomMap:inspector.hueHang")}</RowLink>
            </span>
          )}
          <FieldRow>
            <DockPicker<DecorLightFixture>
              label={t("roomMap:inspector.modelLabel")}
              value={light.fixture}
              width={150}
              disabled={locked}
              options={FIXTURES.map((value) => ({ value, label: t(FAMILY_KEY[value]) }))}
              onChange={(fixture) => onUpdate({ fixture })}
            />
          </FieldRow>
        </>
      }
    />
  );
}
