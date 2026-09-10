// Neon Command line icons: 24 px grid, 1.75 stroke, round caps/joins, currentColor. Decorative by default
// (aria-hidden) — the accessible name always comes from adjacent text or the owning control's label.
import type { ComponentType, ReactNode, SVGProps } from 'react'

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number }
export type IconComponent = ComponentType<IconProps>

function Svg({ size = 20, children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  )
}

// Navigation
export const HomeIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M3.5 10.5 12 3.5l8.5 7" />
    <path d="M5.5 9v11h13V9" />
    <path d="M10 20v-5.5h4V20" />
  </Svg>
)

export const UsersIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5" />
    <path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4" />
    <path d="M18 14c2.1.8 3.5 3 3.5 6" />
  </Svg>
)

export const BoltIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M13 2.5 4.5 13.5H12l-1 8 8.5-11H12z" />
  </Svg>
)

export const DatabaseIcon = (props: IconProps) => (
  <Svg {...props}>
    <ellipse cx="12" cy="5.5" rx="7.5" ry="2.5" />
    <path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13" />
    <path d="M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5" />
  </Svg>
)

export const SlidersIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 7h9M18 7h2M4 17h2M11 17h9" />
    <circle cx="15.5" cy="7" r="2.5" />
    <circle cx="8.5" cy="17" r="2.5" />
  </Svg>
)

// Status
export const CheckCircleIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8 12.5 2.8 2.8L16.5 9.5" />
  </Svg>
)

export const AlertIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" />
    <path d="M12 9.5v4" />
    <path d="M12 17h.01" />
  </Svg>
)

export const BanIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="m5.7 5.7 12.6 12.6" />
  </Svg>
)

export const InfoIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5" />
    <path d="M12 7.5h.01" />
  </Svg>
)

export const ClockIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.5 2" />
  </Svg>
)

export const MinusCircleIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12h8" />
  </Svg>
)

// Interface
export const SunIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
  </Svg>
)

export const MoonIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" />
  </Svg>
)

export const PanelLeftIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M9.5 4v16" />
  </Svg>
)

export const LogOutIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M9.5 20.5H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h3.5" />
    <path d="M15.5 16.5 20 12l-4.5-4.5" />
    <path d="M20 12H9.5" />
  </Svg>
)

export const CloseIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
)

export const PlusIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

export const SpinnerIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="9" opacity="0.25" />
    <path d="M21 12a9 9 0 0 0-9-9" />
  </Svg>
)

// Data / explorer
export const SearchIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.4-4.4" />
  </Svg>
)

export const RefreshIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M20 11.5A8 8 0 0 0 5.6 7M4 12.5A8 8 0 0 0 18.4 17" />
    <path d="M5 3.5V7.5h4M19 20.5v-4h-4" />
  </Svg>
)

export const DownloadIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" />
    <path d="M4.5 19.5h15" />
  </Svg>
)

export const FilterIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 5.5h16l-6.2 7.3v5.4l-3.6 1.8v-7.2z" />
  </Svg>
)

export const KeyIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="8" cy="15" r="4" />
    <path d="m10.9 12.1 8.6-8.6M16.5 6.5l2.5 2.5M14 9l2 2" />
  </Svg>
)

export const LinkIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M9 15 19 5M11 5h8v8" />
    <path d="M17 15.5V19H5V7h3.5" />
  </Svg>
)

export const ArrowUpIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
)

export const ArrowDownIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Svg>
)

export const ArrowLeftIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Svg>
)

export const ChevronLeftIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="m14.5 6-6 6 6 6" />
  </Svg>
)

export const ChevronRightIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="m9.5 6 6 6-6 6" />
  </Svg>
)

export const ColumnsIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <path d="M9.2 4.5v15M14.8 4.5v15" />
  </Svg>
)

export const PinIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M9 3.5h6M10 3.5v5.2L7 12.5h10l-3-3.8V3.5M12 12.5v8" />
  </Svg>
)

export const MoreIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M5.5 12h.01M12 12h.01M18.5 12h.01" strokeWidth={2.75} />
  </Svg>
)

export const CopyIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
    <path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
  </Svg>
)

export const ExpandIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M14 4.5h5.5V10M10 19.5H4.5V14M19.5 4.5 13.5 10.5M4.5 19.5l6-6" />
  </Svg>
)

// Editing
export const PencilIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M15.5 5.5 18.5 8.5M4.5 19.5l1-4.2L16.3 4.5a1.4 1.4 0 0 1 2 0l1.2 1.2a1.4 1.4 0 0 1 0 2L8.7 18.5z" />
  </Svg>
)

export const TrashIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12.5h9.4L17.5 7" />
    <path d="M10 11v5M14 11v5" />
  </Svg>
)

export const UndoIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M9 14.5 4.5 10 9 5.5" />
    <path d="M4.5 10h9.5a5.5 5.5 0 0 1 0 11h-3" />
  </Svg>
)

export const LockIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="5" y="10.5" width="14" height="10" rx="2" />
    <path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3" />
  </Svg>
)

export const SaveIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M5.5 4.5h10l3 3v12h-13z" />
    <path d="M8.5 4.5v4h6v-4M8.5 19.5v-5h7v5" />
  </Svg>
)

export const TableIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10" />
  </Svg>
)
