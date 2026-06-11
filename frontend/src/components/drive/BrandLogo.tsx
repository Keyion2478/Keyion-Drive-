export function BrandLogo({ className }: { className?: string }) {
  return (
    <img
      src="/logo.png"
      alt="Keyion Drive"
      className={`h-20 w-20 object-contain ${className ?? ''}`}
    />
  )
}