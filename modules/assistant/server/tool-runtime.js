import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
export function nodeRuntime(){return path.join(path.dirname(require.resolve('node/package.json')),'bin',process.platform==='win32'?'node.exe':'node');}
export function toolCommand(server){
  const name=server.command.toLowerCase();
  const runtime=nodeRuntime(),env={...server.env};
  env.PATH=path.dirname(runtime)+path.delimiter+(env.PATH||process.env.PATH||'');
  if(['node','node.exe'].includes(name))return{command:runtime,args:server.args,env};
  if(['npm','npx','npm.cmd','npx.cmd'].includes(name))return{command:runtime,args:[path.join(path.dirname(require.resolve('npm/package.json')),'bin',name.startsWith('npx')?'npx-cli.js':'npm-cli.js'),...server.args],env};
  return{command:server.command,args:server.args,env};
}
