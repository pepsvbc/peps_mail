"use client";

import { Select as SelectPrimitive } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";

interface SelectFieldProps {
  id: string;
  value: string;
  disabled?: boolean;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
}

/** A themed select whose popup uses the same typography as its trigger. */
export function SelectField({ id, value, disabled, onValueChange, options }: SelectFieldProps) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger id={id} className="flex min-w-0 flex-1 items-center justify-between gap-2 bg-transparent py-2 font-sans text-sm font-normal text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [&>span:first-child]:truncate">
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon><ChevronDown className="size-4 shrink-0 text-muted-foreground" /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={4} className="z-[60] max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border border-border bg-popover p-1 font-sans text-sm font-normal text-popover-foreground shadow-md">
          <SelectPrimitive.Viewport>
            {options.map((option) => (
              <SelectPrimitive.Item key={option.value} value={option.value} className="relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-7 pr-3 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground">
                <SelectPrimitive.ItemIndicator className="absolute left-2"><Check className="size-3.5" /></SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
