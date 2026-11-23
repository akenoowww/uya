import { createTheme } from "@mantine/core";
import type { MantineColorsTuple } from "@mantine/core";

const obsidian: MantineColorsTuple = [
  "#eceef4", // 0: primary text
  "#c6cad8", // 1: secondary text
  "#9ea2b2", // 2: muted text
  "#7d8294", // 3: quiet text
  "#454857", // 4: border hover
  "#2f323d", // 5: border
  "#22242c", // 6: control surface
  "#191a20", // 7: panel / card surface
  "#15161b", // 8: deep surface
  "#111216", // 9: deepest background
];

const iris: MantineColorsTuple = [
  "#f4f1ff",
  "#e4ddff",
  "#cfc2ff",
  "#b4a2ff",
  "#9c85fa",
  "#8468f2",
  "#6e52e0",
  "#573ec4",
  "#44309e",
  "#322375",
];

export const uyaTheme = createTheme({
  primaryColor: "iris",
  primaryShade: { dark: 3, light: 5 },
  defaultRadius: "sm",
  cursorType: "pointer",
  fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace',
  fontSizes: {
    xs: "11px",
    sm: "12px",
    md: "13px",
    lg: "15px",
    xl: "17px",
  },
  colors: {
    dark: obsidian,
    iris,
  },
  components: {
    Button: {
      defaultProps: {
        size: "xs",
        radius: "sm",
      },
      styles: {
        root: {
          fontWeight: 560,
        },
      },
    },
    ActionIcon: {
      defaultProps: {
        size: "sm",
        radius: "sm",
        variant: "subtle",
        color: "gray",
      },
    },
    Tooltip: {
      defaultProps: {
        openDelay: 360,
        closeDelay: 80,
        withArrow: false,
        offset: 6,
      },
      styles: {
        tooltip: {
          backgroundColor: "#20222b",
          border: "1px solid #3d4052",
          color: "#eceef4",
          fontSize: "11px",
          padding: "5px 8px",
          boxShadow: "0 10px 26px rgba(0, 0, 0, 0.52)",
        },
      },
    },
    Kbd: {
      defaultProps: {
        size: "xs",
      },
      styles: {
        root: {
          backgroundColor: "#22242e",
          borderColor: "#3a3d4c",
          color: "#c5c9d8",
          fontSize: "10px",
          padding: "1px 5px",
          lineHeight: 1.25,
        },
      },
    },
    Modal: {
      defaultProps: {
        centered: true,
        radius: "md",
        overlayProps: {
          backgroundOpacity: 0.65,
          blur: 3,
        },
      },
      styles: {
        content: {
          backgroundColor: "#1b1c24",
          border: "1px solid #414355",
          boxShadow: "0 22px 60px rgba(0, 0, 0, 0.7)",
        },
        header: {
          backgroundColor: "#1b1c24",
          borderBottom: "1px solid #272933",
          padding: "14px 16px",
        },
        title: {
          fontSize: "15px",
          fontWeight: 640,
        },
      },
    },
    Popover: {
      defaultProps: {
        radius: "md",
        shadow: "lg",
      },
      styles: {
        dropdown: {
          backgroundColor: "#1b1d25",
          border: "1px solid #3c3f50",
        },
      },
    },
    Select: {
      defaultProps: {
        size: "xs",
        radius: "sm",
        allowDeselect: false,
        checkIconPosition: "right",
      },
      styles: {
        dropdown: {
          backgroundColor: "#1b1d25",
          border: "1px solid #3c3f50",
        },
      },
    },
    Tabs: {
      defaultProps: {
        color: "iris",
      },
    },
  },
});
