import { type ComponentProps, type ReactNode, useId } from 'react'

import { AlertIcon } from './icons'
import './fields.css'

interface FieldProps {
  label: string
  hint?: ReactNode
  error?: ReactNode
  // Non-blocking remark (a value to double-check); shown with a warning glyph, never instead of an error.
  warning?: ReactNode
}

export interface ControlA11y {
  id: string
  'aria-invalid': true | undefined
  'aria-describedby': string | undefined
}

// Shared frame: visible label bound to the control, hint, error and warning linked through aria-describedby.
// Error and warning carry an icon and text — never colour alone. Exported for composite controls (Combobox).
export function FieldFrame({
  label,
  hint,
  error,
  warning,
  id: providedId,
  required,
  describedBy,
  children,
}: FieldProps & {
  id?: string
  required?: boolean
  describedBy?: string
  children: (a11y: ControlA11y) => ReactNode
}) {
  const generatedId = useId()
  const id = providedId ?? generatedId
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const warningId = warning && !error ? `${id}-warning` : undefined
  const describedByIds = [describedBy, hintId, errorId, warningId].filter(Boolean).join(' ') || undefined
  return (
    <div className="field" data-invalid={error ? '' : undefined} data-warning={warningId ? '' : undefined}>
      <label className="field__label" htmlFor={id}>
        {label}
        {required && (
          <span className="field__required" aria-hidden="true">
            {' *'}
          </span>
        )}
      </label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedByIds })}
      {hint && (
        <p id={hintId} className="field__hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="field__error">
          <AlertIcon size={16} />
          {error}
        </p>
      )}
      {warningId && (
        <p id={warningId} className="field__warning">
          <AlertIcon size={16} />
          {warning}
        </p>
      )}
    </div>
  )
}

export type TextFieldProps = FieldProps & Omit<ComponentProps<'input'>, 'aria-invalid'>

export function TextField({ label, hint, error, warning, id, required, className, ...props }: TextFieldProps) {
  const frame = { label, hint, error, warning, id, required, describedBy: props['aria-describedby'] }
  return (
    <FieldFrame {...frame}>
      {(a11y) => (
        <input {...props} {...a11y} className={controlClass('', className)} required={required} />
      )}
    </FieldFrame>
  )
}

export type TextAreaFieldProps = FieldProps & Omit<ComponentProps<'textarea'>, 'aria-invalid'>

export function TextAreaField({ label, hint, error, warning, id, required, className, ...props }: TextAreaFieldProps) {
  const frame = { label, hint, error, warning, id, required, describedBy: props['aria-describedby'] }
  return (
    <FieldFrame {...frame}>
      {(a11y) => (
        <textarea {...props} {...a11y} className={controlClass('multiline', className)} required={required} />
      )}
    </FieldFrame>
  )
}

export type SelectFieldProps = FieldProps & Omit<ComponentProps<'select'>, 'aria-invalid'>

export function SelectField({ label, hint, error, warning, id, required, className, ...props }: SelectFieldProps) {
  const frame = { label, hint, error, warning, id, required, describedBy: props['aria-describedby'] }
  return (
    <FieldFrame {...frame}>
      {(a11y) => (
        <select {...props} {...a11y} className={controlClass('select', className)} required={required} />
      )}
    </FieldFrame>
  )
}

function controlClass(modifier: '' | 'multiline' | 'select', className?: string) {
  return ['field__control', modifier && `field__control--${modifier}`, className].filter(Boolean).join(' ')
}

export type CheckboxProps = Omit<ComponentProps<'input'>, 'type'> & { label: string; hint?: ReactNode }

function Toggle({ label, hint, id, className, kind, ...props }: CheckboxProps & { kind: 'checkbox' | 'switch' }) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const hintId = hint ? `${inputId}-hint` : undefined
  return (
    <div className={['toggle', `toggle--${kind}`, className].filter(Boolean).join(' ')}>
      <input
        id={inputId}
        type="checkbox"
        role={kind === 'switch' ? 'switch' : undefined}
        className="toggle__input"
        aria-describedby={hintId}
        {...props}
      />
      <label className="toggle__label" htmlFor={inputId}>
        {label}
      </label>
      {hint && (
        <p id={hintId} className="toggle__hint">
          {hint}
        </p>
      )}
    </div>
  )
}

export function Checkbox(props: CheckboxProps) {
  return <Toggle kind="checkbox" {...props} />
}

// Binary setting that applies immediately (role="switch"); use Checkbox for form values submitted later.
export function Switch(props: CheckboxProps) {
  return <Toggle kind="switch" {...props} />
}
