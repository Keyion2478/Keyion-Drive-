export async function getGravatarUrl(email: string | undefined, size: number) {
  const normalized = email?.trim().toLowerCase()
  if (!normalized) return `https://www.gravatar.com/avatar/?d=mp&s=${size}`

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized))
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `https://www.gravatar.com/avatar/${hash}?d=mp&s=${size}`
}
