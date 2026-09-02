# loro-prosemirror (Laddice fork) — Agent Instructions

> `CLAUDE.md` redirects here.

## What this repo is

A fork of upstream [`loro-dev/loro-prosemirror`](https://github.com/loro-dev/loro-prosemirror), canonical on GitLab with a GitHub mirror:

| Remote     | URL                                    | Role                                                      |
| ---------- | -------------------------------------- | --------------------------------------------------------- |
| `origin`   | `gitlab.com/enfilad/loro-prosemirror`  | canonical — push here (also pushes to the GitHub mirror)  |
| `github`   | `github.com/bZichett/loro-prosemirror` | mirror; the only copy a Claude Code web sandbox can clone |
| `upstream` | `github.com/loro-dev/loro-prosemirror` | upstream, read-only                                       |

**This repo is the single source for Laddice's ProseMirror↔Loro binding.** Every behaviour the downstream hard fork carried has been absorbed here with its tests (complete 2026-09-02); what remains is the consumer flip. Until then production still runs that fork — `packages/loro-prosemirror/` in `laddice-v2` (GitLab, `laddice/root`), consumed by four packages as `"loro-prosemirror": "workspace:*"`, locally at `../../laddice-v2/packages/loro-prosemirror`. Once the consumers point here and the editor E2E tier passes, that directory is deleted. Tracked in `laddice-v2` at `docs/plans/loro-prosemirror-converge-on-vendor.md`.

Everything Laddice needed landed as an option that defaults to upstream behaviour: `rootKey`, `container` (the `LoroTree` layout, `treeStrategy`), `fastInit`, `fastTextSync`, `externalCheckout`, `collaboration`, `seedFromEditor`, `onSchemaViolation`. Keep it that way — a divergence behind a defaulted seam is what makes pulling upstream fixes cheap.

This is also the **only copy a Claude Code web sandbox can reach** — sandboxes clone from GitHub, and the consumer is on GitLab. That reachability is why convergence lands here rather than the other way round.

## What that means for your change

**Work moves up into this repo, and stops moving down.** Two modes, so establish which you are in:

- **Absorbing** a behavior that already exists downstream — port it _with its tests_, and expect the target file to look different from the source. Do not assume the downstream implementation is the right shape here; it was written against a tree that had already diverged.
- **New work** — write it here first. It no longer needs a downstream twin, and adding one deepens the divergence this plan exists to close.

Either way, shape the diff for someone re-applying it against a different file, because until the dependency flips that is still what happens:

- One concern per commit, and a test commit before the fix commit. The test is the part that ports cleanly and proves the port landed.
- Prefer a new self-contained module over threading logic through `sync-plugin.ts` or `lib.ts` — the two most-diverged files, and the two most expensive to reconcile.
- Put the _why_ in the commit body. The porter reads the message, not this working tree.

## Downstream divergences you will meet

Do not assume upstream's shape when absorbing. The full per-file inventory — which divergences are upstreamable, fork-only, or blocking — is in `../../laddice-v2/docs/external-libraries/loro.md`. The one that bites hardest:

**`ROOT_DOC_KEY` is `"tree"` downstream, not upstream's `"doc"`.** The consumer's dual-container model puts `tree` (the PM document) and `ranges` (a CRDT-backed annotation overlay) side by side as top-level containers. This is a **wire-format fact** — persisted snapshots and the Dart binding both assume `tree` — so it is not settled by adopting upstream's name. Resolved here by the `rootKey` prop: the consumer passes `"tree"`, the default stays `"doc"`. Likewise the consumer's editorial documents are a `LoroTree` under that key while conversations are the nested layout; that is the `container` selector, chosen by the consumer from the root node type and never detected from the document.

## Do not port dependency bumps downward

`package.json` here pins `loro-crdt` with an ordinary semver range; bump freely to test against a newer runtime.

The consumer pins `"loro-crdt": "catalog:"` through the pnpm catalog, gated by `scripts/lint/check-loro-version-sync.sh`, which holds the npm package in lockstep with the `loro` Rust crate used by the Flutter bridge. That shared minor is the Flutter↔web wire-format contract. Carrying a bump downward as part of a fix trips the guard, and the guard is right.

## Working on a sandbox branch

Cloud sessions push branches named `claude/*` to `fork`. To pick one up without disturbing `main` (which carries unpushed commits and is often dirty), use a worktree rather than a second clone:

```
git fetch fork --prune
git worktree add ~/worktrees/loro-prosemirror/<short-name> -b <branch> fork/<branch>
```

This repo is its own pnpm workspace with its own lockfile, so `pnpm install` in the worktree is independent of anything else on the machine.

## Test before you hand it off

```
pnpm install
pnpm test
```

A fix that cannot be demonstrated by a test here cannot be verified after a port either — the downstream file it lands in looks different enough that "it looks right" proves nothing.
