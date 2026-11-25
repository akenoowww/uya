import antigravityIconUrl from "../assets/icons/provider-antigravity.svg";
import claudeIconUrl from "../assets/icons/provider-claude.png";
import codexIconUrl from "../assets/icons/provider-codex.png";
import customIconUrl from "../assets/icons/provider-custom.png";
import geminiIconUrl from "../assets/icons/provider-gemini.png";
import kimiIconUrl from "../assets/icons/provider-kimi.png";
import llamaCppIconUrl from "../assets/icons/provider-llamacpp.png";
import lmStudioIconUrl from "../assets/icons/provider-lmstudio.png";
import mlxIconUrl from "../assets/icons/provider-mlx.png";
import ollamaIconUrl from "../assets/icons/provider-ollama.png";
import openCodeIconUrl from "../assets/icons/provider-opencode.png";
import qwenIconUrl from "../assets/icons/provider-qwen.png";
import uyaMarkUrl from "../assets/uya-mark.png";

const PROVIDER_ICONS: ReadonlyMap<string, string> = new Map([
  ["antigravity", antigravityIconUrl],
  ["claude", claudeIconUrl],
  ["codex", codexIconUrl],
  ["custom", customIconUrl],
  ["gemini", geminiIconUrl],
  ["gemini-api", geminiIconUrl],
  ["kimi", kimiIconUrl],
  ["llamacpp", llamaCppIconUrl],
  ["lmstudio", lmStudioIconUrl],
  ["mlx", mlxIconUrl],
  ["ollama", ollamaIconUrl],
  ["opencode", openCodeIconUrl],
  ["qwen", qwenIconUrl],
]);

const PROVIDER_ICON_STYLES = `
  .provider-icon {
    display: inline-block;
    flex: none;
    object-fit: contain;
    vertical-align: middle;
  }

  .provider-icon--framed {
    box-sizing: content-box;
    min-width: var(--provider-emblem-size, 0px);
    min-height: var(--provider-emblem-size, 0px);
    padding: var(--provider-emblem-padding, 3px);
    border: 1px solid var(--border, #2f323d);
    border-radius: 25%;
    background: var(--surface, #21232b);
  }

  .empty-emblem:has(> .provider-icon--framed) {
    /* Size the RunPane emblem in layout instead of scaling its raster image. */
    transform: none;
    --provider-emblem-size: 36px;
    --provider-emblem-padding: 5px;
  }
`;

export function ProviderIcon({
  providerId,
  size = 14,
  framed = true,
}: {
  providerId?: string;
  size?: number;
  framed?: boolean;
}) {
  const src = PROVIDER_ICONS.get(providerId ?? "custom") ?? customIconUrl;

  return (
    <>
      <style href="uya-provider-icon" precedence="default">{PROVIDER_ICON_STYLES}</style>
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className={framed ? "provider-icon provider-icon--framed" : "provider-icon"}
        draggable={false}
        aria-hidden="true"
      />
    </>
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
