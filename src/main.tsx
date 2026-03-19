/**
 * main.tsx — Application entry point
 *
 * Bootstrap order:
 *  1. Resolve initial language via languagePolicy (I18N-02: English on first launch)
 *  2. Initialise i18next with the resolved language
 *  3. Mount React with provider composition (I18nextProvider, etc.)
 *
 * i18next is initialised BEFORE React renders to prevent hydration flicker
 * and ensure all components receive a ready translation instance.
 */

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { Providers } from "./app/providers";
import { resolveInitialLanguage } from "./features/i18n/languagePolicy";
import { initI18n } from "./features/i18n/i18n";

async function bootstrap() {
  // 1. Resolve language (honours I18N-02: English default on first launch)
  const language = await resolveInitialLanguage();

  // 2. Initialise i18next with resolved language
  await initI18n(language);

  // 3. Mount React
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Providers>
        <App />
      </Providers>
    </React.StrictMode>,
  );
}

bootstrap().catch((err) => {
  // Bootstrap failure is non-fatal: fall back to English i18n and render anyway
  console.error("[Ambilight] Bootstrap error:", err);
  initI18n("en").then(() => {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <Providers>
          <App />
        </Providers>
      </React.StrictMode>,
    );
  });
});
