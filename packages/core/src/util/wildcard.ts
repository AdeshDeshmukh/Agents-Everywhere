export * as Wildcard from "./wildcard"

export function match(input: string, pattern: string) {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  // macOS filesystems are case-insensitive by default, so a case-sensitive
  // match there lets `/Users/x/SRC/secret` slip past a rule written for
  // `src/*` while still resolving to the same file.
  const insensitive = process.platform === "win32" || process.platform === "darwin"
  return new RegExp("^" + escaped + "$", insensitive ? "si" : "s").test(normalized)
}
