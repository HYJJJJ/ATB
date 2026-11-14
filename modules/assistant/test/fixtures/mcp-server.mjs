import readline from 'node:readline';
import {writeFileSync} from 'node:fs';
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{const message=JSON.parse(line);if(message.id===undefined)return;let result;
  if(message.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'ATB test fixture',version:'1'}};
  else if(message.method==='tools/list')result={tools:[{name:'multiply',description:'Multiply two numbers',inputSchema:{type:'object',properties:{a:{type:'number'},b:{type:'number'}},required:['a','b']}},{name:'structured',inputSchema:{type:'object',properties:{}}},{name:'hold',inputSchema:{type:'object',properties:{}}}]};
  else if(message.method==='tools/call'){
    if(message.params.name==='hold'){writeFileSync(process.env.TEST_MARKER+'.started','started');setTimeout(()=>{writeFileSync(process.env.TEST_MARKER,'late effect');process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:'late'}]}})+'\n');},1000);return;}
    result=message.params.name==='structured'?{content:[],structuredContent:{answer:42,node:process.version}}:{content:[{type:'text',text:String(message.params.arguments.a*message.params.arguments.b)}]};
  }
  else if(message.method==='ping')result={};
  else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Unknown method'}})+'\n');return;}
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n');
});
