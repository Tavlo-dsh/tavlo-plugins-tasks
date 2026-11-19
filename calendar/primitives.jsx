import * as React from 'react'
import * as RadixPopover from '@radix-ui/react-popover'
export { clsx as cn } from 'clsx'

export const PortalHost = React.createContext(null)
export const Popover = RadixPopover.Root
export const PopoverAnchor = RadixPopover.Anchor
export const PopoverTrigger = RadixPopover.Trigger
export function PopoverContent({ tilt, children, ...props }) {
  const host = React.useContext(PortalHost)
  return <RadixPopover.Portal container={host.current?.closest('.dsh-tasks-drawer')}>
    <RadixPopover.Content {...props} className="dsh-tasks-date-popup">{children}</RadixPopover.Content>
  </RadixPopover.Portal>
}

export const InputControl = React.forwardRef((props, ref) => <input {...props} ref={ref} />)
export const Paper = React.forwardRef(({ children, ...props }, ref) => <div {...props} ref={ref}>{children}</div>)
export const Button = React.forwardRef(({ asChild, variant, size, children, ...props }, ref) => asChild
  ? React.cloneElement(React.Children.only(children), { ...props, className: children.props.className, ref })
  : <button type="button" {...props} ref={ref}>{children}</button>)

export function Icon({ name, size = 16 }) {
  const paths = { calendar: 'M4 5h16v15H4zM4 10h16M8 3v4m8-4v4', 'chevron-left': 'm14 6-6 6 6 6', 'chevron-right': 'm10 6 6 6-6 6', 'chevron-down': 'm6 9 6 6 6-6', 'chevron-up': 'm6 15 6-6 6 6' }
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>
}
