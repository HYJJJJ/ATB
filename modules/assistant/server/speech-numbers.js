// Only the text sent to local Chinese speech synthesis is changed; chat text stays intact.
const digits='零一二三四五六七八九';
const digitWords=value=>[...value].map(char=>digits[Number(char)]).join('');
function integerWords(value){
  if(value.length>16||/^0\d/.test(value))return digitWords(value);
  const groups=[];for(let end=value.length;end>0;end-=4)groups.unshift(value.slice(Math.max(0,end-4),end));
  let result='',gap=false;
  for(let i=0;i<groups.length;i++){
    const n=Number(groups[i]);if(!n){if(result)gap=true;continue;}
    if(result&&(gap||n<1000))result+='零';
    let part='',zero=false;const chars=String(n);
    for(let j=0;j<chars.length;j++){
      const d=Number(chars[j]),power=chars.length-j-1;
      if(!d){if(part)zero=true;continue;}
      if(zero)part+='零';zero=false;part+=digits[d]+['','十','百','千'][power];
    }
    if(!result)part=part.replace(/^一十/,'十');
    result+=part+['','万','亿','万亿'][groups.length-i-1];gap=false;
  }
  return result||'零';
}
function numberWords(value){
  let sign='';if(/^[+-]/.test(value)){sign=value[0]==='-'?'负':'正';value=value.slice(1);}
  const [whole,fraction]=value.replaceAll(',','').split('.');
  return sign+integerWords(whole)+(fraction===undefined?'':'点'+digitWords(fraction));
}
const numeric='[+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?';
export function normalizeSpeechNumbers(text){
  if(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text))return text;
  if(!/[\p{Script=Han}¥￥℃]/u.test(text)&&!/^\s*[+\-\d０-９.,:%％/\s]+\s*$/u.test(text))return text;
  text=text.replace(/[０-９]/g,char=>String(char.charCodeAt(0)-0xff10)).replaceAll('−','-');
  text=text.replace(/((?:验证码|编号|尾号|手机号|电话|QQ|种子(?:ID)?)\s*[：:]?\s*)(\d+)/gi,(_m,label,value)=>label+digitWords(value));
  const protectedText=[];
  text=text.replace(/https?:\/\/[^\s]+|`[^`]*`|\b(?:\d{1,3}\.){3}\d{1,3}\b|[a-zA-Z_][a-zA-Z0-9_.:/-]*\d[a-zA-Z0-9_.:/-]*/g,match=>{
    if(/^(?:CNY|RMB|USD)\d/i.test(match))return match;
    const token='\ue000'+String.fromCharCode(0xe100+protectedText.length)+'\ue001';protectedText.push([token,match]);return token;
  });
  text=text.replace(/\b([12]\d{3})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/g,(_m,y,m,d)=>digitWords(y)+'年'+integerWords(String(Number(m)))+'月'+integerWords(String(Number(d)))+'日');
  text=text.replace(/(\d{4})(?=年)/g,(_m,y)=>digitWords(y));
  text=text.replace(/(?<![\d:.])([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(?![\d:])/g,(_m,h,m,s)=>{
    const part=value=>Number(value)<10&&Number(value)>0?'零'+integerWords(String(Number(value))):integerWords(String(Number(value)));
    return integerWords(String(Number(h)))+'点'+(m==='00'&&s===undefined?'整':part(m)+'分'+(s===undefined?'':part(s)+'秒'));
  });
  text=text.replace(new RegExp('('+numeric+')\\s*(?:℃|°C)','g'),(_m,n)=>(n.startsWith('-')?'零下'+numberWords(n.slice(1)):numberWords(n))+'摄氏度');
  text=text.replace(new RegExp('([¥￥$])\\s*('+numeric+')','g'),(_m,unit,n)=>numberWords(n)+(unit==='$'?'美元':'元'));
  text=text.replace(new RegExp('\\b(CNY|RMB|USD)\\s*('+numeric+')','gi'),(_m,unit,n)=>numberWords(n)+(unit.toUpperCase()==='USD'?'美元':'元'));
  text=text.replace(new RegExp('('+numeric+')\\s*(CNY|RMB|USD)\\b','gi'),(_m,n,unit)=>numberWords(n)+(unit.toUpperCase()==='USD'?'美元':'元'));
  text=text.replace(new RegExp('('+numeric+')\\s*[–—~～-]\\s*('+numeric+')\\s*([%％]?)','g'),(_m,from,to,percent)=>(percent?'百分之':'')+numberWords(from)+'到'+numberWords(to));
  text=text.replace(new RegExp('('+numeric+')\\s*[%％]','g'),(_m,n)=>'百分之'+numberWords(n));
  text=text.replace(new RegExp(numeric,'g'),(n,offset,value)=>{
    if(/[a-zA-Z_]/.test(value[offset-1]||'')||/[a-zA-Z_]/.test(value[offset+n.length]||'')||/\d\.$/.test(value.slice(0,offset))||/^\.\d/.test(value.slice(offset+n.length)))return n;
    return /^\d{11}$/.test(n)&&!/[元块万亿个]/.test(value[offset+n.length]||'')?digitWords(n):numberWords(n);
  });
  for(const [token,value]of protectedText)text=text.replaceAll(token,value);
  return text;
}
