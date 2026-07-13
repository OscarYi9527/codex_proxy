const API = '/admin/api'
let cfg = {}, statsData = { providers: {} }, diagnosticsData = { accounts: [], queue: {}, config_snapshots: [], account_backups: [], recent_route_decisions: [], credential_protection: {}, circuits: [] }, modelCatalog = [], activePage = location.hash.slice(1) || 'overview'
let pingResults = {}, modal = null, loginPoll = null, accountsPoll = null, draggedAccountId = null

const icons = {
  overview:'<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
  providers:'<path d="M12 2v6m0 8v6M4.93 4.93l4.24 4.24m5.66 5.66 4.24 4.24M2 12h6m8 0h6M4.93 19.07l4.24-4.24m5.66-5.66 4.24-4.24"/><circle cx="12" cy="12" r="4"/>',
  relays:'<circle cx="5" cy="12" r="3"/><circle cx="19" cy="5" r="3"/><circle cx="19" cy="19" r="3"/><path d="m7.6 10.5 8.8-4M7.6 13.5l8.8 4"/>',
  accounts:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6m3-3h-6"/>',
  analytics:'<path d="M3 3v18h18"/><path d="m7 16 4-5 4 3 5-7"/>',
  settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1 1.55V21h-4v-.08a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3v-4h.08a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3h4v.08a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.12.63.58 1.14 1.2 1.36.14.05.28.07.43.07H21v4h-.08A1.7 1.7 0 0 0 19.4 15z"/>',
  help:'<circle cx="12" cy="12" r="10"/><path d="M9.4 9a3 3 0 1 1 4.7 2.5c-1.3.8-2.1 1.3-2.1 3"/><path d="M12 18h.01"/>',
  refresh:'<path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M18.5 9a7 7 0 0 0-12-2.5L4 11m16 2-2.5 4.5A7 7 0 0 1 5.5 15"/>',
  moon:'<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>', sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>',
  plus:'<path d="M12 5v14M5 12h14"/>', check:'<path d="m5 12 4 4L19 6"/>', pulse:'<path d="M3 12h4l2-7 4 14 2-7h6"/>', server:'<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>', users:'<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6m3-3h-6"/>', arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>', trash:'<path d="M3 6h18M8 6V4h8v2m3 0-1 15H6L5 6m5 5v6m4-6v6"/>', edit:'<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/>', eye:'<circle cx="12" cy="12" r="3"/><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/>', x:'<path d="m6 6 12 12M18 6 6 18"/>', download:'<path d="M12 3v12m-5-5 5 5 5-5M5 21h14"/>', shield:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>'
}
function svg(name, cls=''){ return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icons[name]||''}</svg>` }
function esc(v=''){ return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) }
function fmt(n=0){ n=Number(n)||0; return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':n.toLocaleString('zh-CN') }
function allProviders(){ return Object.values(statsData.providers||{}) }
function totals(){ return allProviders().reduce((a,p)=>({requests:a.requests+(p.requests||0),input:a.input+(p.input_tokens||0),output:a.output+(p.output_tokens||0)}),{requests:0,input:0,output:0}) }

const pages = {
  overview:['控制台概览','查看网关运行状态与资源使用情况'],
  providers:['模型服务','管理上游模型服务与 API 凭据'],
  relays:['中转节点','配置 OpenAI 兼容节点与模型路由'],
  accounts:['账号池','管理 ChatGPT 订阅账号与自动轮换'],
  analytics:['用量分析','分析请求、Token 与模型调用分布'],
  settings:['系统设置','调整默认模型和网关基础参数'],
  help:['使用帮助','第一次使用也能快速完成配置']
}
const navGroups = [
  ['工作台',[['overview','控制台概览']]],
  ['资源管理',[['providers','模型服务'],['relays','中转节点'],['accounts','账号池']]],
  ['运维中心',[['analytics','用量分析'],['settings','系统设置']]],
  ['帮助',[['help','新手使用教程']]]
]
function renderNav(){
  document.getElementById('nav').innerHTML=navGroups.map(([g,items])=>`<div class="nav-label">${g}</div>${items.map(([id,label])=>`<button class="nav-btn ${activePage===id?'active':''}" onclick="switchPage('${id}')">${svg(id)}<span>${label}</span></button>`).join('')}`).join('')
}
function switchPage(page){
  activePage=pages[page]?page:'overview'; location.hash=activePage
  const [title,sub]=pages[activePage]; document.getElementById('top-title').textContent=title; document.getElementById('top-subtitle').textContent=sub
  document.getElementById('sidebar').classList.remove('open'); renderNav(); render()
  if(accountsPoll){clearInterval(accountsPoll);accountsPoll=null}
  if(activePage==='accounts')accountsPoll=setInterval(()=>{if(!document.hidden)load(false,false)},60000)
}
function toggleSidebar(){ document.getElementById('sidebar').classList.toggle('open') }
function initTheme(){
  const dark=localStorage.getItem('codex-theme')==='dark'||(!localStorage.getItem('codex-theme')&&matchMedia('(prefers-color-scheme:dark)').matches)
  document.documentElement.dataset.theme=dark?'dark':'light'; document.getElementById('themeButton').innerHTML=svg(dark?'sun':'moon')
}
function toggleTheme(){ const dark=document.documentElement.dataset.theme!=='dark'; document.documentElement.dataset.theme=dark?'dark':'light'; localStorage.setItem('codex-theme',dark?'dark':'light'); document.getElementById('themeButton').innerHTML=svg(dark?'sun':'moon') }

async function load(showMessage=false,includeModels=true){
  const btn=document.getElementById('refreshButton'); btn.innerHTML=svg('refresh')
  try{
    const [c,s,d,r,m]=await Promise.all([fetch(API+'/config'),fetch(API+'/stats'),fetch(API+'/diagnostics').catch(()=>null),fetch(API+'/resilience').catch(()=>null),includeModels?fetch('/v1/models').catch(()=>null):null])
    if(!c.ok||!s.ok) throw new Error('服务响应异常')
    cfg=(await c.json()).config||{}; statsData=await s.json()
    if(d?.ok)diagnosticsData=await d.json()
    if(r?.ok)diagnosticsData.circuits=(await r.json()).circuits||[]
    if(m?.ok)modelCatalog=((await m.json()).data||[]).map(model=>({id:model.id,name:model.display_name||model.id}))
    document.getElementById('side-status').textContent='网关服务运行中'; render(); if(showMessage) toast('数据已刷新')
  }catch(e){ document.getElementById('side-status').textContent='网关服务离线'; document.querySelector('.dot').style.background='var(--red)'; document.getElementById('app').innerHTML=empty('server','无法连接网关服务',e.message) }
}
function pageHead(title,desc,actions=''){ return `<div class="page-head"><div><h1>${title}</h1><p>${desc}</p></div><div class="card-actions">${actions}</div></div>` }
function metric(label,value,icon,foot){ return `<div class="metric"><div class="metric-top"><span>${label}</span><span class="metric-icon">${svg(icon)}</span></div><strong>${value}</strong><div class="metric-foot">${foot}</div></div>` }
function card(title,sub,body,actions=''){ return `<section class="card"><div class="card-head"><div class="card-title"><strong>${title}</strong>${sub?`<span>${sub}</span>`:''}</div><div class="card-actions">${actions}</div></div>${body}</section>` }
function button(text,icon,fn,cls=''){ return `<button class="btn ${cls}" onclick="${fn}">${icon?svg(icon):''}${text}</button>` }
function empty(icon,title,desc,action=''){ return `<div class="empty"><div class="empty-icon">${svg(icon)}</div><strong>${title}</strong><p>${desc}</p>${action}</div>` }
function providerRows(){
  const providers=[
    ['chatgpt','ChatGPT Subscription','订阅账号池','chatgpt-sub',(cfg.chatgptAccounts||[]).length?'已配置':'待配置'],
    ['openai','OpenAI API','官方 API 通道','openai-api',cfg.openaiApiKey?'已配置':'待配置'],
    ['deepseek','DeepSeek','Anthropic 兼容接口','deepseek',cfg.deepseekApiKey?'已配置':'待配置'],
    ['relay','中转节点',`${(cfg.relays||[]).length} 个兼容节点`,'relay',(cfg.relays||[]).length?'已配置':'未配置']
  ]
  return providers.map(([logo,name,sub,key,state])=>{
    const p=(statsData.providers||{})[key]||{}, result=pingResults[key], status=result?(result.ok?'正常':'异常'):state
    const statusClass=status==='正常'?'':status==='已配置'?'warn':'off'
    return `<div class="provider-row"><div class="provider-name"><span class="provider-logo ${logo}">${logo==='chatgpt'?'G':logo==='openai'?'AI':logo==='deepseek'?'D':'R'}</span><div><strong>${name}</strong><small>${sub}</small></div></div><div class="latency-cell"><span class="status ${statusClass}"><i></i>${status}</span>${result?`<div class="cell-sub">${result.latency||0} ms</div>`:'<div class="cell-sub">尚未执行连通性检测</div>'}</div><div class="usage-cell"><span class="cell-sub">${fmt(p.requests)} 次请求</span><div class="mini-bar"><i style="width:${Math.min(100,(p.requests||0)/Math.max(1,totals().requests)*100)}%"></i></div></div><button class="btn btn-sm" onclick="pingChannel('${key}')">${svg('pulse')}检测</button></div>`
  }).join('')
}
function renderOverview(){
  const t=totals(), totalTokens=t.input+t.output, models=allProviders().reduce((n,p)=>n+Object.keys(p.models||{}).length,0)
  const configuredChannels=((cfg.chatgptAccounts||[]).length>0?1:0)+(cfg.openaiApiKey?1:0)+(cfg.deepseekApiKey?1:0)+(cfg.relays||[]).length
  const recent=allProviders().flatMap(p=>Object.entries(p.models||{})).sort((a,b)=>(b[1].requests||0)-(a[1].requests||0)).slice(0,4)
  const activity=recent.length?recent.map(([name,v])=>`<div class="activity"><span class="activity-icon">${svg('arrow')}</span><div><p><b>${esc(name)}</b> 完成 ${fmt(v.requests)} 次路由请求</p><small>输入 ${fmt(v.input_tokens)} · 输出 ${fmt(v.output_tokens)} Tokens</small></div></div>`).join(''):empty('pulse','暂无调用记录','请求将在这里实时汇总')
  return pageHead('控制台概览','统一查看模型网关、账号池和节点状态',button('检测全部通道','pulse','pingAll()','btn-primary'))+
    `<div class="metrics">${metric('累计请求',fmt(t.requests),'pulse','<b>实时统计</b> · 全部模型通道')}${metric('Token 用量',fmt(totalTokens),'analytics',`输入 ${fmt(t.input)} · 输出 ${fmt(t.output)}`)}${metric('已配置通道',String(configuredChannels),'server','实际可用性以连通性检测结果为准')}${metric('账号池',String((cfg.chatgptAccounts||[]).length),'users','支持配额自动轮换')}</div>`+
    `<div class="grid"><div>${card('服务状态','上游通道与实时连通性',`<div class="card-body">${providerRows()}</div>`,button('管理服务','',"switchPage('providers')",'btn-sm'))}</div><div>${card('最近调用','按模型请求量排序',`<div class="card-body">${activity}</div>`)}${card('运行信息','当前网关环境',`<div class="card-body"><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">默认模型</span><b>${esc(cfg.defaultModel||'-')}</b></div><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">统计更新时间</span><b>${statsData.updated?new Date(statsData.updated).toLocaleTimeString('zh-CN'):'-'}</b></div><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">部署模式</span><span class="badge">Local</span></div></div>`)}</div></div>`
}
function field(name,label,type='text',hint='',full=false){
  const value=cfg[name]||'', password=type==='password'
  return `<div class="field ${full?'full':''}"><label>${label}${hint?` <span class="hint">${hint}</span>`:''}</label><div class="input-wrap"><input class="input" id="f_${name}" type="${password?'password':'text'}" value="${esc(value)}">${password?`<button class="icon-btn" type="button" onclick="toggleSecret('f_${name}',this)">${svg('eye')}</button>`:''}</div></div>`
}
function toggleSecret(id,btn){ const el=document.getElementById(id); el.type=el.type==='password'?'text':'password'; btn.innerHTML=svg('eye') }
function renderProviders(){
  const openai=`<div class="card-body"><div class="form-grid">${field('openaiApiKey','API Key','password','安全保存')}${field('openaiApiBaseUrl','Base URL')}${field('openaiOrgId','Organization ID','','可选')}${field('openaiProjectId','Project ID','','可选')}${field('openaiApiResponsesUrl','Responses URL','','',true)}${field('openaiApiChatCompletionsUrl','Chat Completions URL','','',true)}</div></div><div class="form-footer">${button('连通性检测','pulse',"pingChannel('openai-api')")}${button('保存配置','check','saveConfig()','btn-primary')}</div>`
  const deepseek=`<div class="card-body"><div class="form-grid">${field('deepseekApiKey','API Key','password','安全保存')}${field('upstreamUrl','Anthropic Messages URL','','',true)}</div></div><div class="form-footer">${button('连通性检测','pulse',"pingChannel('deepseek')")}${button('保存配置','check','saveConfig()','btn-primary')}</div>`
  const chatgpt=`<div class="card-body"><div class="form-grid">${field('chatgptResponsesUrl','Responses URL','','',true)}<div class="field full"><label>账号池状态</label><div class="input-wrap"><div class="input" style="display:flex;align-items:center">${(cfg.chatgptAccounts||[]).length} 个账号已接入，按可用配额自动轮换</div>${button('管理账号','',"switchPage('accounts')")}</div></div></div></div><div class="form-footer">${button('连通性检测','pulse',"pingChannel('chatgpt-sub')")}${button('保存配置','check','saveConfig()','btn-primary')}</div>`
  return pageHead('模型服务','统一配置所有上游服务的访问凭据与端点',button('检测全部','pulse','pingAll()'))+card('OpenAI API','官方模型服务',openai)+card('DeepSeek','Anthropic 协议兼容服务',deepseek)+card('ChatGPT Subscription','订阅账号服务',chatgpt)
}
function renderRelays(){
  const relays=cfg.relays||[]
  const body=relays.length?`<div class="table-wrap"><table class="table"><thead><tr><th>节点</th><th>状态</th><th>模型</th><th>操作</th></tr></thead><tbody>${relays.map(r=>`<tr><td><div class="cell-main">${esc(r.name)}</div><div class="cell-sub">${esc(r.base_url)}</div></td><td><span class="status ${pingResults['relay:'+r.id]?.ok?'':'off'}"><i></i>${pingResults['relay:'+r.id]?(pingResults['relay:'+r.id].ok?'正常':'异常'):'未检测'}</span></td><td><div class="tags">${(r.models||[]).slice(0,4).map(m=>`<span class="tag">${esc(m)}</span>`).join('')}${(r.models||[]).length>4?`<span class="tag">+${r.models.length-4}</span>`:''}</div></td><td><div class="card-actions"><button class="btn btn-sm" onclick="pingChannel('relay','${esc(r.id)}')">${svg('pulse')}</button><button class="btn btn-sm" onclick="openRelay('${esc(r.id)}')">${svg('edit')}</button><button class="btn btn-sm btn-danger" onclick="removeRelay('${esc(r.id)}')">${svg('trash')}</button></div></td></tr>`).join('')}</tbody></table></div>`:empty('relays','还没有中转节点','添加 OpenAI 兼容 API 节点，构建多线路容灾',button('添加第一个节点','plus','openRelay()','btn-primary'))
  return pageHead('中转节点',`集中管理第三方兼容节点，共 ${relays.length} 个`,button('添加节点','plus','openRelay()','btn-primary'))+card('节点列表','支持独立模型映射与健康检测',body)
}
function formatDuration(seconds){
  seconds=Number(seconds)||0; if(seconds<=0)return '已重置'
  const d=Math.floor(seconds/86400),h=Math.floor((seconds%86400)/3600),m=Math.floor((seconds%3600)/60)
  if(d>0)return `${d} 天 ${h} 小时后重置`
  if(h>0)return `${h} 小时 ${m} 分后重置`
  return `${m} 分钟后重置`
}
function usageWindowHtml(win,account){
  if(!win||win.used_percent==null){
    if(account?.usage_sync_status==='refreshing'||account?.usage_sync_status==='pending')return '<span class="status warn"><i></i>正在获取额度…</span>'
    if(account?.usage_sync_status==='error')return `<span class="cell-sub" title="${esc(account.usage_sync_error||'请稍后重试')}">首次同步失败 · 可点刷新重试</span>`
    return '<span class="cell-sub">等待首次额度同步</span>'
  }
  const used=Math.max(0,Math.min(100,Number(win.used_percent)||0))
  const remaining=Math.max(0,Math.min(100,win.remaining_percent==null?100-used:Number(win.remaining_percent)))
  const color=remaining<=10?'var(--red)':remaining<=30?'#e0a52c':'var(--green)'
  const resetText=win.reset_after_seconds!=null?formatDuration(win.reset_after_seconds):(win.resets_at?new Date(win.resets_at*1000).toLocaleString('zh-CN'):'')
  return `<div class="cell-main" style="color:${color}">剩余 ${remaining.toFixed(0)}%</div><div class="mini-bar" style="margin-bottom:4px"><i style="width:${remaining}%;background:${color}"></i></div><span class="cell-sub">已用 ${used.toFixed(0)}%${resetText?' · '+resetText:''}</span>`
}
function usageForecastHtml(forecast){
  if(!forecast||forecast.estimated_minutes_to_reserve==null)return ''
  const minutes=Math.max(0,Number(forecast.estimated_minutes_to_reserve)||0)
  const text=minutes>=1440?`${(minutes/1440).toFixed(1)} 天`:minutes>=60?`${(minutes/60).toFixed(1)} 小时`:`${Math.round(minutes)} 分钟`
  const confidence={high:'高',medium:'中',low:'低'}[forecast.confidence]||'-'
  return `<div class="cell-sub" title="根据最近 ${forecast.samples||0} 个额度样本估算">预计 ${text} 后到安全线 · 可信度 ${confidence}</div>`
}
const accountStrategyLabels={
  'priority':'优先级（按拖拽顺序）',
  'round-robin':'轮询',
  'headroom':'剩余额度最多',
  'least-used':'调用次数最少',
  'latency':'P95 延迟最低',
  'reliable':'健康度综合评分',
  'weighted':'按账号权重',
  'random':'随机',
  'lkgp':'最后成功路径'
}
function renderAccounts(){
  const accounts=cfg.chatgptAccounts||[]
  const threshold=Number(cfg.chatgptLowQuotaThreshold??10)
  const remainingOf=a=>{
    const values=[a.usage&&a.usage.primary,a.usage&&a.usage.secondary].filter(Boolean).map(w=>w.remaining_percent==null?(w.used_percent==null?null:100-Number(w.used_percent)):Number(w.remaining_percent)).filter(Number.isFinite)
    return values.length?Math.min(...values):null
  }
  const available=accounts.filter(a=>(a.status==='active'||!a.status)&&a.routing_enabled!==false&&(remainingOf(a)==null||remainingOf(a)>threshold)).length
  const activeId=cfg.activeChatgptAccountId
  const activeLabel=accounts.find(a=>a.id===activeId)
  const body=accounts.length?`<div class="table-wrap"><table class="table"><thead><tr><th>优先级 / 账号</th><th>套餐 / ID</th><th>5 小时</th><th>1 周</th><th>健康度</th><th>延迟</th><th>权重</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${accounts.map((a,index)=>{
    const isActive=a.id===activeId
    const health=(statsData.accounts||{})[a.id]||{}
    const runtime=(diagnosticsData.accounts||[]).find(item=>item.id===a.id)||{}
    const oneHour=health.windows&&health.windows['1h'],day=health.windows&&health.windows['24h']
    const recentRates=oneHour&&day?`<div class="cell-sub">1h ${oneHour.success_rate==null?'-':oneHour.success_rate+'%'} · 24h ${day.success_rate==null?'-':day.success_rate+'%'}</div>`:''
    const lastError=health.last_error_type?`<div class="cell-sub" title="${esc(health.last_error_message||health.last_error_type)}">最近错误：${esc(health.last_error_type)}${health.last_status?` (${health.last_status})`:''}</div>`:''
    const healthHtml=health.requests?`<div class="cell-main">${Number(health.success_rate||0).toFixed(1)}% 累计成功</div>${recentRates}<div class="cell-sub">${fmt(health.requests)} 次${health.rate_limited?` · ${health.rate_limited} 次 429`:''}</div>${lastError}`:'<span class="cell-sub">暂无请求</span>'
    const latencyHtml=health.requests?`<div class="cell-main">P95 ${fmt(health.p95_latency_ms)} ms</div><div class="cell-sub">P50 ${fmt(health.p50_latency_ms)} · 平均 ${fmt(health.average_latency_ms)} ms</div>`:'<span class="cell-sub">暂无数据</span>'
    const routeEnabled=a.routing_enabled!==false
    const atReserve=remainingOf(a)!=null&&remainingOf(a)<=threshold
    const usageStale=!a.usage_updated_at||(Date.now()-new Date(a.usage_updated_at).getTime()>30*60*1000)
    const modelCooldownCount=Object.values(a.model_cooldowns||{}).filter(until=>Number(until)>Date.now()).length
    return `<tr draggable="true" data-account-id="${esc(a.id)}" ondragstart="startAccountDrag(event,'${esc(a.id)}')" ondragover="event.preventDefault()" ondrop="dropAccount(event,'${esc(a.id)}')"><td><div class="cell-main" title="拖拽调整优先级"><span class="tag" style="cursor:grab">☰ ${index+1}</span> ${esc(a.label||a.email||'ChatGPT 账号')} ${isActive?'<span class="badge">Current</span>':'<span class="tag">Standby</span>'} ${routeEnabled&&usageStale?'<span class="tag">额度待刷新</span>':''} ${routeEnabled&&atReserve?'<span class="tag">已到安全余量</span>':''}</div><div class="cell-sub">${!routeEnabled?'仅保存 · 不参与路由':a.status==='cooldown'?'账号冷却中':a.status==='auth_error'?'登录已失效 · 请重新登录':atReserve?'已暂停 · 保留安全余量':'参与自动路由'}${a.cooldown_until?' · 恢复：'+new Date(a.cooldown_until).toLocaleString('zh-CN'):''}${modelCooldownCount?` · ${modelCooldownCount} 个模型冷却`:''}${runtime.concurrency_limit?` · 并发 ${runtime.active_requests||0}/${runtime.concurrency_limit}`:''}</div></td><td><div class="cell-main">${esc(a.plan_type||'-')}</div><div class="cell-sub">${esc((a.account_id||a.id||'-').slice(0,20))}</div></td><td>${usageWindowHtml(a.usage&&a.usage.primary,a)}${usageForecastHtml(a.usage_forecast&&a.usage_forecast.primary)}</td><td>${usageWindowHtml(a.usage&&a.usage.secondary,a)}${usageForecastHtml(a.usage_forecast&&a.usage_forecast.secondary)}</td><td>${healthHtml}</td><td>${latencyHtml}</td><td><input class="input" style="width:68px;height:30px" type="number" min="1" max="100" value="${Number(a.routing_weight)||1}" onchange="updateAccountWeight('${esc(a.id)}',this.value)" title="weighted 策略下生效"></td><td class="cell-sub">${a.usage_updated_at?new Date(a.usage_updated_at).toLocaleString('zh-CN'):'-'}</td><td><div class="card-actions">${button(routeEnabled?'停用路由':'启用路由',routeEnabled?'x':'check',`toggleAccountRouting('${esc(a.id)}',${routeEnabled?'false':'true'})`,'btn-sm')}${isActive?'<span class="status"><i></i>本机账号</span>':button('切换本机','arrow',`switchAccount('${esc(a.id)}')`,'btn-sm')}<button class="btn btn-sm" onclick="openRenameAccount('${esc(a.id)}')" title="账号改名">${svg('edit')}</button><button class="btn btn-sm" onclick="refreshAccountUsageOne('${esc(a.id)}')" title="刷新用量">${svg('refresh')}</button><button class="btn btn-sm btn-danger" onclick="removeAccount('${esc(a.id)}')">${svg('trash')}</button></div></td></tr>`
  }).join('')}</tbody></table></div>`:empty('accounts','账号池为空','通过官方登录或导入 auth.json 即可启用自动轮换',button('官方安全登录','shield','openOfficialLogin()','btn-primary'))
  const actions=button('官方安全登录','shield','openOfficialLogin()','btn-primary')+button('导入 auth.json','plus','openAccount()')+button('刷新全部用量','refresh','refreshAllUsage()')+button('重启 Codex','refresh','restartCodex()')
  const strategyOptions=Object.entries(accountStrategyLabels).map(([value,label])=>`<option value="${value}" ${cfg.chatgptAccountStrategy===value?'selected':''}>${label}</option>`).join('')
  const strategyBody=`<div class="card-body"><div class="form-grid"><div class="field"><label>账号选择模式</label><select id="f_chatgptAccountStrategy">${strategyOptions}</select></div><div class="field"><label>低额度避让阈值 <span class="hint">0-100%</span></label><input class="input" id="f_chatgptLowQuotaThreshold" type="number" min="0" max="100" value="${Number(cfg.chatgptLowQuotaThreshold??10)}"></div></div></div><div class="form-footer">${button('保存路由策略','check','saveConfig()','btn-primary')}</div>`
  const decisions=diagnosticsData.recent_route_decisions||[]
  const decisionBody=decisions.length?`<div class="table-wrap"><table class="table"><thead><tr><th>时间 / Request ID</th><th>模型</th><th>结果</th><th>选择与跳过原因</th></tr></thead><tbody>${decisions.slice(0,15).map(item=>{const skipped=(item.accounts||[]).filter(account=>account.result==='skipped').slice(0,4);const result=item.selected_account_label?`选择 ${esc(item.selected_account_label)}`:item.outcome==='queue_timeout'?'排队超时':item.outcome==='client_disconnected'?'客户端已断开':'没有可用账号';return `<tr><td><div class="cell-main">${new Date(item.at).toLocaleTimeString('zh-CN')}</div><div class="cell-sub">${esc(item.request_id||'-')}</div></td><td>${esc(item.model||'-')}</td><td><div class="cell-main">${result}</div><div class="cell-sub">${item.queue_wait_ms?`等待 ${fmt(item.queue_wait_ms)} ms`:'无需等待'}</div></td><td>${skipped.length?skipped.map(account=>`<div class="cell-sub"><b>${esc(account.label||account.id)}</b>：${esc(account.reason)}</div>`).join(''):'<span class="cell-sub">没有账号被跳过</span>'}</td></tr>`}).join('')}</tbody></table></div>`:empty('pulse','暂无路由决策','发起一次 ChatGPT 订阅模型请求后，将显示账号选择和跳过原因')
  return pageHead('ChatGPT 账号池','多账号统一托管，并在配额不足时自动切换',actions)+`<div class="metrics">${metric('账号总数',accounts.length,'users','全部订阅账号')}${metric('有效账号',available,'check',`${accounts.length-available} 个账号停用、冷却或到安全线`)}${metric('自适应并发','1–3','refresh',`当前队列 ${Number(diagnosticsData.queue?.depth)||0} · 超限自动排队`)}${metric('当前账号',activeLabel?esc(activeLabel.label||activeLabel.account_id||'已选择'):'未选择','shield','切换后本机 Codex 生效')}</div>`+card('路由策略','优先级模式使用下方拖拽顺序；权重模式使用每行权重',strategyBody)+card('账号健康矩阵','显示自适应并发、额度趋势、双层冷却和近期健康状态',body)+card('最近路由决策','解释每次请求为什么选择或跳过某个账号',decisionBody)
}
function renderAnalytics(){
  const t=totals(), items=allProviders().flatMap(p=>Object.entries(p.models||{}).map(([name,v])=>({name,...v}))).sort((a,b)=>b.requests-a.requests)
  const max=Math.max(1,...items.map(i=>i.requests))
  const chartBody=items.length?`<div class="card-body"><div class="chart">${items.slice(0,10).map(i=>`<div class="chart-col"><div class="chart-bar" data-value="${fmt(i.requests)} 次" style="height:${Math.max(3,i.requests/max*90)}%"></div><label title="${esc(i.name)}">${esc(i.name)}</label></div>`).join('')}</div></div>`:empty('analytics','暂无统计数据','完成首次模型调用后将自动生成图表')
  const tableBody=items.length?`<div class="table-wrap"><table class="table"><thead><tr><th>模型</th><th>请求数</th><th>输入 Token</th><th>输出 Token</th><th>总量</th></tr></thead><tbody>${items.map(i=>`<tr><td class="cell-main">${esc(i.name)}</td><td>${fmt(i.requests)}</td><td>${fmt(i.input_tokens)}</td><td>${fmt(i.output_tokens)}</td><td><b>${fmt((i.input_tokens||0)+(i.output_tokens||0))}</b></td></tr>`).join('')}</tbody></table></div>`:''
  return pageHead('用量分析','统计数据保存在本地，不会上传到第三方',button('清空统计','trash','resetStats()','btn-danger'))+`<div class="metrics">${metric('总请求数',fmt(t.requests),'pulse','累计路由请求')}${metric('输入 Token',fmt(t.input),'download','模型输入消耗')}${metric('输出 Token',fmt(t.output),'analytics','模型输出消耗')}${metric('活跃模型',items.length,'server','产生过调用的模型')}</div>`+card('模型请求分布','按累计请求数排序',chartBody)+card('用量明细',`${items.length} 个活跃模型`,tableBody)
}
function helpStep(number,title,desc,action='',done=false){
  return `<div class="help-step"><span class="help-number ${done?'done':''}">${done?svg('check'):number}</span><div><strong>${title}</strong><p>${desc}</p>${action?`<div class="help-action">${action}</div>`:''}</div></div>`
}
function helpFeature(icon,title,desc,page){
  return `<button class="help-feature" onclick="switchPage('${page}')"><span>${svg(icon)}</span><div><strong>${title}</strong><small>${desc}</small></div>${svg('arrow')}</button>`
}
function renderHelp(){
  const accounts=cfg.chatgptAccounts||[]
  const enabled=accounts.filter(a=>a.routing_enabled!==false).length
  const hasProvider=Boolean(enabled||cfg.openaiApiKey||cfg.deepseekApiKey||(cfg.relays||[]).length)
  const strategy=accountStrategyLabels[cfg.chatgptAccountStrategy]||'最后成功路径'
  const steps=helpStep(1,'先准备一个可用通道','最简单的方式是进入账号池，点击“官方安全登录”。登录完成后账号会先安全保存，不会立刻参与自动路由。',button(accounts.length?'查看账号池':'添加第一个账号','accounts',"switchPage('accounts')",'btn-primary'),accounts.length>0)+
    helpStep(2,'决定哪些账号参与路由','“仅保存”表示放在账号池备用；“启用路由”才会处理请求。它和“当前本机账号”不是一回事。',button('管理启用状态','check',"switchPage('accounts')"),enabled>0)+
    helpStep(3,'保持推荐的稳定设置',`当前模式是“${esc(strategy)}”，安全余量 ${Number(cfg.chatgptLowQuotaThreshold??10)}%。新手建议保持“最后成功路径 + 10%”。`,button('查看路由设置','settings',"switchPage('accounts')"),cfg.chatgptAccountStrategy==='lkgp'&&Number(cfg.chatgptLowQuotaThreshold??10)===10)+
    helpStep(4,'检测后开始使用','点击检测全部通道；显示正常后，Codex 会通过本地代理自动选择可用账号或服务。',button('检测全部通道','pulse','pingAll()','btn-primary'),hasProvider)
  const concepts=`<div class="help-concepts"><div><span class="badge">仅保存</span><p>账号只保存在账号池，不接收请求。适合先录入、以后再启用。</p></div><div><span class="badge">启用路由</span><p>允许代理自动使用该账号，并遵守额度、安全余量和冷却规则。</p></div><div><span class="badge">当前本机</span><p>当前 Codex 客户端自己登录的账号。切换它会影响本机 Codex，不等于启用路由。</p></div><div><span class="badge">冷却</span><p>遇到限流后临时跳过账号或模型，恢复后自动重新参与，无需手工操作。</p></div></div>`
  const chooser=`<div class="help-chooser"><div class="recommended"><span class="badge">最适合新手</span><h3>我有 ChatGPT 订阅账号</h3><p>进入“账号池”使用官方安全登录。系统读取账号的订阅额度，并在你启用后自动路由。</p>${button('选择这条路线','accounts',"switchPage('accounts')",'btn-primary')}</div><div><span class="tag">按量付费</span><h3>我有 OpenAI 或 DeepSeek API Key</h3><p>进入“模型服务”，粘贴服务商提供的 API Key，保存后点击连通性检测。</p>${button('配置模型服务','providers',"switchPage('providers')")}</div><div><span class="tag">进阶选项</span><h3>我使用第三方兼容节点</h3><p>进入“中转节点”填写地址、密钥和模型。来源不明的节点可能有隐私风险，新手不建议优先选择。</p>${button('管理中转节点','relays',"switchPage('relays')")}</div></div>`
  const exactGuide=`<div class="help-manual"><div class="help-note"><b>开始前准备</b><p>准备好自己的 ChatGPT 账号；保持此管理页面打开；确认浏览器可以访问 OpenAI 官方登录页。不要把密码、验证码、auth.json 或 API Key 发给他人。</p></div><ol><li><b>打开账号池。</b><span>点击左侧“账号池”，再点击页面右上角“官方安全登录”。</span></li><li><b>给账号写一个容易认的名称。</b><span>例如“工作账号”或邮箱前缀。名称只是本地备注，不影响官方账号。</span></li><li><b>在自动打开的私密窗口完成官方登录。</b><span>只在 OpenAI 官方页面输入账号信息。看到 ChatGPT 页面不代表后台一定完成，请继续等待管理页面显示“登录成功”。</span></li><li><b>回到账号池确认账号出现。</b><span>新账号默认是“仅保存”，这样不会误用额度。若没有出现，不要连续反复发起登录，先查看下方故障排查。</span></li><li><b>点击“启用路由”。</b><span>只有启用后的账号才会处理请求。想先存着备用，就保持“仅保存”。</span></li><li><b>刷新一次用量。</b><span>点击账号行右侧的刷新按钮，确认能看到 5 小时和每周额度。短时间无数据不一定是故障。</span></li><li><b>保存推荐策略。</b><span>选择“最后成功路径”，安全余量填写 10，然后点击“保存路由策略”。</span></li><li><b>检测并开始使用。</b><span>回到教程点击“检测全部通道”。本机 Codex 已配置好代理，一般不需要再改登录账号。</span></li></ol></div>`
  const otherGuides=`<div class="help-faq"><details open><summary>使用 OpenAI API Key 的完整步骤</summary><p>① 在 OpenAI 官方 API 平台创建 API Key，并确认 API 账户有可用余额；② 打开左侧“模型服务”；③ 将密钥粘贴到 OpenAI API 的 API Key 框；④ 官方地址通常保持默认，不懂 Organization ID 和 Project ID 就留空；⑤ 点击“保存配置”；⑥ 点击“连通性检测”；⑦ 前往“系统设置”选择默认模型。API 和 ChatGPT 订阅是两套独立计费体系，ChatGPT Plus/Pro 不等于拥有 API 余额。</p></details><details><summary>使用 DeepSeek API Key 的完整步骤</summary><p>① 从 DeepSeek 官方开放平台创建 API Key；② 打开“模型服务”；③ 在 DeepSeek 区域粘贴 API Key；④ 不清楚接口地址时保持默认；⑤ 保存后点击连通性检测；⑥ 在系统设置选择对应模型。密钥只需要填在本机后台，不要发到聊天窗口。</p></details><details><summary>添加第三方中转节点的完整步骤</summary><p>① 只选择你信任的服务商；② 打开“中转节点”并点击“添加节点”；③ 节点 ID 填简短英文，例如 hk-01；④ 显示名称可以填中文；⑤ Base URL、API Key 和模型名必须与服务商文档一致；⑥ 保存后点击检测。第三方节点可能看到请求内容，涉及私人代码或敏感数据时不要使用来源不明的节点。</p></details><details><summary>复制代理地址后怎么用？</summary><p>本机 Codex 已经完成配置，通常不需要再填。只有其他 OpenAI 兼容客户端需要接入时，才复制本页右上角的代理地址作为 Base URL。不同客户端字段名称可能叫“API 地址”“Base URL”或“接口地址”。代理只监听本机 127.0.0.1，其他电脑不能直接访问。</p></details></div>`
  const statusGuide=`<div class="help-status"><div><span class="status"><i></i>正常 / 可用</span><p>通道可以使用，不需要处理。</p></div><div><span class="status warn"><i></i>额度待刷新</span><p>额度数据较旧；可手动刷新一次，不必频繁点击。</p></div><div><span class="status off"><i></i>仅保存</span><p>账号已录入但不会接收请求，属于安全的备用状态。</p></div><div><span class="tag">模型冷却</span><p>某个模型暂时限流，系统会自动换账号或等待恢复。</p></div><div><span class="tag">账号冷却</span><p>整个账号暂时不可用，恢复时间到达后会自动重新参与。</p></div><div><span class="tag">503</span><p>当前没有可安全使用的账号，常见原因是都在忙、冷却或已到 10% 安全线。</p></div></div>`
  const faq=`<div class="help-faq"><details open><summary>账号快没额度了怎么办？</summary><p>系统会在剩余 10% 时停止使用该账号，并选择其他已启用账号。全部账号都到安全线时会暂停请求，而不是继续消耗保留额度。你不需要等到 0% 再手工切换。</p></details><details><summary>私密窗口已经进入 ChatGPT，后台为什么还没显示成功？</summary><p>官方回调可能仍在完成。先保留私密窗口并等待管理页面状态更新。如果长时间没有变化，取消本次流程后只重试一次；确认没有浏览器扩展、代理或安全软件拦截官方回调。不要连续点击登录，以免触发 429。</p></details><details><summary>登录时出现 429 Too Many Requests 怎么办？</summary><p>表示短时间请求过多。停止重复发起登录，等待一段时间后再试。当前系统使用官方浏览器登录，不走容易触发 429 的设备码批量请求路径。</p></details><details><summary>对话切换账号后还能继续吗？</summary><p>通常可以。最后成功路径会尽量让同一个会话继续使用原账号；原账号不可用时才切换。客户端会继续提交对话内容，但切换后上游缓存可能重新建立，所以响应速度偶尔会变化。</p></details><details><summary>看到 429 或“模型冷却”是什么意思？</summary><p>表示上游暂时限流。系统不会在原账号上反复请求，会跳过该账号上的对应模型并尝试其他账号。一般等待自动恢复即可。</p></details><details><summary>什么时候需要“切换本机”？</summary><p>只有你明确想让本机 Codex 客户端本身改用另一个登录账号时才需要。只是把账号放进池里备用或参与代理路由，不要点击切换本机。</p></details><details><summary>额度为什么不是每秒更新？</summary><p>为减少额外请求和保持稳定，额度采用低频刷新，也会从正常模型响应中顺带更新。页面显示“额度待刷新”时手动刷新一次即可，频繁刷新没有必要。</p></details><details><summary>成功率看起来很低，是否代表现在不可用？</summary><p>先看 1 小时和 24 小时成功率。累计成功率包含较早的历史失败；近期请求正常时，通常不需要因为累计数字较低而手工切换。</p></details><details><summary>哪些信息绝对不能分享？</summary><p>不要分享 auth.json、Access Token、Refresh Token、API Key、邮箱验证码或带 token 的验证码网站链接。只使用自己拥有且有权使用的账号，并遵守服务商规则。</p></details></div>`
  return pageHead('新手使用教程','从“这是什么”开始讲起；按顺序阅读，不懂的高级选项保持默认即可',button('复制代理地址','download','copyProxyAddress()'))+
    `<div class="help-banner"><div><span class="badge">推荐配置</span><h2>最后成功路径 + 10% 安全余量</h2><p>优先保证稳定，不需要频繁切换账号，也不会等到额度完全用完。</p></div>${button('去账号池配置','arrow',"switchPage('accounts')",'btn-primary')}</div>`+
    card('这个系统是做什么的？','先理解用途，再开始操作',`<div class="card-body help-intro"><p><b>它是运行在你电脑上的本地模型网关。</b>Codex 把请求交给它，它再根据你选择的规则，从 ChatGPT 订阅账号、官方 API、DeepSeek 或中转节点中选择一个可用通道。</p><p>它主要解决三件事：<b>统一管理账号和服务、在额度不足时稳定切换、集中查看额度与健康状态。</b>管理后台仅用于本机配置，不会替你注册账号，也不会绕过官方限制。</p></div>`)+
    card('第一步：我应该选择哪种接入方式？','只需要选择一种，也可以以后再增加',chooser)+
    `<div class="grid"><div>${card('四步快速开始',`${accounts.length} 个账号 · ${enabled} 个参与路由`,`<div class="card-body help-steps">${steps}</div>`)}${card('ChatGPT 账号完整操作步骤','第一次使用建议逐条完成',exactGuide)}${card('API 和中转节点怎么配置？','按你选择的接入方式阅读',otherGuides)}${card('常见问题和故障排查','从登录、额度到账号切换',faq)}</div><div>${card('左侧功能都有什么？','点击即可前往',`<div class="help-features">${helpFeature('overview','控制台概览','看服务是否正常、最近有没有调用','overview')}${helpFeature('providers','模型服务','配置官方 API 和 DeepSeek','providers')}${helpFeature('relays','中转节点','添加第三方兼容服务','relays')}${helpFeature('accounts','账号池','添加账号、查看额度和切换策略','accounts')}${helpFeature('analytics','用量分析','查看请求和 Token 用量','analytics')}${helpFeature('settings','系统设置','选择默认模型和显示偏好','settings')}</div>`)}${card('四个重要概念','先分清这些就不容易误操作',concepts)}${card('页面状态怎么看？','看到这些文字时该做什么',statusGuide)}${card('新手安全原则','避免误操作和凭据泄露',`<div class="card-body help-note"><p>① 只登录自己拥有的账号；② 只在 OpenAI 官方页面输入密码和验证码；③ 不上传 auth.json；④ 不频繁刷新额度或反复登录；⑤ 不确定时保持“仅保存”，不要切换本机账号。</p></div>`)}</div></div>`
}
async function copyProxyAddress(){
  const value=`${location.origin}/v1`
  try{await navigator.clipboard.writeText(value);toast(`已复制：${value}`)}catch{toast(`代理地址：${value}`)}
}
function renderSettings(){
  const relayOptions=(cfg.relays||[]).map(r=>`<option value="relay:${esc(r.id)}" ${cfg.openaiApiUpstream==='relay:'+r.id?'selected':''}>中转节点 · ${esc(r.name)}</option>`).join('')
  const models=[...modelCatalog]
  if(cfg.defaultModel&&!models.some(model=>model.id===cfg.defaultModel))models.unshift({id:cfg.defaultModel,name:cfg.defaultModel})
  const modelOptions=models.map(model=>`<option value="${esc(model.id)}" ${cfg.defaultModel===model.id?'selected':''}>${esc(model.name)} · ${esc(model.id)}</option>`).join('')
  const body=`<div class="card-body"><div class="form-grid"><div class="field"><label>默认模型 <span class="hint">来自当前可用模型目录</span></label><select id="f_defaultModel">${modelOptions||'<option value="">暂无可用模型</option>'}</select></div><div class="field"><label>OpenAI 默认上游</label><select id="f_openaiApiUpstream"><option value="official" ${cfg.openaiApiUpstream==='official'?'selected':''}>官方 API</option>${relayOptions}</select></div></div></div><div class="form-footer">${button('保存设置','check','saveConfig()','btn-primary')}</div>`
  const credentialProtection=diagnosticsData.credential_protection||{}
  const info=`<div class="card-body"><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">网关版本</span><b>2.0.0</b></div><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">管理 API</span><code>/admin/api</code></div><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">配置热重载</span><span class="badge">已启用</span></div><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">凭据保护</span><span class="status ${credentialProtection.enabled?'':'off'}"><i></i>${credentialProtection.enabled?'DPAPI + AES-256-GCM':'未启用'}</span></div><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">数据存储</span><span>本地 JSON</span></div></div>`
  const snapshots=diagnosticsData.config_snapshots||[]
  const snapshotOptions=snapshots.map(item=>`<option value="${esc(item.name)}">${new Date(item.created_at).toLocaleString('zh-CN')} · ${esc(item.name.split('-').slice(6).join('-').replace('.json','')||'配置')}</option>`).join('')
  const rollback=`<div class="card-body"><div class="field"><label>配置快照 <span class="hint">最多保留最近 10 份</span></label><select id="config_snapshot">${snapshotOptions||'<option value="">暂无快照</option>'}</select></div></div><div class="form-footer">${button('回滚所选快照','refresh','rollbackConfigSnapshot()','btn-danger')}</div>`
  const accountBackups=diagnosticsData.account_backups||[]
  const accountBackupOptions=accountBackups.map(item=>`<option value="${esc(item.name)}">${new Date(item.created_at).toLocaleString('zh-CN')} · ${item.account_count==null?'格式待验证':item.account_count+' 个账号'}</option>`).join('')
  const accountRestore=`<div class="card-body"><div class="field"><label>账号备份 <span class="hint">删除和恢复前自动创建</span></label><select id="account_backup">${accountBackupOptions||'<option value="">暂无账号备份</option>'}</select><span class="hint">恢复仅补回当前缺失的账号，不覆盖现有账号、Token、名称或活动账号。敏感字段由当前 Windows 用户的 DPAPI 密钥加密。</span></div></div><div class="form-footer">${button('恢复缺失账号','refresh','restoreAccountBackup()','btn-danger')}</div>`
  const operations=`<div class="card-body"><div class="provider-row" style="grid-template-columns:1fr auto"><div><b>脱敏诊断报告</b><div class="cell-sub">包含队列、并发、额度和运行状态，不包含 Token</div></div>${button('下载报告','download','downloadDiagnostics()')}</div><div class="provider-row" style="grid-template-columns:1fr auto"><div><b>异常状态修复</b><div class="cell-sub">清理过期租约和异常冷却，不修改账号凭据</div></div>${button('立即检查','shield','repairRuntime()')}</div><div class="provider-row" style="grid-template-columns:1fr auto"><div><b>优雅重启代理</b><div class="cell-sub">停止接收新请求，等待当前请求完成后由看门狗恢复</div></div>${button('优雅重启','refresh','gracefulRestartProxy()','btn-danger')}</div></div>`
  const circuits=diagnosticsData.circuits||[]
  const openCircuits=circuits.filter(item=>item.state!=='closed')
  const circuitBody=`<div class="card-body">${circuits.length?circuits.map(item=>{const remaining=item.state==='open'?Math.max(0,30-Math.floor((Date.now()-Number(item.openedAt||0))/1000)):0;return `<div class="provider-row" style="grid-template-columns:1fr auto"><div><b>${esc(item.name)}</b><div class="cell-sub">${item.lastFailure?.message?esc(item.lastFailure.message):'暂无最近错误'}</div></div><span class="status ${item.state==='closed'?'':item.state==='half-open'?'warn':'off'}"><i></i>${item.state==='closed'?'正常':item.state==='half-open'?'正在探测':`熔断中 · 约 ${remaining} 秒后探测`}</span></div>`}).join(''):'<span class="cell-sub">尚无 Provider 熔断记录</span>'}</div><div class="form-footer">${button('重置熔断状态','refresh','resetCircuits()',openCircuits.length?'btn-danger':'')}</div>`
  return pageHead('系统设置','配置全局路由行为与管理控制台偏好')+`<div class="grid"><div>${card('路由偏好','应用于未指定模型或上游的请求',body)}${card('配置快照与回滚','只恢复设置，不回退账号 Token 和 API Key',rollback)}${card('账号备份与恢复','安全合并，不覆盖当前有效凭据',accountRestore)}${card('外观','保存在当前浏览器',`<div class="card-body"><div class="provider-row" style="grid-template-columns:1fr auto"><div><b>深色显示模式</b><div class="cell-sub">切换控制台配色，不影响网关服务</div></div>${button('切换主题','moon','toggleTheme()')}</div></div>`)}</div><div>${card('系统信息','当前运行环境',info)}${card('Provider 熔断状态',openCircuits.length?`${openCircuits.length} 个通道暂不可用`:'所有已记录通道正常',circuitBody)}${card('运维与安全','普通使用无需操作',operations)}</div></div>`
}
function render(){ const fn={overview:renderOverview,providers:renderProviders,relays:renderRelays,accounts:renderAccounts,analytics:renderAnalytics,settings:renderSettings,help:renderHelp}[activePage]; document.getElementById('app').innerHTML=fn() }

function collectConfig(){
  const keys=['deepseekApiKey','openaiApiKey','openaiOrgId','openaiProjectId','upstreamUrl','chatgptResponsesUrl','openaiApiBaseUrl','openaiApiResponsesUrl','openaiApiChatCompletionsUrl','openaiApiUpstream','defaultModel','chatgptAccountStrategy','chatgptLowQuotaThreshold']
  const data={}; keys.forEach(k=>{ const el=document.getElementById('f_'+k); if(el)data[k]=el.value.trim() }); return data
}
async function saveConfig(){
  try{ const r=await fetch(API+'/config',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(collectConfig())}); const d=await r.json(); if(!r.ok)throw new Error(d.error?.message||'保存失败'); cfg={...cfg,...d.config}; render(); toast('配置已保存并热重载') }catch(e){toast(e.message,'error')}
}
async function pingChannel(type,relayId){
  toast('正在检测通道…')
  try{ const r=await fetch(API+'/ping',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(relayId?{type,relayId}:{type})}); const d=await r.json(); pingResults[relayId?'relay:'+relayId:type]=d; render(); toast(d.ok?`连接正常 · ${d.latency} ms`:(d.error||'连接失败'),d.ok?'success':'error') }catch(e){toast(e.message,'error')}
}
async function pingAll(){
  toast('正在检测全部通道…')
  try{ const r=await fetch(API+'/ping-all',{method:'POST'}),d=await r.json(); Object.entries(d.results||{}).forEach(([k,v])=>pingResults[k]=v); render(); toast(d.allOk?'全部通道连接正常':'部分通道检测失败',d.allOk?'success':'error') }catch(e){toast(e.message,'error')}
}
function showModal(title,body,saveText,saveFn){
  closeModal(); const el=document.createElement('div'); el.className='modal-overlay'; el.onclick=e=>{if(e.target===el)closeModal()}
  el.innerHTML=`<div class="modal"><div class="modal-head"><strong>${title}</strong><button class="icon-btn" onclick="closeModal()">${svg('x')}</button></div><div class="modal-body">${body}</div><div class="modal-foot">${button('取消','','closeModal()')}${button(saveText,'check',saveFn,'btn-primary')}</div></div>`; document.body.appendChild(el); modal=el
}
function closeModal(){ if(loginPoll)clearInterval(loginPoll);loginPoll=null;if(modal)modal.remove(); modal=null }
function openRelay(id=''){
  const r=(cfg.relays||[]).find(x=>x.id===id)||{id:'',name:'',base_url:'https://api.openai.com/v1',api_key:'',models:['gpt-5.4','gpt-5.4-mini']}
  const quick=id?'':`<div class="field full"><label>CC Switch 快捷导入链接 <span class="hint">兼容 ccswitch://v1/import</span></label><div class="input-wrap"><input class="input" id="relay_deeplink" placeholder="粘贴供应商提供的 ccswitch:// 快捷链接"><button class="btn" onclick="readRelayLink()">${svg('download')}读取剪贴板</button><button class="btn" onclick="parseRelayLink()">解析</button></div><span class="hint" id="relay_link_hint">链接只在本地解析，不会访问供应商网站。</span></div><div class="divider full">或者手动填写</div>`
  showModal(id?'编辑中转节点':'添加中转节点',`<div class="form-grid">${quick}<div class="field"><label>节点 ID</label><input class="input" id="relay_id" value="${esc(r.id)}" ${id?'readonly':''} placeholder="例如 hk-01"></div><div class="field"><label>显示名称</label><input class="input" id="relay_name" value="${esc(r.name)}" placeholder="香港主节点"></div><div class="field full"><label>API Base URL</label><input class="input" id="relay_url" value="${esc(r.base_url)}"></div><div class="field full"><label>API Key</label><input class="input" type="password" id="relay_key" value="${esc(r.api_key)}"></div><div class="field full"><label>模型列表 <span class="hint">每行或逗号分隔</span></label><textarea id="relay_models">${esc((r.models||[]).join('\n'))}</textarea></div></div>`,'保存节点','saveRelay()')
}
async function readRelayLink(){
  try{document.getElementById('relay_deeplink').value=await navigator.clipboard.readText();parseRelayLink()}catch{toast('浏览器无法读取剪贴板，请手动粘贴链接','error')}
}
function decodeBase64Json(value){
  if(!value)return null
  let normalized=value.replace(/-/g,'+').replace(/_/g,'/')
  normalized+='='.repeat((4-normalized.length%4)%4)
  const bytes=Uint8Array.from(atob(normalized),c=>c.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}
function slugifyRelay(value){
  const slug=value.toLowerCase().trim().replace(/^https?:\/\//,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,36)
  return slug||('relay-'+Date.now().toString(36))
}
function parseRelayLink(){
  const raw=document.getElementById('relay_deeplink')?.value.trim()
  if(!raw)return toast('请先粘贴 CC Switch 快捷导入链接','error')
  try{
    if(!/^ccswitch:\/\/v1\/import\?/i.test(raw))throw new Error('不是受支持的 ccswitch://v1/import 链接')
    const query=raw.slice(raw.indexOf('?')+1),params=new URLSearchParams(query)
    if(params.get('resource')!=='provider')throw new Error('链接内容不是供应商配置')
    const app=(params.get('app')||'').toLowerCase()
    if(app&&app!=='codex'&&app!=='opencode')throw new Error(`该链接面向 ${app}，不是 Codex/OpenAI 兼容配置`)
    let name=params.get('name')||'',endpoint=(params.get('endpoint')||'').split(',')[0].trim()
    let apiKey=params.get('apiKey')||'',models=(params.get('model')||'').split(',').filter(Boolean)
    const encoded=params.get('config')
    if(encoded){
      try{
        const config=decodeBase64Json(encoded)||{}
        apiKey=apiKey||config.auth?.OPENAI_API_KEY||config.OPENAI_API_KEY||config.apiKey||''
        endpoint=endpoint||config.base_url||config.baseUrl||''
        const toml=typeof config.config==='string'?config.config:''
        endpoint=endpoint||(toml.match(/base_url\s*=\s*["']([^"']+)["']/i)?.[1]||'')
        const model=toml.match(/(?:^|\n)\s*model\s*=\s*["']([^"']+)["']/i)?.[1]
        if(!models.length&&model)models=[model]
      }catch{ /* Direct query fields can still be imported. */ }
    }
    if(!name||!endpoint)throw new Error('链接缺少供应商名称或 API 端点')
    document.getElementById('relay_name').value=name
    document.getElementById('relay_id').value=slugifyRelay(name)
    document.getElementById('relay_url').value=endpoint.replace(/\/+$/,'')
    document.getElementById('relay_key').value=apiKey
    if(models.length)document.getElementById('relay_models').value=models.join('\n')
    const hint=document.getElementById('relay_link_hint');if(hint)hint.textContent=`已解析：${name} · ${models.length||0} 个模型，请确认后保存`
    toast('供应商配置解析成功')
  }catch(e){toast(e.message,'error')}
}
async function saveRelay(){
  const body={id:document.getElementById('relay_id').value.trim(),name:document.getElementById('relay_name').value.trim(),base_url:document.getElementById('relay_url').value.trim().replace(/\/+$/,''),api_key:document.getElementById('relay_key').value.trim(),models:document.getElementById('relay_models').value.split(/[\n,]/).map(x=>x.trim()).filter(Boolean)}
  if(!body.id||!body.name||!body.base_url)return toast('请完整填写节点信息','error')
  try{const r=await fetch(API+'/relays',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),d=await r.json();if(!r.ok)throw new Error(d.error?.message||'保存失败');cfg=d.config;closeModal();render();toast('中转节点已保存')}catch(e){toast(e.message,'error')}
}
async function removeRelay(id){ if(!confirm('确定删除这个中转节点吗？'))return; try{const r=await fetch(API+'/relays/'+encodeURIComponent(id),{method:'DELETE'}),d=await r.json();if(!r.ok)throw new Error(d.error?.message||'删除失败');cfg=d.config;render();toast('节点已删除')}catch(e){toast(e.message,'error')} }
function openAccount(){
  showModal('快捷导入 ChatGPT 账号',`<div class="quick-import"><button class="quick-option" onclick="importCurrentAccount()">${svg('refresh')}<strong>一键导入当前账号</strong><small>自动读取本机 Codex CLI 的<br>~/.codex/auth.json</small></button><button class="quick-option" id="auth_drop" onclick="document.getElementById('auth_file').click()" ondragover="authDrag(event,true)" ondragleave="authDrag(event,false)" ondrop="authDrop(event)">${svg('download')}<strong>选择或拖拽 auth.json</strong><small>从电脑选择登录文件<br>读取后自动填入</small></button></div><input id="auth_file" type="file" accept=".json,application/json" class="hidden" onchange="loadAuthFile(this.files[0])"><div class="divider">或者手动粘贴</div><div class="form-grid"><div class="field full"><label>账号备注 <span class="hint">可选</span></label><input class="input" id="account_label" placeholder="例如：备用账号"></div><div class="field full"><label style="display:flex;align-items:center;gap:8px"><input id="account_routing_enabled" type="checkbox"> 导入后立即参与自动路由</label><span class="hint">默认仅保存到账号池，需要时可随时启用。</span></div><div class="field full"><label>auth.json 内容</label><textarea id="account_json" style="min-height:150px" placeholder='粘贴 Codex CLI 生成的完整 auth.json'></textarea><span class="hint" id="auth_file_hint">凭据仅保存在当前计算机。</span></div></div>`,'导入账号','saveAccount()')
}
function openRenameAccount(id){
  const account=(cfg.chatgptAccounts||[]).find(item=>item.id===id)
  if(!account)return toast('账号不存在','error')
  showModal('修改账号名称',`<div class="form-grid"><div class="field full"><label>账号名称</label><input class="input" id="rename_account_label" maxlength="80" value="${esc(account.label||account.email||'')}" placeholder="例如：工作账号" onkeydown="if(event.key==='Enter')saveAccountRename('${esc(id)}')"><span class="hint">仅修改本地显示名称，不影响 OpenAI 账号信息或登录状态。</span></div></div>`,'保存名称',`saveAccountRename('${esc(id)}')`)
  setTimeout(()=>document.getElementById('rename_account_label')?.select(),0)
}
async function saveAccountRename(id){
  const label=document.getElementById('rename_account_label')?.value.trim()
  if(!label)return toast('账号名称不能为空','error')
  try{
    const r=await fetch(API+'/chatgpt-accounts/'+encodeURIComponent(id)+'/rename',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({label})}),d=await r.json()
    if(!r.ok)throw new Error(d.error?.message||'改名失败')
    cfg=d.config;closeModal();render();toast(d.message||'账号名称已更新')
  }catch(e){toast(e.message,'error')}
}
function authDrag(event,on){event.preventDefault();event.stopPropagation();document.getElementById('auth_drop')?.classList.toggle('dragging',on)}
function authDrop(event){authDrag(event,false);loadAuthFile(event.dataTransfer?.files?.[0])}
async function loadAuthFile(file){
  if(!file)return
  if(!file.name.toLowerCase().endsWith('.json'))return toast('请选择 auth.json 文件','error')
  try{
    const text=await file.text(),parsed=JSON.parse(text)
    if(!parsed?.tokens)throw new Error('文件缺少 tokens 字段')
    document.getElementById('account_json').value=text
    document.getElementById('auth_file_hint').textContent=`已读取 ${file.name} · 点击“导入账号”完成`
    toast('auth.json 已读取')
  }catch(e){toast('无法读取文件：'+e.message,'error')}
}
async function importCurrentAccount(){
  try{
    const r=await fetch(API+'/chatgpt-accounts/import-current',{method:'POST'}),d=await r.json()
    if(!r.ok)throw new Error(d.error?.message||'快捷导入失败')
    cfg=d.config;closeModal();render();toast(d.message||'当前账号已导入')
  }catch(e){toast(e.message,'error')}
}
function openOfficialLogin(){
  showModal('OpenAI 官方安全登录',`<div class="form-grid"><div class="field full"><div style="padding:13px;border-radius:10px;background:var(--primary-soft);color:var(--primary);font-size:11px;line-height:1.7">登录通过隔离的 Codex app-server 浏览器 OAuth 完成，不会修改本机现有 Codex 的 auth.json。新账号默认仅保存，不参与代理路由。</div></div><div class="field full"><label>邮箱或账号备注 <span class="hint">仅用于账号池中识别，可选</span></label><input class="input" id="login_label" type="email" autocomplete="email" placeholder="例如 name@example.com"></div><div class="field full"><label style="display:flex;align-items:center;gap:8px"><input id="login_routing_enabled" type="checkbox"> 登录后立即参与自动路由</label><span class="hint">不勾选时只放入账号池，不影响当前 Codex，也不会被代理选中。</span></div><div class="field full"><label>登录流程</label><div id="login_status" class="input" style="height:auto;min-height:48px;display:flex;align-items:center;gap:9px;flex-wrap:wrap"><span class="status off"><i></i>等待开始</span></div></div><div class="field full"><span class="hint">完成官方页面的登录和授权后，本地回调会自动通知后台并导入账号。重复账号会被拒绝，不会覆盖已有账号。</span></div></div>`,'开始官方登录','startOfficialLogin()')
}
function loginStatusContent(d){
  const state=d.status==='waiting'?'warn':d.status==='success'?'':'off'
  const link=typeof d.verificationUrl==='string'&&d.verificationUrl.startsWith('https://')?`<a class="btn btn-sm btn-primary" href="${esc(d.verificationUrl)}" target="_blank" rel="noopener noreferrer">打开验证页（请确认私密模式）</a>`:''
  const code=d.userCode?`<code style="font-size:15px;font-weight:700;letter-spacing:1px">${esc(d.userCode)}</code><button class="btn btn-sm" onclick="copyDeviceCode('${esc(d.userCode)}')">复制验证码</button>`:''
  const cancel=d.status==='waiting'?button('取消','','cancelOfficialLogin()','btn-sm'):''
  return `<span class="status ${state}"><i></i>${esc(d.message||'等待设备授权信息…')}</span>${code}${link}${cancel}`
}
async function copyDeviceCode(code){
  try{await navigator.clipboard.writeText(code);toast('设备验证码已复制')}catch{toast('复制失败，请手动复制验证码','error')}
}
async function startOfficialLogin(){
  const label=document.getElementById('login_label')?.value.trim()||''
  const routingEnabled=document.getElementById('login_routing_enabled')?.checked===true
  const status=document.getElementById('login_status')
  status.innerHTML=`<span class="status warn"><i></i>正在启动 OpenAI 官方登录页面…</span>`
  try{
    const r=await fetch(API+'/chatgpt-login/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label,email:label,routingEnabled})}),d=await r.json()
    if(!r.ok)throw new Error(d.error?.message||'无法启动登录')
    status.innerHTML=loginStatusContent(d)
    loginPoll=setInterval(checkOfficialLogin,1200)
  }catch(e){status.innerHTML=`<span class="status off"><i></i>${esc(e.message)}</span>`;toast(e.message,'error')}
}
async function checkOfficialLogin(){
  try{
    const r=await fetch(API+'/chatgpt-login/status'),d=await r.json(),status=document.getElementById('login_status')
    if(!status)return
    if(d.status==='waiting'){status.innerHTML=loginStatusContent(d);return}
    clearInterval(loginPoll);loginPoll=null
    if(d.status==='success'){status.innerHTML=`<span class="status"><i></i>${esc(d.message)}</span>`;toast(d.message);setTimeout(async()=>{closeModal();await load()},700)}
    else if(d.status==='error'||d.status==='cancelled'){status.innerHTML=`<span class="status off"><i></i>${esc(d.message||'登录未完成')}</span>`;toast(d.message||'登录未完成','error')}
  }catch(e){clearInterval(loginPoll);loginPoll=null;toast(e.message,'error')}
}
async function cancelOfficialLogin(){await fetch(API+'/chatgpt-login/cancel',{method:'POST'});if(loginPoll)clearInterval(loginPoll);loginPoll=null;const status=document.getElementById('login_status');if(status)status.innerHTML='<span class="status off"><i></i>登录已取消</span>'}
async function saveAccount(){ const auth_json=document.getElementById('account_json').value.trim(),label=document.getElementById('account_label').value.trim(),routingEnabled=document.getElementById('account_routing_enabled')?.checked===true;if(!auth_json)return toast('请粘贴 auth.json 内容','error');try{JSON.parse(auth_json)}catch{return toast('auth.json 格式无效','error')}try{const r=await fetch(API+'/chatgpt-accounts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({auth_json,label,routingEnabled})}),d=await r.json();if(!r.ok)throw new Error(d.error?.message||'导入失败');cfg=d.config;closeModal();render();toast(d.message||(routingEnabled?'账号已导入并启用路由':'账号已导入，仅保存到账号池'))}catch(e){toast(e.message,'error')} }
async function removeAccount(id){const account=(cfg.chatgptAccounts||[]).find(item=>item.id===id);const name=account?.label||account?.email||'未命名账号',shortId=String(account?.account_id||id).slice(0,12);if(!confirm(`确定移除账号「${name}」吗？\n账号 ID：${shortId}…\n\n删除前会自动创建独立账号备份。`))return;try{const r=await fetch(API+'/chatgpt-accounts/'+encodeURIComponent(id),{method:'DELETE'}),d=await r.json();if(!r.ok)throw new Error(d.error?.message||'移除失败');cfg=d.config;render();toast('账号已移除，删除前数据已备份')}catch(e){toast(e.message,'error')}}
async function refreshAllUsage(){
  toast('正在刷新全部账号用量…')
  try{const r=await fetch(API+'/chatgpt-accounts/refresh-usage-all',{method:'POST'}),d=await r.json();if(!r.ok)throw new Error(d.error?.message||'刷新失败');cfg=d.config;render();toast(d.message||'用量已刷新')}catch(e){toast(e.message,'error')}
}
async function refreshAccountUsageOne(id){
  try{const r=await fetch(API+'/chatgpt-accounts/'+encodeURIComponent(id)+'/refresh-usage',{method:'POST'}),d=await r.json();if(!r.ok)throw new Error(d.error?.message||'刷新失败');cfg=d.config;render();toast(d.message||'用量已刷新')}catch(e){toast(e.message,'error')}
}
function startAccountDrag(event,id){
  draggedAccountId=id
  event.dataTransfer.effectAllowed='move'
  event.dataTransfer.setData('text/plain',id)
}
async function dropAccount(event,targetId){
  event.preventDefault()
  const sourceId=draggedAccountId||event.dataTransfer.getData('text/plain')
  draggedAccountId=null
  if(!sourceId||sourceId===targetId)return
  const ids=(cfg.chatgptAccounts||[]).map(account=>account.id)
  const sourceIndex=ids.indexOf(sourceId)
  if(sourceIndex<0||ids.indexOf(targetId)<0)return
  ids.splice(sourceIndex,1)
  ids.splice(ids.indexOf(targetId),0,sourceId)
  try{
    const r=await fetch(API+'/chatgpt-accounts/reorder',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({accountIds:ids})}),d=await r.json()
    if(!r.ok)throw new Error(d.error?.message||'优先级更新失败')
    cfg=d.config;render();toast('账号优先级已更新')
  }catch(e){toast(e.message,'error');await load()}
}
async function updateAccountWeight(id,weight){
  try{
    const r=await fetch(API+'/chatgpt-accounts/'+encodeURIComponent(id)+'/routing',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({weight:Number(weight)})}),d=await r.json()
    if(!r.ok)throw new Error(d.error?.message||'权重更新失败')
    cfg=d.config;render();toast('账号权重已更新')
  }catch(e){toast(e.message,'error');await load()}
}
async function toggleAccountRouting(id,enabled){
  try{
    const r=await fetch(API+'/chatgpt-accounts/'+encodeURIComponent(id)+'/routing',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:Boolean(enabled)})}),d=await r.json()
    if(!r.ok)throw new Error(d.error?.message||'账号状态更新失败')
    cfg=d.config;render();toast(d.message||'账号路由状态已更新')
  }catch(e){toast(e.message,'error');await load()}
}
async function switchAccount(id){
  if(!confirm('确定切换到该账号吗？这会覆盖本机 Codex 的登录状态，并尝试重启本机 Codex 进程。'))return
  try{const r=await fetch(API+'/chatgpt-accounts/'+encodeURIComponent(id)+'/switch',{method:'POST'}),d=await r.json();if(!r.ok)throw new Error(d.error?.message||'切换失败');cfg=d.config;render();toast(d.message||'已切换账号')}catch(e){toast(e.message,'error')}
}
async function restartCodex(){
  toast('正在尝试重启本机 Codex 进程…')
  try{const r=await fetch(API+'/codex/restart',{method:'POST'}),d=await r.json();if(!r.ok)throw new Error(d.error?.message||'重启失败');toast(d.message||'已尝试重启')}catch(e){toast(e.message,'error')}
}
async function downloadDiagnostics(){
  try{
    const r=await fetch(API+'/diagnostics'),d=await r.json()
    if(!r.ok)throw new Error(d.error?.message||'生成诊断报告失败')
    const blob=new Blob([JSON.stringify(d,null,2)],{type:'application/json'})
    const url=URL.createObjectURL(blob),a=document.createElement('a')
    a.href=url;a.download=`codex-proxy-diagnostics-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;a.click()
    setTimeout(()=>URL.revokeObjectURL(url),1000);toast('脱敏诊断报告已生成')
  }catch(e){toast(e.message,'error')}
}
async function repairRuntime(){
  try{
    const r=await fetch(API+'/runtime-repair',{method:'POST'}),d=await r.json()
    if(!r.ok)throw new Error(d.error?.message||'修复失败')
    toast(d.message);await load(false,false)
  }catch(e){toast(e.message,'error')}
}
async function rollbackConfigSnapshot(){
  const name=document.getElementById('config_snapshot')?.value
  if(!name)return toast('当前没有可回滚的配置快照','error')
  if(!confirm('确定回滚到所选设置吗？\n\n会恢复：模型、端点和路由偏好。\n不会回退：ChatGPT 账号、Token、当前活动账号和 API Key。\n当前设置会先自动备份。'))return
  try{
    const r=await fetch(API+'/config-rollback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name})}),d=await r.json()
    if(!r.ok)throw new Error(d.error?.message||'回滚失败')
    cfg=d.config;toast(d.message);await load(false,false)
  }catch(e){toast(e.message,'error')}
}
async function restoreAccountBackup(){
  const name=document.getElementById('account_backup')?.value
  if(!name)return toast('当前没有可恢复的账号备份','error')
  if(!confirm('确定从所选备份补回缺失账号吗？\n\n现有账号、Token、名称和当前活动账号不会被覆盖。恢复前还会自动备份当前账号池。'))return
  try{
    const r=await fetch(API+'/account-backups/restore',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name})}),d=await r.json()
    if(!r.ok)throw new Error(d.error?.message||'账号恢复失败')
    cfg=d.config;toast(d.message);await load(false,false)
  }catch(e){toast(e.message,'error')}
}
async function gracefulRestartProxy(){
  const active=(diagnosticsData.accounts||[]).reduce((sum,item)=>sum+Number(item.active_requests||0),0),queued=Number(diagnosticsData.queue?.depth||0)
  if(!confirm(`确定优雅重启代理吗？\n\n当前活动请求：${active}\n排队请求：${queued}\n\n服务会停止接收新请求，等待进行中的请求尽量完成。`))return
  try{
    const r=await fetch(API+'/proxy/restart',{method:'POST'}),d=await r.json()
    if(!r.ok)throw new Error(d.error?.message||'无法发起重启')
    toast(d.message)
    for(let i=0;i<30;i++){
      await new Promise(resolve=>setTimeout(resolve,1000))
      try{const live=await fetch('/live',{cache:'no-store'});if(live.ok&&i>1){toast('代理已恢复运行');await load(false,false);return}}catch{}
    }
    toast('代理仍在重启，请稍后刷新页面','error')
  }catch(e){toast(e.message,'error')}
}
async function resetCircuits(){
  if(!confirm('确定重置全部 Provider 熔断状态吗？如果上游仍不可用，熔断会再次自动开启。'))return
  try{const r=await fetch(API+'/resilience',{method:'DELETE'}),d=await r.json();if(!r.ok)throw new Error(d.error?.message||'重置失败');diagnosticsData.circuits=d.circuits||[];render();toast('熔断状态已重置')}catch(e){toast(e.message,'error')}
}
async function resetStats(){if(!confirm('确定清空全部本地用量统计吗？'))return;try{const r=await fetch(API+'/stats',{method:'DELETE'});statsData=await r.json();render();toast('统计数据已清空')}catch(e){toast(e.message,'error')}}
function toast(message,type='success'){document.querySelector('.toast')?.remove();const el=document.createElement('div');el.className='toast '+type;el.innerHTML=`${svg(type==='error'?'x':'check')}<span>${esc(message)}</span>`;document.body.appendChild(el);setTimeout(()=>el.remove(),2800)}

window.addEventListener('hashchange',()=>switchPage(location.hash.slice(1)))
document.getElementById('refreshButton').innerHTML=svg('refresh')
document.getElementById('menuButton').innerHTML=svg('overview')
initTheme(); switchPage(activePage); load()
