## Summary

Describe what changed and why.

User-visible: one sentence from the user's side, about 25 words — or `none`. The release notes are written from this line; do not edit `CHANGELOG.md`.

## Related Issues

- Closes #

## Changes

- 

## Validation

- [ ] `bun run typecheck`
- [ ] Targeted frontend tests (if applicable)
- [ ] `bun run check:rust` (if Rust/Tauri touched)
- [ ] `bun run verify:shell-contracts` (if contracts touched)
- [ ] `bun run build` (when integration confidence is needed)

## Screenshots / Recordings

If UI behavior changed, add before/after visuals.

## Checklist

- [ ] Scope is focused; no unrelated cleanup
- [ ] Docs updated when behavior changed
- [ ] i18n strings updated if user-visible text changed
- [ ] Contracts/status codes kept stable or documented

## Version / Release Impact

- [ ] No version bump in this PR
- [ ] Version bump is included and SemVer rationale is documented
- [ ] Security impact reviewed (`SECURITY.md` process if needed)
- [ ] Compatibility impact documented (if contracts/status codes changed)
