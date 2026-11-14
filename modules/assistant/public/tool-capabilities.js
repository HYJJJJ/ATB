// Shared by the settings UI and the host's actual tool registry.
export const TOOL_CAPABILITIES = [
  {id:'search',name:'网页搜索',icon:'search',description:'搜索最新资料，打开网页核实内容',example:'搜索今天的比赛结果',tools:['web_search','read_webpage']},
  {id:'weather',name:'城市天气',icon:'weather',description:'查询当前城市或指定城市的天气',example:'上海现在多少度？',tools:['weather']},
  {id:'news',name:'新闻头条',icon:'news',description:'查看中国新闻网的最新头条',example:'今天有什么新闻？',tools:['news']},
  {id:'time',name:'日期时间',icon:'time',description:'查询时间、日期与时区',example:'现在几点？',tools:['current_time']},
  {id:'balance',name:'账户余额',icon:'balance',description:'查询当前对话接口的账户余额',example:'对话 API 还剩多少钱？',tools:['api_balance']},
  {id:'atb',name:'软件导航',icon:'atb',description:'打开 ATB 主界面和各设置页面',example:'打开 ATB 的语音设置',tools:['open_atb']},
  {id:'applications',name:'打开应用',icon:'applications',description:'查找并启动本机已安装的应用',example:'打开微信',tools:['list_applications','open_application']},
  {id:'desktop',name:'操作应用',icon:'desktop',description:'查看指定窗口的控件，点击或填写内容',example:'查看记事本的窗口',tools:['desktop_windows','desktop_snapshot','desktop_interact'],defaultEnabled:false},
];
export const capabilityEnabled=(settings,capability)=>settings?.capabilities?.[capability.id]??capability.defaultEnabled!==false;
export const toolEnabled=(settings,name)=>{const group=TOOL_CAPABILITIES.find(item=>item.tools.includes(name));return !group||capabilityEnabled(settings,group);};
