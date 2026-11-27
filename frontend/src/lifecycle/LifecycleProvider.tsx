import { type ReactNode, useState } from 'react'

import { type LifecycleRequest, LifecycleHostContext } from './host'
import { LifecycleDialog } from './LifecycleDialog'

export function LifecycleProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<LifecycleRequest | null>(null)
  return (
    <LifecycleHostContext.Provider value={setRequest}>
      {children}
      {request && (
        <LifecycleDialog
          key={`${request.subject.id}-${request.intent}`}
          subject={request.subject}
          intent={request.intent}
          onChanged={request.onChanged}
          onClose={() => {
            setRequest(null)
          }}
        />
      )}
    </LifecycleHostContext.Provider>
  )
}
