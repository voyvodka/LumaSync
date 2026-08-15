import { beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// Node >= 24's experimental `localStorage` global reads back as `undefined`
// without `--localstorage-file` and shadows happy-dom's, so install ours before
// anything reads the key. See docs/architecture/build-and-release.md.
function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => {
      entries.clear();
    },
    getItem: (key: string) => entries.get(String(key)) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => {
      entries.delete(String(key));
    },
    setItem: (key: string, value: string) => {
      entries.set(String(key), String(value));
    },
  };
}

const memoryStorage = createMemoryStorage();

// `window` is absent in the files that opt into `@vitest-environment node`.
const targets = new Set<object>([globalThis]);
const maybeWindow = (globalThis as { window?: object }).window;
if (maybeWindow) targets.add(maybeWindow);

for (const target of targets) {
  Object.defineProperty(target, "localStorage", {
    configurable: true,
    writable: true,
    value: memoryStorage,
  });
}

beforeEach(() => {
  memoryStorage.clear();
});
