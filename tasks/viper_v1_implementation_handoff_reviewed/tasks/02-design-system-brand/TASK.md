# Task 02 — Implement Neon Command design system and VIPER assets

## Goal
Implement reusable theme tokens, shell primitives and accepted VIPER logo usage for dark/light contrast contexts.

## Context
Neon Command is visual-language authority; accepted geometric Viper/V assets are logo authority. Do not copy security-dashboard content from the board.

## Coding Skill Requirement
Before editing code, load and follow `/caveman` and `/coding-guideline` from `~/ai/skills/`.

## Scope
### In Scope
- Import six accepted logo variants preserving alpha.
- Dark + conservative light theme.
- Color/spacing/radius/border/focus/status tokens.
- Inter typography.
- Base Button/Input/Card/Badge/Table primitives.
- Navigation shell styling and automatic logo-variant switching.

### Out of Scope
- No page-specific business content.
- No new logo direction.
- No heavy glow/animation.

## Dependencies
Task 01.

## Implementation Steps
1. Add assets.
2. Define semantic tokens.
3. Implement theme provider/switch.
4. Build shell/nav/header primitives.
5. Build brand asset helper with mark/lockup contrast rules.
6. Add visual smoke/component examples if tooling supports it.

## Files Likely Touched
Theme CSS/tokens, UI primitives, shell/nav, assets.

## Architecture Constraints
Use semantic tokens rather than scattered hex. Brand green is not a universal success color. Preserve logo alpha.

## Testing Requirements
Contrast/focus checks, theme render smoke, logo file/alpha presence, laptop-width visual smoke.

## Acceptance Criteria
- Neon Command character is recognizable.
- Dark/light coherent.
- All six logo assets usable.
- No moodboard security content leaks into product UI.

## Documentation Updates
Update repo design-system/asset guide.

## Handoff Notes
Global visual reference: `../../visuals/neon-command-brand-direction.png` and `../../visuals/viper-*` files.
