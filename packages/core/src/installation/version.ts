declare global {
  const AGENTS_EVERYWHERE_VERSION: string
  const AGENTS_EVERYWHERE_CHANNEL: string
}

export const InstallationVersion = typeof AGENTS_EVERYWHERE_VERSION === "string" ? AGENTS_EVERYWHERE_VERSION : "local"
export const InstallationChannel = typeof AGENTS_EVERYWHERE_CHANNEL === "string" ? AGENTS_EVERYWHERE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
