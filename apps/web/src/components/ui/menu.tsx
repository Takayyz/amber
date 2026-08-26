import { Menu as MenuPrimitive } from "@base-ui/react/menu"

import { cn } from "@/lib/utils"

function Menu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="menu" {...props} />
}

function MenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="menu-trigger" {...props} />
}

function MenuContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: MenuPrimitive.Popup.Props & { sideOffset?: number }) {
  return (
    <MenuPrimitive.Portal>
      {/* Anchored to the trigger's end, since this hangs off the right of a
          header and would otherwise run past the screen on a phone. */}
      <MenuPrimitive.Positioner sideOffset={sideOffset} align="end">
        <MenuPrimitive.Popup
          data-slot="menu-content"
          className={cn(
            // Just wide enough for the longest label to sit on one line; any
            // more and every row trails off into empty space on its right.
            "z-50 min-w-32 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
            className
          )}
          {...props}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

function MenuItem({
  className,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & { variant?: "default" | "destructive" }) {
  return (
    <MenuPrimitive.Item
      data-slot="menu-item"
      data-variant={variant}
      // Sized against this project's buttons rather than shadcn's defaults:
      // Button is h-8 here where shadcn ships h-9, and its sm is 0.8rem with
      // size-3.5 icons. A menu built to the upstream numbers sat a step
      // larger than everything around it.
      className={cn(
        "flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1 text-[0.8rem] outline-none select-none",
        "data-disabled:pointer-events-none data-disabled:opacity-50",
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground",
        // Icons are muted until the row is highlighted, so a column of them
        // reads as one quiet stripe rather than competing with the labels.
        "[&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground data-highlighted:[&_svg]:text-current",
        variant === "destructive" &&
          "text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive [&_svg]:text-destructive",
        className
      )}
      {...props}
    />
  )
}

// A plain rule rather than a primitive: base-ui has no menu separator, and
// this one is decoration between groups the reader can already see.
function MenuSeparator({ className }: { className?: string }) {
  return <div aria-hidden className={cn("-mx-1 my-1 h-px bg-border", className)} />
}

export { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger }
