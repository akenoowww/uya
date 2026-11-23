export function themeTokens() {
  const style = getComputedStyle(document.documentElement);
  return (name: string) => style.getPropertyValue(`--${name}`).trim();
}
