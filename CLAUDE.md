# NanoGig: working rules

## UI

- **No layout shifts from messages.** Anything that can appear and disappear on its own (loading, "turn it on",
  a validation problem, the pedal's answer, a Retry button) has its space reserved: the line is always in the
  layout and only its text / tone changes (`setMsg` and `.ed-msg` in `src/ui/editor-view.ts`); a button that comes
  with a message is hidden with `visibility`, not `display`. Content that only exists after a read goes at the
  bottom of its sheet, and sheets are anchored at the top so growth goes downward. Changes the user asks for
  (opening a row, a chooser) may move things.
