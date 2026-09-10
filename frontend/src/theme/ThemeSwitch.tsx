import { IconButton } from '../ui/Button'
import { MoonIcon, SunIcon } from '../ui/icons'
import { useTheme } from './theme'

// Toggles dark/light; the icon and label describe the theme the click will switch TO.
export function ThemeSwitch() {
  const { theme, setTheme } = useTheme()
  const toLight = theme === 'dark'
  return (
    <IconButton
      icon={toLight ? SunIcon : MoonIcon}
      label={toLight ? 'Passer au thème clair' : 'Passer au thème sombre'}
      onClick={() => {
        setTheme(toLight ? 'light' : 'dark')
      }}
    />
  )
}
