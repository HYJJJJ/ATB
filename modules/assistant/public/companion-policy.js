export const nextReminderAt = (at = Date.now(), random = Math.random) => at + Math.round((4 + random() * 5) * 60000);
const pad = 8, gap = 8;
function bubbleSpace({width,height,avatar,bubble,obstacles=[]}) {
  const maxX=width-bubble.width-pad, maxY=height-bubble.height-pad;
  const blocks=[avatar,...obstacles].filter(Boolean);
  const clear=point=>point.x>=pad&&point.y>=pad&&point.x<=maxX&&point.y<=maxY&&blocks.every(block=>point.x+bubble.width<=block.x-gap||point.x>=block.x+block.width+gap||point.y+bubble.height<=block.y-gap||point.y>=block.y+block.height+gap);
  const xs=[pad,maxX,...blocks.flatMap(b=>[b.x-bubble.width-gap,b.x+b.width+gap,b.x+(b.width-bubble.width)/2])];
  const ys=[pad,maxY,...blocks.flatMap(b=>[b.y-bubble.height-gap,b.y+b.height+gap,b.y+(b.height-bubble.height)/2])];
  const candidates=xs.flatMap(x=>ys.map(y=>({x:Math.round(Math.max(pad,Math.min(maxX,x))),y:Math.round(Math.max(pad,Math.min(maxY,y)))}))).filter(clear);
  return {maxX,maxY,clear,candidates};
}
export function replyBubblePosition(options) {
  const {avatar,bubble,side}=options,{candidates}=bubbleSpace(options);
  if(side){
    const x=side==='left'?avatar.x-gap-bubble.width:side==='right'?avatar.x+avatar.width+gap:avatar.x+(avatar.width-bubble.width)/2;
    const y=side==='below'?avatar.y+avatar.height+gap:side==='above'?avatar.y-gap-bubble.height:avatar.y+Math.min(75,bubble.height)-bubble.height;
    return {x:Math.round(Math.max(pad,Math.min(options.width-pad-bubble.width,x))),y:Math.round(Math.max(pad,Math.min(options.height-pad-bubble.height,y)))};
  }
  const target={x:avatar.x+(avatar.width-bubble.width)/2,y:avatar.y-bubble.height-gap};
  return candidates.sort((a,b)=>Math.hypot(a.x-target.x,a.y-target.y)-Math.hypot(b.x-target.x,b.y-target.y))[0]||null;
}
export function replyBubbleSize({width,height,avatar,contentHeight=70,side}) {
  const spaces=[
    {side:'above',width:width-pad*2,height:avatar.y-gap-pad},
    {side:'below',width:width-pad*2,height:height-pad-avatar.y-avatar.height-gap},
    {side:'left',width:avatar.x-gap-pad,height:height-pad*2},
    {side:'right',width:width-pad-avatar.x-avatar.width-gap,height:height-pad*2},
  ].map(space=>({side:space.side,width:Math.min(350,space.width),maxHeight:space.height}))
    .filter(space=>space.width>=Math.min(220,width-pad*2)&&space.maxHeight>=70);
  if(side)return spaces.find(space=>space.side===side)||null;
  return spaces.find(space=>space.maxHeight>=contentHeight)||spaces.sort((a,b)=>b.width*b.maxHeight-a.width*a.maxHeight)[0]||null;
}
export function randomBubblePosition(options) {
  const {previous,random=Math.random}=options,{maxX,maxY,clear,candidates}=bubbleSpace(options);
  const {avatar,bubble}=options,head={x:avatar.x+avatar.width/2,y:avatar.y+45};
  const near=point=>Math.hypot(Math.max(avatar.x-point.x-bubble.width,point.x-avatar.x-avatar.width,0),Math.max(avatar.y-point.y-bubble.height,point.y-avatar.y-75,0))<=70;
  for(let i=0;i<100;i++){
    const point={x:Math.round(Math.max(pad,Math.min(maxX,head.x-bubble.width/2+(random()-.5)*(avatar.width+bubble.width+80)))),y:Math.round(Math.max(pad,Math.min(maxY,head.y-bubble.height/2+(random()-.5)*(bubble.height+160))))};
    if(clear(point)&&near(point)&&(!previous||Math.hypot(point.x-previous.x,point.y-previous.y)>26))return point;
  }
  const nearby=candidates.filter(near),pool=nearby.length?nearby:options.obstacles?.length?candidates:[];
  const choices=pool.filter(p=>!previous||Math.hypot(p.x-previous.x,p.y-previous.y)>26);
  return choices[Math.min(choices.length-1,Math.floor(random()*choices.length))]||pool[0]||null;
}
export function replyMedia(text) {
  const images = [];
  const plain = String(text || '').replace(/!\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g, (_match, alt, url) => {
    try { const parsed = new URL(url); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && url.length < 2048) images.push({ url: parsed.href, alt: alt.slice(0, 100) || '图片' }); } catch {}
    return '';
  });
  const mood = /😄|😊|🥰|❤|开心|高兴/u.test(plain) ? 'happy' : /😢|😭|难过|伤心/u.test(plain) ? 'sad' : 'neutral';
  return { text: plain.trim(), images: images.slice(0, 3), mood };
}
