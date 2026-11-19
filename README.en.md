# dsh-latex-render-fix

Fixes red LaTeX errors in dsh's chat panel for formulas written as
`$$\begin{aligned} … \end{aligned}$$`:

```
KaTeX parse error: Expected 'EOF', got '&' at position 35
```

The same content renders fine in VS Code, Typora or Obsidian — **the formula is not wrong.**

---

## Why it breaks

dsh renders markdown through remark / micromark, which models block math as a
**code fence**: `$$` behaves like ` ``` `, whatever follows `$$` on the same line is
treated as an info string (`mathFlowFenceMeta`) and **thrown away**, and the closing
fence **must start at the beginning of a line**.

So in `$$\begin{aligned}`, the `\begin{aligned}` is dropped; the formula body starts
with `\frac… &= …` and KaTeX sees a top-level `&` → parse error. The trailing
`\end{aligned}$$` cannot close the fence (the `$$` is not at line start), so the node
swallows the rest of the document and everything after it turns into raw source.

---

## What this plugin does

Before the window loads, it checks the frontend bundle inside `resources/app.asar`.
If the patch is missing, it inserts two regular expressions at the markdown render
entry points, normalizing the text **before it reaches the parser**:

```
$$
\begin{aligned}
a &= b \\
\end{aligned}
$$
```

i.e. it moves the text after `$$` and the closing `$$` onto their own lines. This is
equivalent to manually reformatting the block — it does not touch the parser.

Both regexes are idempotent, so re-running on every streaming frame never accumulates
inserted newlines. They only match a **line-leading** `$$` followed by `\begin{`, and a
**line-trailing** `\end{env}$$`; `$$` in the middle of a line is untouched.

---

## Behavior and limits

| Situation | Result |
|---|---|
| Already-safe input (`$$` on its own line) | untouched |
| dsh updates and overwrites the asar | re-patched on the next start |
| **First start after an update** | **formulas still red** |
| **Second start** | fixed |

The "still red on first start" part is an upstream constraint: cordis registers plugins
without **awaiting** their `apply`, so a 0.8–1.2 s asar rebuild cannot finish before the
window loads.

Only blocks containing `\begin{...}` are promoted to display math (centered, matching
VS Code). Single-line `$$x$$` without `\begin` stays inline on purpose.

---

## Install

Install from the plugin market, or manually — all three of the following are required:

1. declare the plugin in `dependencies` of `~/.dsh/profiles/<profile>/package.json`
2. list it in `dsh.profile.bundles` in the same file
3. make it resolvable under `node_modules/<name>`

> Dropping a folder into `node_modules` without declaring it in `dependencies` gets it
> cleaned up by the package manager / update flow.

---

## Logs and manual run

```
~/.dsh/dsh-guard/plugin.log        # override with DSH_LATEX_GUARD_HOME
node lib/index.js [--asar <path>]
```

`锚点命中 0/2` (anchor matched 0/2) means the minified structure changed — the plugin
skips instead of writing a broken file.

---

## Permissions

Official dsh installers are per-user (`%LOCALAPPDATA%\Programs\DeepSeek Harness`), which
is writable without admin rights. If you installed to `C:\Program Files`, start dsh as
administrator once; otherwise the plugin logs `没有写入权限` and skips — dsh still works,
formulas just stay red.

---

## Rollback

Every patch leaves `app.asar.bak-<timestamp>` next to the asar (last 2 kept):

```
copy /Y "<dsh>/resources/app.asar.bak-<latest>" "<dsh>/resources/app.asar"
```

## Risk

This plugin **rewrites `app.asar` in the dsh installation directory** (+218 bytes, all
other bytes shifted unchanged). Safety measures: in-place state detection, structure
based anchors, `node --check` before writing, backup + size verification + automatic
restore, and every failure is log-only so dsh always starts.

Still, keep a copy of your `resources` folder if you want to be extra safe.

## License

MIT
