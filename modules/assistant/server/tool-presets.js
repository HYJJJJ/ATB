import {createRequire} from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url);
export function browserPreset(){
  return {id:'browser',label:'浏览器 · Playwright',enabled:true,transport:'stdio',command:path.join(path.dirname(require.resolve('node/package.json')),'bin',process.platform==='win32'?'node.exe':'node'),args:[path.join(path.dirname(require.resolve('@playwright/mcp/package.json')),'cli.js'),'--headless','--isolated','--browser','msedge','--block-service-workers','--no-webmcp'],env:{},allowedTools:['browser_navigate','browser_snapshot','browser_tabs','browser_close','browser_wait_for']};
}
