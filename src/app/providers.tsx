/**
 * providers.tsx — App-level provider composition
 *
 * Wraps the application tree with all global providers.
 * Currently: react-i18next (I18nextProvider) from the initialised i18next
 * instance bootstrapped in main.tsx.
 *
 * Note: i18next is initialised BEFORE React renders (in main.tsx bootstrap)
 * so that LanguageSection and all child components receive a ready i18n
 * instance on first render. This avoids hydration flicker.
 */

import { type ReactNode, Suspense } from "react";
import { I18nextProvider } from "react-i18next";
import { i18next } from "../features/i18n/i18n";

interface ProvidersProps {
  children: ReactNode;
}

/**
 * Root provider component.
 * Wrap the <App /> with this in main.tsx.
 */
export function Providers({ children }: ProvidersProps) {
  return (
    <I18nextProvider i18n={i18next}>
      <Suspense fallback={null}>{children}</Suspense>
    </I18nextProvider>
  );
}
