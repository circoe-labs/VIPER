import { useState } from 'react'

import './entityLogo.css'

// Logo of the company concerned (also for one of its employees): the favicon of its own website, falling back to the
// initials when there is no domain or the site has no icon. No third-party service is called.
export function EntityLogo({ name, domain }: { name: string; domain?: string | null }) {
  const [failed, setFailed] = useState(false)
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join('')
  return (
    <span className="entity-logo" aria-hidden="true">
      {domain && !failed ? (
        <img
          src={`https://${domain}/favicon.ico`}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => {
            setFailed(true)
          }}
        />
      ) : (
        initials
      )}
    </span>
  )
}
