import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { APP_NAME, APP_VERSION } from "@/shared/constants/app";
import { IconCheck } from "@/shared/ui/icons";
import { StateSwap } from "@/shared/ui/StateSwap/StateSwap";
import { detectOsName, LICENSE_URL, releaseNotesUrl, REPO_URL, SITE_URL } from "../helpLinks";
import styles from "./AboutCard.module.css";

/** How long "Copied" stays on the version before it reads as the version again. */
const COPIED_MS = 1_800;

function CopyGlyph() {
  return (
    <svg className={styles.glyph} viewBox="0 0 16 16" width="13" height="13" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
      <path d="M10.5 3.2V3a1.5 1.5 0 0 0-1.5-1.5H3.8A1.5 1.5 0 0 0 2.3 3v5.2a1.5 1.5 0 0 0 1.5 1.5H4" />
    </svg>
  );
}

/**
 * Who the app is and what it promises, in a few words: a lit screen for the mark, the version as
 * the thing a bug report needs (a press copies it with the OS), the one promise that matters — it
 * stays on this computer — and where to read more.
 */
export function AboutCard() {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copyVersion() {
    const os = detectOsName();
    try {
      await navigator.clipboard.writeText(`${APP_NAME} ${APP_VERSION}${os ? ` · ${os}` : ""}`);
      setCopied(true);
    } catch (err) {
      console.error("[LumaSync] copying the version failed:", err);
    }
  }

  const links = [
    { href: SITE_URL, label: t("settings:about.site") },
    { href: REPO_URL, label: t("settings:about.source") },
    { href: releaseNotesUrl(APP_VERSION), label: t("settings:about.notes") },
    { href: LICENSE_URL, label: t("settings:about.license") },
  ];

  return (
    <div className={styles.card}>
      <div className={styles.mark} aria-hidden="true">
        <span className={styles.screen} />
        <span className={styles.stand} />
      </div>
      <h2 className={styles.name}>{APP_NAME}</h2>
      <button
        type="button"
        className={styles.version}
        onClick={() => void copyVersion()}
        aria-label={copied ? t("settings:about.copied") : `${t("settings:about.copyVersion")} v${APP_VERSION}`}
        data-testid="about-version"
      >
        <StateSwap
          fit
          state={copied ? "copied" : "idle"}
          faces={{
            idle: (
              <>
                v{APP_VERSION}
                <CopyGlyph />
              </>
            ),
            copied: (
              <>
                <span className={styles.ok}>
                  <IconCheck />
                </span>
                {t("settings:about.copied")}
              </>
            ),
          }}
        />
      </button>
      <p className="sr-only" role="status" aria-live="polite">
        {copied ? t("settings:about.copied") : ""}
      </p>
      <p className={styles.tagline}>{t("settings:about.tagline")}</p>
      <p className={styles.local}>{t("settings:about.local")}</p>
      <nav className={styles.links} aria-label={APP_NAME}>
        {links.map(({ href, label }) => (
          <a key={href} href={href} target="_blank" rel="noreferrer noopener">
            {label}
            <span aria-hidden="true">↗</span>
            <span className="sr-only"> ({t("common:opensInBrowser")})</span>
          </a>
        ))}
      </nav>
    </div>
  );
}
