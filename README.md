<h1 align="center">✍️ WH Editor</h1>

<p align="center">
A SillyTavern extension that fixes the lines models keep writing: stock phrases, "not X, but Y" framing, chopped dialogue and the rest.<br>
It rewrites only the lines it flags, and one tap brings the original back.
</p>

It started as part of the [Worldhopper Engine](https://github.com/Coz-rp/SillyTavern-Worldhopper) and works with it, but it doesn't need it: any preset, any character, Chat Completion or Text Completion.

> ⚡ **Keep it fast and cheap.** Give the Editor its own model, separate from the one you roleplay with. It only ever sees a few flagged lines, so a local model (KoboldCpp, Ollama and the like) or a cheap, fast API model from the Flash, Haiku or mini tier does it well and costs next to nothing.

## ✨ How it works

After each reply, a quick rule pass (instant, no model) flags suspect lines. Most replies come back with nothing flagged. When something is, the model you picked rewrites **only those lines**; nothing else in the reply changes.

Rewrites are checked before they're used. One is refused if it would:

- add content the line didn't have;
- bring in another stock phrase;
- leave a sentence cut off.

⟲ in a message's menu switches between the original and the fixed version.

| Check | What it catches |
|---|---|
| Stock phrases | Common model tells and stock phrasing ("a muscle ticks in her jaw") |
| Not X, but Y | "Not a threat, but a promise" framing |
| Chopped dialogue | Dialogue broken into staccato fragments |
| Fragments | Narration in sentence fragments |
| Hedges | Referent hedges like "your — her — hand" (fixed without a model) |
| Echoing you | Speech that parrots your words back |
| Repeats | Phrases repeated from recent replies |

Add your own phrases to the **slop list**, one per line, and the Editor fixes them every time they show up.

It never touches HTML, code, out-of-character text (`((OOC: …))`, whole lines in `[brackets]`), or the Worldhopper Engine's moment markers. Replies that read like notes or lists rather than roleplay are left alone.

## 🚀 Install

1. In SillyTavern, open **Extensions**, choose **Install extension**, and paste `https://github.com/Coz-rp/SillyTavern-WH-Editor`.
2. Open **Extensions → WH Editor** and pick a connection profile under **Model**. (No profiles yet? Save one in the plug menu under Connection Profile first.)

That's it: the next reply gets checked.

## ⚙️ Settings

| Setting | What it does | Default |
|---|---|---|
| Switch in the heading | Turns the Editor on or off. Off, replies come through untouched; ⟲ still works on ones it already fixed | On |
| Editor model | The connection profile that rewrites flagged lines | (pick one) |
| What it fixes | The checks in the table above, each switchable | All on |
| Slop list | Phrases it always fixes, one per line; `#` starts a comment | Empty |
| Run on last reply | Runs it now, even while it's off | (button) |

`/wh-edit` runs it on the last reply, or on a message id (`/wh-edit 42`).

## 🌀 With the Worldhopper Engine

The Engine runs two checks of its own on a reply while someone is in another body: pronouns, and its body rules. On a reply both touch, the Engine waits for the Editor to finish first, and the two keep one record, so ⟲ takes the reply all the way back to the original.

If you used the Editor while it was part of the Engine, your settings and slop list carry over the first time this loads.

## 🔒 Privacy

When a reply has flagged lines, the Editor sends that reply, with the flagged lines marked, to the connection profile you pick. A reply with nothing flagged is never sent. Nothing else leaves your SillyTavern, and there's no telemetry.

## 💜 Credits

WH Editor by Coz, built with Claude. The Worldhopper presets and the Engine are on [coz-rp.github.io](https://coz-rp.github.io/).
