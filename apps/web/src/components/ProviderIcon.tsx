import { TerminalWindow } from "@phosphor-icons/react";
import uyaMarkUrl from "../assets/uya-mark.png";
import codexIconUrl from "../assets/icons/provider-codex.png";
import claudeIconUrl from "../assets/icons/provider-claude.png";
import geminiIconUrl from "../assets/icons/provider-gemini.png";
import localIconUrl from "../assets/icons/provider-local.png";

const GENERATED_PROVIDER_ICONS: Readonly<Record<string, string>> = {
  codex: codexIconUrl,
  claude: claudeIconUrl,
  gemini: geminiIconUrl,
  ollama: localIconUrl,
  llamacpp: localIconUrl,
  mlx: localIconUrl,
  lmstudio: localIconUrl,
};

interface ProviderStyle {
  accent: string;
  surface: string;
  border: string;
}

const PROVIDER_STYLES: Readonly<Record<string, ProviderStyle>> = {
  qwen: { accent: "#b7a3ff", surface: "#211d32", border: "#3a3258" },
  opencode: { accent: "#82d4e8", surface: "#17242a", border: "#28414b" },
  kimi: { accent: "#93c5fd", surface: "#182334", border: "#2c3f5e" },
};

const DEFAULT_STYLE: ProviderStyle = { accent: "#c4b6ff", surface: "#242131", border: "#3c3652" };

function FallbackGlyph({ id, size }: { id: string; size: number }) {
  switch (id) {
    case "qwen":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 3.4L19.4 7.7V16.3L12 20.6L4.6 16.3V7.7L12 3.4Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M12 8.2L15.4 12L12 15.8L8.6 12L12 8.2Z" fill="currentColor" />
          <path d="M14.5 14.5L18.5 18.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        </svg>
      );
    case "opencode":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="4" y="4" width="16" height="16" rx="3.5" stroke="currentColor" strokeWidth="1.85" />
          <rect x="8.5" y="8.5" width="7" height="7" rx="1.2" fill="currentColor" />
        </svg>
      );
    case "kimi":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M7 4.5V19.5M7 12L16.5 4.8M10.5 9.5L17.5 19.5" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return <TerminalWindow size={size} weight="duotone" aria-hidden="true" />;
  }
}

export function ProviderIcon({
  providerId,
  size = 14,
  framed = true,
}: {
  providerId?: string;
  size?: number;
  framed?: boolean;
}) {
  const id = providerId ?? "";
  const generatedSrc = GENERATED_PROVIDER_ICONS[id];
  if (generatedSrc) {
    const dim = framed ? Math.max(22, size + 8) : Math.max(15, size + 3);
    return (
      <img
        src={generatedSrc}
        alt=""
        width={dim}
        height={dim}
        className="provider-generated-img"
        draggable={false}
        aria-hidden="true"
      />
    );
  }

  const style = PROVIDER_STYLES[id] ?? DEFAULT_STYLE;
  if (!framed) {
    return (
      <span className="provider-glyph-inline" style={{ color: style.accent }}>
        <FallbackGlyph id={id} size={size} />
      </span>
    );
  }
  return (
    <span
      className="provider-badge-icon"
      style={{
        color: style.accent,
        background: style.surface,
        borderColor: style.border,
      }}
      aria-hidden="true"
    >
      <FallbackGlyph id={id} size={size} />
    </span>
  );
}

export function UyaBrandMark({ size = 28 }: { size?: number }) {
  return (
    <img
      src={uyaMarkUrl}
      alt=""
      width={size}
      height={size}
      className="brand-image"
      draggable={false}
    />
  );
}
