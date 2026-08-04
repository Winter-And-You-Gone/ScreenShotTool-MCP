# Example App Pack: Generic Qt App

This pack demonstrates the App Pack format for a typical Qt Widgets
application. It is a FORMAT EXAMPLE - the target application does not ship
with this repository. Copy `app-packs/templates/` and adapt the selectors to
your own app (use `app_pack_probe` on a running instance to generate the
control list).

## What it shows

- `menu` routing hints (`controls.json`): a menu button whose `sectionControl`
  names the section-row selector (for `openMenu`), section rows with
  `opensSubmenu` (open via keyboard-Right), command rows with
  `invokeMode: "keyboard-enter"` (non-blocking focus+Enter for commands that
  open a modal dialog), and a `panelControl` window that receives the keys.
- `submenuAidPatterns` (`profile.json`): automationId regexes that label menu
  items as submenu-openers in enumeration results.
- `defaultExpect` (`actions.json`): `menuAbout.invoke` automatically waits for
  `aboutDialog` to exist; `aboutDialogOkButton.invoke` waits for it to close.
- A `finally` block (`workflows.json`): closes the About dialog even when a
  middle step fails, with `ignoreCodes` for already-closed states.

## Try it (with your own Qt app)

Point `GENERIC_QT_APP_EXE` at the executable, replace the selectors with the
probed automationIds, then:

```
app_pack_validate {pack:"generic-qt"}
workflow_catalog {pack:"generic-qt"}
run_workflow {pack:"generic-qt", workflow:"open_about"}
```
