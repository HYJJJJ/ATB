import {randomUUID} from 'node:crypto';

// Some compatible gateways expose the model's DSML packet in content instead
// of translating it into tool_calls. Accept a complete packet only, and only
// for these readonly tools in the current offered catalog. Never evaluate text.
const readonly = new Set(['web_search','read_webpage','weather','news','current_time','api_balance']);
export function readDsmlCalls(content, definitions = []) {
  if (typeof content !== 'string' || content.length > 16000) return null;
  // A short unformatted lead-in ("我查一下") is common. Code fences,
  // quoted examples, trailing prose and nested packets remain non-executable.
  const packet = /^(?:[^<>`“”"｜|]{0,200})<[|｜]+DSML[|｜]+\s*calls\s*>([\s\S]*)<\/[|｜]+DSML[|｜]+\s*calls\s*>$/.exec(content.trim());
  if (!packet) return null;
  const body=packet[1], calls=[];let at=0;
  const take = pattern => { pattern.lastIndex=at;const match=pattern.exec(body);if(match)at=pattern.lastIndex;return match; };
  const whitespace = () => {take(/\s*/y);};
  whitespace();
  while(at<body.length) {
    if(calls.length>=6)return null;
    const invoke=take(/<[|｜]+DSML[|｜]+\s*invoke\s+name="([A-Za-z0-9_-]{1,64})"\s*>/y);
    if(!invoke)return null;
    const name=invoke[1],definition=definitions.find(tool=>tool.name===name);
    if(!readonly.has(name)||!definition)return null;
    const args=Object.create(null);whitespace();
    while(!take(/<\/[|｜]+DSML[|｜]+\s*invoke\s*>/y)) {
      const parameter=take(/<[|｜]+DSML[|｜]+\s*parameter\s+name="([A-Za-z0-9_-]{1,64})"\s+string="(true|false)"\s*>([\s\S]*?)<\/[|｜]+DSML[|｜]+\s*parameter\s*>/y);
      if(!parameter)return null;
      const key=parameter[1],schema=definition.parameters?.properties?.[key];
      if(['__proto__','prototype','constructor'].includes(key)||Object.hasOwn(args,key)||!Object.hasOwn(definition.parameters?.properties||{},key))return null;
      let value=parameter[3];
      try{if(parameter[2]==='false')value=JSON.parse(value);}catch{return null;}
      // All current readonly parameters are strings. Keep their raw contents,
      // including XML entities, rather than silently changing the user's query.
      if(schema.type!=='string'||typeof value!=='string'||!value.trim()||value.length<(schema.minLength||0)||value.length>(schema.maxLength||4096))return null;
      args[key]=value;whitespace();
    }
    if(definition.parameters?.required?.some(key=>!Object.hasOwn(args,key)))return null;
    const argumentsText=JSON.stringify(args);if(argumentsText.length>4096)return null;
    calls.push({id:'dsml_'+randomUUID(),name,arguments:argumentsText});whitespace();
  }
  return calls.length?calls:null;
}
