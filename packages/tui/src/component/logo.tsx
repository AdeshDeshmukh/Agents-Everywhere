import { useTheme } from "../context/theme"
import { WORDMARK } from "../logo"

// A real ASCII-art font (OpenTUI's own `ascii_font` renderable — see
// @opentui/core's lib/ascii.font.ts) instead of hand-drawn block characters.
// The old "opencode" logo was hand-drawn per letter, which is exactly why
// the rebrand couldn't just swap the text: nobody had drawn glyphs for the
// rest of the alphabet. This renders any string.
//
// Font choice: solid filled letters ("block"), not the thinner outline/
// dithered styles ("grid"/"shade") — those read as cluttered at a glance.
// This renders "AgentsEverywhere" at ~175 columns, well past 80, so it needs
// a reasonably wide terminal window to avoid clipping on the right edge.
export function Logo() {
  const { theme } = useTheme()
  return <ascii_font text={WORDMARK} font="block" color={[theme.textMuted, theme.text]} selectable={false} />
}
