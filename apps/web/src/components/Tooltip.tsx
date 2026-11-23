import type { ReactNode } from "react";
import { Group, Kbd, Tooltip } from "@mantine/core";
import type { FloatingPosition } from "@mantine/core";

export function HintTooltip({
  label,
  shortcut,
  side = "bottom",
  children,
}: {
  label: string;
  shortcut?: string;
  side?: FloatingPosition;
  children: ReactNode;
}) {
  return (
    <Tooltip
      position={side}
      label={
        <Group gap={6} wrap="nowrap">
          <span>{label}</span>
          {shortcut && <Kbd>{shortcut}</Kbd>}
        </Group>
      }
    >
      <span className="tooltip-trigger-wrap">{children}</span>
    </Tooltip>
  );
}
