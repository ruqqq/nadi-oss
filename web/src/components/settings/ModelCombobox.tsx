import { useState } from "react";
import { CaretDown } from "@/icons";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { ProviderModelSearchResult, SettingsProvider } from "@/settings-api";
import { ModelSearchCommand } from "@/components/model/ModelSearchCommand";

/**
 * Field-style model picker for a single, already-chosen provider. Used in the
 * onboarding flow where the provider is fixed. The composer and Settings use
 * the two-step ModelPicker instead.
 */
export function ModelCombobox({
  provider,
  value,
  onChange,
  onModelSelected,
  placeholder,
  disabled,
  inputId,
}: {
  provider: SettingsProvider;
  value: string;
  onChange: (value: string) => void;
  onModelSelected?: (model: ProviderModelSearchResult) => void;
  placeholder: string;
  disabled?: boolean;
  inputId?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-10 w-full justify-between px-3 font-normal"
          disabled={disabled}
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {value || placeholder}
          </span>
          <CaretDown className="size-4 shrink-0 opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        {open && (
          <ModelSearchCommand
            key={provider}
            provider={provider}
            initialQuery={value}
            placeholder={placeholder}
            inputId={inputId}
            autoFocusInput
            onQueryChange={onChange}
            onSelect={(model) => {
              onChange(model.id);
              onModelSelected?.(model);
              setOpen(false);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
