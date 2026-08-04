# Example App Pack: Windows Notepad

This pack demonstrates the App Pack format for a generic Windows editor
(Notepad / Windows 11 Notepad / Notepad3). It is loaded by the server from
`app-packs/examples/` and is a public example - copy `app-packs/templates/`
instead and adapt it to your own software.

## What it shows

- `profile.json` - launch + window identification via a locale-tolerant title
  regex (`(Notepad|记事本|Editor|编辑器)`).
- `controls.json` - multiple selector candidates per logical control
  (`editArea` matches classic Notepad's `Edit`, Windows 11's
  `RichEditD2DPT` Document, and Notepad3's Scintilla Pane).
- `actions.json` - action contracts: `setValue` on `editArea` is idempotent
  and retry-safe; its defaultExpect waits for the edit to exist.
- `workflows.json` - `type_text`: a clipboard-verified typing workflow that
  works on ANY editor, including Scintilla-based ones that expose no
  ValuePattern (typing goes through `type_text`, verification through
  select-all + copy + `read_clipboard`).

## Try it

```
app_pack_list          -> see the notepad pack
app_pack_describe {pack:"notepad"}
workflow_catalog {pack:"notepad"}
run_workflow {pack:"notepad", workflow:"type_text", inputs:{text:"hello"}}
```

The workflow briefly activates the editor window and overwrites the
clipboard (documented in its description).
