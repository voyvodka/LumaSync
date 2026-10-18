import { useTranslation } from "react-i18next";

import { SCENE_LIMITS } from "@/shared/contracts/scenes";
import { IconButton } from "@/shared/ui/IconButton/IconButton";
import { IconUndo } from "@/shared/ui/icons";
import { RowButton } from "@/shared/ui/SettingRow/SettingRow";

import styles from "./SceneEditBar.module.css";

interface SceneEditBarProps {
  /** Says what is being edited: "Editing Movie", or a new scene. */
  label: string;
  name: string;
  /** What the scene is called while the field is empty: its library name, or what it plays. */
  placeholder: string;
  /** The light as it would be saved. */
  swatch: string;
  /** Off is not a scene: with the lights off there is nothing to save. */
  canSave: boolean;
  /** The last save did not land: the bar is back, and says so. */
  failed: boolean;
  /** Back to where the scene starts from; `done` while the light is already there. None for a new scene. */
  reset?: { label: string; done: boolean; onReset: () => void };
  onName: (name: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

/** The scenes row while a scene is being made or edited: its look, its name, Cancel and Save. */
export function SceneEditBar({
  label,
  name,
  placeholder,
  swatch,
  canSave,
  failed,
  reset,
  onName,
  onSave,
  onCancel,
}: SceneEditBarProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.bar} role="group" aria-label={label} data-testid="scene-edit">
      <span className={styles.swatch} style={{ background: swatch }} aria-hidden />
      <input
        className={styles.input}
        value={name}
        placeholder={placeholder}
        maxLength={SCENE_LIMITS.nameMaxCodePoints * 2}
        aria-label={t("lights:scenes.nameField")}
        aria-invalid={failed || undefined}
        title={failed ? t("lights:scenes.saveFailed") : undefined}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && canSave) {
            event.preventDefault();
            onSave();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        data-testid="scene-edit-name"
      />
      {reset ? (
        <IconButton
          className={styles.reset}
          label={reset.label}
          icon={<IconUndo />}
          disabled={reset.done}
          onClick={reset.onReset}
          data-testid="scene-edit-reset"
        />
      ) : null}
      <RowButton className={styles.button} onClick={onCancel} data-testid="scene-edit-cancel">
        {t("lights:scenes.cancelEdit")}
      </RowButton>
      <RowButton
        primary
        className={styles.button}
        disabled={!canSave}
        title={canSave ? undefined : t("lights:scenes.saveNeedsLight")}
        onClick={onSave}
        data-testid="scene-edit-save"
      >
        {t("lights:scenes.saveEdit")}
      </RowButton>
    </div>
  );
}
