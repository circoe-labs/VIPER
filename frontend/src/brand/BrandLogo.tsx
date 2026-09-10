import { useTheme } from '../theme/theme'
import { type LogoVariant, logoSource } from './logos'

interface BrandLogoProps {
  variant: LogoVariant
  // Rendered height; width follows the artwork's aspect ratio.
  height: string
  // Set when visible text already names VIPER, so screen readers do not hear it twice.
  decorative?: boolean
  className?: string
}

// VIPER logo that follows the active theme automatically (see logos.ts for the contrast rule).
export function BrandLogo({ variant, height, decorative = false, className }: BrandLogoProps) {
  const { theme } = useTheme()
  return (
    <img
      src={logoSource(variant, theme)}
      alt={decorative ? '' : 'VIPER'}
      className={className}
      style={{ height, width: 'auto' }}
      draggable={false}
    />
  )
}
