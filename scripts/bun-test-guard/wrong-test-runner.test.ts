import { expect, test } from "bun:test";

// `bun test` is Bun's own runner. It ignores vitest.config.ts, so it gets no
// happy-dom environment, no setupFiles and no `@` alias; pointed at src/ it
// collapses into hundreds of failures that read like a regression but are only
// the wrong runner. bunfig.toml confines it to this directory so the mistake
// costs one line instead of a wall of noise.
test("LumaSync's suite runs under Vitest — use `bun run test`, not `bun test`", () => {
  expect(
    "bun run test  (whole suite) · bun run test <path>  (one file) · bunx vitest  (watch)",
  ).toBe("__use_bun_run_test__");
});
