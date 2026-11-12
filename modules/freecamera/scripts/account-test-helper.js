export const testCredentials = { username: 'admin', password: 'test-camera-password' };
export async function loginViewer(page, credentials = testCredentials) {
  if (new URL(page.url()).pathname === '/platform') await page.goto(new URL('/?mode=viewer', page.url()).href);
  await page.waitForFunction(() => document.querySelector('#auth-submit') && !document.querySelector('#auth-submit').disabled || !document.querySelector('#account-bar')?.hidden);
  if (await page.locator('#account-bar').evaluate(bar => !bar.hidden)) {
    await page.locator('#pairing-options').evaluate(details => { details.open = true; }); return;
  }
  await page.locator('#auth-username').fill(credentials.username);
  await page.locator('#auth-password').fill(credentials.password);
  if (await page.locator('#auth-confirm').isVisible()) await page.locator('#auth-confirm').fill(credentials.password);
  await page.locator('#auth-submit').click();
  await page.waitForFunction(() => !document.querySelector('#account-bar').hidden);
  await page.locator('#pairing-options').evaluate(details => { details.open = true; });
}
