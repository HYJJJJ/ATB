export function desktopAvailable() { return Boolean(window.atbDesktop?.isDesktop && typeof window.atbDesktop.invokeModule === 'function'); }
export async function invokeRustDesk(action, options = {}) {
  if (!desktopAvailable()) throw Error('请在 ATB Windows 桌面版中使用客户端启动功能');
  const result = await window.atbDesktop.invokeModule('rustdesk', action, options);
  if (result?.error && !result.launched) throw Error(result.error);
  return result;
}
