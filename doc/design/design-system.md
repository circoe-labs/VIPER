# Design System — Neon Command

## Authoritative visual reference
`../visuals/neon-command-brand-direction.png`

**Important:** this board is authoritative for visual language only — palette, contrast, surfaces, spacing, typography, line-icon style and restrained glow. Its cyber-security copy, threat metrics, world map and illustrated snake logo are **not VIPER product requirements** and must not be reproduced.

The actual product identity is the accepted geometric V/viper logo family under `../visuals/viper-*`.

## Brand character
Modern AI/tech, premium, controlled, spacious, dark-first. Clean rather than gamer-like. Neon is a signal, not wallpaper.

## Core tokens
| Token | Hex | Use |
|---|---|---|
| Void | `#0A0B0D` | deepest app canvas |
| Charcoal | `#1B2329` | panels/sidebar/surfaces |
| Slate | `#2E3A40` | borders/muted UI |
| Viper Green | `#00E676` | primary accent/focus/active brand moments |
| Teal | `#00C2B8` | secondary accent/data highlights |
| Ice | `#EAF2F1` | primary dark-theme text/icons |
| Deep Emerald | `#10261F` | tinted surfaces/subtle gradients/glows |

Reserve yellow/orange for verification warnings, red for destructive/error/do-not-contact signals where appropriate. Brand green must not be the only indicator of verified/success state.

## Typography
Inter as primary UI typeface reference. Clear hierarchy; avoid excessive all-caps outside labels/brand microcopy.

## Density/shape
Generous page padding, medium radii, thin slate borders, minimal shadows, no pill-everything, restrained glow. Database tables can be denser than Prospection but must remain legible.

## Icon style
Minimal geometric line icons, consistent stroke and slightly rounded forms. Use filled status glyphs sparingly.

## Theme behavior
Dark is the primary authored theme. Light theme is a semantic derivation using off-white canvas/light surfaces/dark slate text and the same green/teal accents. Do not invent a second visual identity.

## VIPER logo usage
- `viper-mark-black.png`: icon-only for light backgrounds.
- `viper-lockup-black.png`: icon + VIPER wordmark for light branding areas.
- `viper-mark-white.png`: icon-only for dark backgrounds.
- `viper-lockup-white.png`: icon + wordmark for dark branding areas.
- `viper-mark-black-neon-green.png`: dark mark with neon details for premium/hero accents.
- `viper-mark-neon-green-black.png`: neon-dominant mark with black details for high-contrast accent usage.

Use mark-only for collapsed sidebar/favicon/small icon contexts; use lockup in full sidebar/login/about contexts. Preserve alpha; never bake a rectangle behind the assets.
