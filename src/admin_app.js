const API = '/admin/api'
let cfg = {}, statsData = { providers: {} }, diagnosticsData = { accounts: [], queue: {}, config_snapshots: [], account_backups: [], recent_route_decisions: [], provider_health: {providers:{}}, credential_protection: {}, circuits: [] }, modelCatalog = [], activePage = location.hash.slice(1) || 'overview'
let pingResults = {}, modal = null, loginPoll = null, accountsPoll = null, draggedAccountId = null, resetQuotaSubmitting = false
let errorGuideData = []
let loginPreflightData = null
let priceCatalogData = { prices: {} }, costReportData = { providers: {} }
let accountViewMode = localStorage.getItem('codex-account-view') === 'compact' ? 'compact' : 'cards'
let healthRange = ['1h','24h','7d'].includes(localStorage.getItem('codex-health-range')) ? localStorage.getItem('codex-health-range') : '24h'
let usageCalendarMonth = statsDateKey().slice(0,7)
let animateNextRender = true

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
  plus:'<path d="M12 5v14M5 12h14"/>', check:'<path d="m5 12 4 4L19 6"/>', pulse:'<path d="M3 12h4l2-7 4 14 2-7h6"/>', server:'<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>', users:'<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6m3-3h-6"/>', arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>', trash:'<path d="M3 6h18M8 6V4h8v2m3 0-1 15H6L5 6m5 5v6m4-6v6"/>', edit:'<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"/>', eye:'<circle cx="12" cy="12" r="3"/><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/>', x:'<path d="m6 6 12 12M18 6 6 18"/>', download:'<path d="M12 3v12m-5-5 5 5 5-5M5 21h14"/>', shield:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>', list:'<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3" cy="6" r="1"/><circle cx="3" cy="12" r="1"/><circle cx="3" cy="18" r="1"/>', cards:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'
}
function svg(name, cls=''){ return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icons[name]||''}</svg>` }
function esc(v=''){ return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) }
function fmt(n=0){ n=Number(n)||0; return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':n.toLocaleString('zh-CN') }
function allProviders(){ return Object.values(statsData.providers||{}) }
function totals(){ return allProviders().reduce((a,p)=>({requests:a.requests+(p.requests||0),input:a.input+(p.input_tokens||0),output:a.output+(p.output_tokens||0)}),{requests:0,input:0,output:0}) }
const analyticsColors=['#1769e0','#10a37f','#f59e0b','#8b5cf6','#ec4899','#06b6d4','#ef4444','#64748b']
function statsDateKey(value=new Date()){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(value)
  const part=type=>parts.find(item=>item.type===type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}
function dayNumber(key){
  const [year,month,day]=String(key).split('-').map(Number)
  return Math.floor(Date.UTC(year,month-1,day)/86400000)
}
function dayKeyFromNumber(value){
  const date=new Date(value*86400000)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')}`
}
function normalizedDaily(days=30){
  const end=dayNumber(statsDateKey())
  return Array.from({length:days},(_,index)=>{
    const key=dayKeyFromNumber(end-days+1+index)
    const value=(statsData.daily||{})[key]||{}
    return {
      key,
      requests:Number(value.requests)||0,
      account_attempts:Number(value.account_attempts)||0,
      input_tokens:Number(value.input_tokens)||0,
      output_tokens:Number(value.output_tokens)||0,
      providers:value.providers||{},
      accounts:value.accounts||{}
    }
  })
}
function dailyTokens(day){ return (Number(day?.input_tokens)||0)+(Number(day?.output_tokens)||0) }
function dayLabel(key,withYear=false){
  const [year,month,day]=key.split('-').map(Number)
  return new Date(Date.UTC(year,month-1,day)).toLocaleDateString('zh-CN',{timeZone:'UTC',...(withYear?{year:'numeric'}:{}),month:'short',day:'numeric'})
}
function activeStreak(){
  const daily=statsData.daily||{}, today=dayNumber(statsDateKey())
  const active=key=>{ const day=daily[key]||{}; return dailyTokens(day)>0||(Number(day.requests)||0)>0 }
  let offset=active(dayKeyFromNumber(today))?0:-1
  if(offset<0&&!active(dayKeyFromNumber(today-1)))return 0
  let streak=0
  while(streak<370&&active(dayKeyFromNumber(today+offset-streak)))streak++
  return streak
}
function accountSeriesMeta(){
  const configured=cfg.chatgptAccounts||[], labels=new Map(configured.map(account=>[account.id,account.label||account.account_id||account.id]))
  const ids=[...configured.map(account=>account.id)]
  for(const day of Object.values(statsData.daily||{})){
    for(const id of Object.keys(day.accounts||{}))if(!ids.includes(id))ids.push(id)
  }
  return ids.filter(Boolean).map((id,index)=>({id,label:labels.get(id)||id,color:analyticsColors[index%analyticsColors.length]}))
}
function shiftUsageCalendarMonth(offset){
  const [year,month]=usageCalendarMonth.split('-').map(Number)
  const next=new Date(Date.UTC(year,month-1+offset,1))
  const key=`${next.getUTCFullYear()}-${String(next.getUTCMonth()+1).padStart(2,'0')}`
  if(key>statsDateKey().slice(0,7))return
  usageCalendarMonth=key
  render()
}
function resetUsageCalendarMonth(){
  usageCalendarMonth=statsDateKey().slice(0,7)
  render()
}
function usageHeatmap(){
  const [year,month]=usageCalendarMonth.split('-').map(Number)
  const dayCount=new Date(Date.UTC(year,month,0)).getUTCDate()
  const days=Array.from({length:dayCount},(_,index)=>{
    const key=`${usageCalendarMonth}-${String(index+1).padStart(2,'0')}`, value=(statsData.daily||{})[key]||{}
    return {
      key,
      requests:Number(value.requests)||0,
      account_attempts:Number(value.account_attempts)||0,
      input_tokens:Number(value.input_tokens)||0,
      output_tokens:Number(value.output_tokens)||0
    }
  })
  const firstWeekday=(new Date(Date.UTC(year,month-1,1)).getUTCDay()+6)%7
  const cells=[...Array(firstWeekday).fill(null),...days]
  while(cells.length%7)cells.push(null)
  const activityValues=days.map(day=>dailyTokens(day)||day.requests)
  const max=Math.max(0,...activityValues)
  const level=day=>{
    const value=dailyTokens(day)||day.requests
    return value&&max?Math.max(1,Math.min(4,Math.ceil(Math.log1p(value)/Math.log1p(max)*4))):0
  }
  const activeDays=days.filter(day=>(dailyTokens(day)||day.requests)>0).length
  const requests=days.reduce((sum,day)=>sum+day.requests,0)
  const attempts=days.reduce((sum,day)=>sum+day.account_attempts,0)
  const tokens=days.reduce((sum,day)=>sum+dailyTokens(day),0)
  const cellHtml=cells.map(day=>day
    ? `<div class="usage-month-day level-${level(day)} ${day.key===statsDateKey()?'is-today':''}" title="${esc(`${dayLabel(day.key,true)} · ${fmt(day.requests)} 次请求 · 输入 ${fmt(day.input_tokens)} / 输出 ${fmt(day.output_tokens)} Token`)}"><span>${Number(day.key.slice(-2))}</span><b>${dailyTokens(day)?fmt(dailyTokens(day)):day.requests?`${fmt(day.requests)} 次`:''}</b></div>`
    : '<div class="usage-month-day is-blank"></div>').join('')
  const currentMonth=statsDateKey().slice(0,7), isCurrent=usageCalendarMonth===currentMonth
  return `<div class="usage-calendar">
    <div class="usage-calendar-top">
      <div class="usage-calendar-toolbar"><div><strong>${year} 年 ${month} 月</strong><span>${isCurrent?'当前月份':'历史月份'}</span></div><div class="usage-calendar-nav"><button onclick="shiftUsageCalendarMonth(-1)" title="上一个月">‹</button>${isCurrent?'':`<button class="calendar-today" onclick="resetUsageCalendarMonth()">本月</button>`}<button onclick="shiftUsageCalendarMonth(1)" title="下一个月" ${isCurrent?'disabled':''}>›</button></div></div>
      <div class="usage-calendar-summary"><div><span>本月 Token</span><strong>${fmt(tokens)}</strong></div><div><span>活跃天数</span><strong>${activeDays}</strong></div><div><span>完成请求</span><strong>${fmt(requests)}</strong></div><div><span>账号尝试</span><strong>${fmt(attempts)}</strong></div></div>
    </div>
    <div class="usage-month-calendar"><div class="usage-month-weekdays">${['周一','周二','周三','周四','周五','周六','周日'].map(label=>`<span>${label}</span>`).join('')}</div><div class="usage-month-grid">${cellHtml}</div></div>
    <div class="usage-calendar-foot"><span>方格颜色按当月 Token 用量计算，无 Token 数据时按请求数计算</span><div class="usage-heatmap-legend"><span>少</span>${[0,1,2,3,4].map(value=>`<i class="usage-heatmap-cell level-${value}"></i>`).join('')}<span>多</span></div></div>
  </div>`
}
function trendChart(days,lines,{id='trend',unit='Token'}={}){
  const width=760,height=288,left=58,right=22,top=24,bottom=43,plotWidth=width-left-right,plotHeight=height-top-bottom
  const values=days.flatMap(day=>lines.map(line=>Math.max(0,Number(line.value(day))||0)))
  const max=Math.max(1,...values)
  const x=index=>left+(days.length===1?plotWidth/2:index/(days.length-1)*plotWidth)
  const y=value=>top+plotHeight-(value/max*plotHeight)
  const grids=Array.from({length:5},(_,index)=>{
    const value=max*(4-index)/4,py=top+plotHeight*index/4
    return `<line x1="${left}" y1="${py}" x2="${width-right}" y2="${py}" class="trend-grid-line"/><text x="${left-10}" y="${py+4}" text-anchor="end" class="trend-axis-text">${fmt(value)}</text>`
  }).join('')
  const labelIndexes=[0,Math.floor((days.length-1)*.25),Math.floor((days.length-1)*.5),Math.floor((days.length-1)*.75),days.length-1].filter((value,index,array)=>array.indexOf(value)===index)
  const xLabels=labelIndexes.map(index=>`<text x="${x(index)}" y="${height-13}" text-anchor="${index===0?'start':index===days.length-1?'end':'middle'}" class="trend-axis-text">${dayLabel(days[index].key)}</text>`).join('')
  const paths=lines.map((line,lineIndex)=>{
    const points=days.map((day,index)=>`${x(index)},${y(line.value(day))}`)
    const area=line.fill?`<path d="M ${x(0)} ${top+plotHeight} L ${points.join(' L ')} L ${x(days.length-1)} ${top+plotHeight} Z" fill="url(#${id}-fill)" class="trend-area"/>`:''
    const dots=days.map((day,index)=>`<circle cx="${x(index)}" cy="${y(line.value(day))}" r="2.2" fill="${line.color}" class="trend-dot"><title>${esc(`${dayLabel(day.key,true)} · ${line.label} ${fmt(line.value(day))} ${unit}`)}</title></circle>`).join('')
    return `${lineIndex===0&&line.fill?`<defs><linearGradient id="${id}-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${line.color}" stop-opacity=".22"/><stop offset="1" stop-color="${line.color}" stop-opacity="0"/></linearGradient></defs>`:''}${area}<polyline points="${points.join(' ')}" fill="none" stroke="${line.color}" stroke-width="${line.width||2.5}" stroke-linecap="round" stroke-linejoin="round" class="trend-line"/>${dots}`
  }).join('')
  const legend=lines.map(line=>`<span><i style="background:${line.color}"></i>${esc(line.label)}</span>`).join('')
  const hasData=values.some(value=>value>0)
  return `<div class="trend-chart ${hasData?'':'is-empty'}"><div class="trend-legend">${legend}<small>最近 ${days.length} 天 · ${unit}</small></div><div class="trend-svg-scroll"><svg class="trend-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(unit)} 使用趋势">${grids}${xLabels}${paths}</svg></div>${hasData?'':`<div class="trend-empty-note">每日数据将从本版本启用后开始积累</div>`}</div>`
}
function dailyAccountTable(days,accounts){
  const accountMaxTokens=new Map(accounts.map(account=>[
    account.id,
    Math.max(1,...days.map(day=>{
      const value=day.accounts[account.id]||{}
      return (Number(value.input_tokens)||0)+(Number(value.output_tokens)||0)
    }))
  ]))
  const weekday=key=>{
    const [year,month,day]=key.split('-').map(Number)
    return new Date(Date.UTC(year,month-1,day)).toLocaleDateString('zh-CN',{timeZone:'UTC',weekday:'short'})
  }
  const rows=[...days].reverse().map(day=>`<tr class="${day.requests||day.account_attempts||dailyTokens(day)?'has-usage':'is-idle'}">
    <td><div class="daily-date"><b>${dayLabel(day.key)}</b><small>${weekday(day.key)}${day.key===statsDateKey()?' · 今天':''}</small></div></td>
    <td><div class="daily-total-cell"><div><strong>${fmt(dailyTokens(day))}</strong><span>Token</span></div><small><b>${fmt(day.requests)}</b> 完成请求 · <b>${fmt(day.account_attempts)}</b> 路由尝试</small><em>输入 ${fmt(day.input_tokens)} · 输出 ${fmt(day.output_tokens)}</em></div></td>
    ${accounts.map(account=>{
      const value=day.accounts[account.id]||{}, tokens=(Number(value.input_tokens)||0)+(Number(value.output_tokens)||0), requests=Number(value.requests)||0
      if(!requests&&!tokens)return '<td><div class="daily-account-empty">—<small>无调用</small></div></td>'
      const percent=Math.max(5,Math.min(100,tokens/accountMaxTokens.get(account.id)*100))
      return `<td><div class="daily-account-usage"><div><strong>${fmt(requests)} 次</strong><span>${fmt(tokens)} Token</span></div><i><b style="width:${percent}%;background:${account.color}"></b></i><small><em class="success">成功 ${fmt(value.successes)}</em><em class="${Number(value.failures)?'failure':''}">失败 ${fmt(value.failures)}</em></small></div></td>`
    }).join('')}
  </tr>`).join('')
  return `<div class="table-wrap daily-table-wrap"><table class="table daily-usage-table"><thead><tr><th>日期</th><th>当日总览</th>${accounts.map(account=>`<th><div class="daily-account-head"><span class="account-color" style="background:${account.color}"></span><div><b>${esc(account.label)}</b><small>请求与 Token</small></div></div></th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`
}

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
  document.getElementById('sidebar').classList.remove('open'); animateNextRender=true; renderNav(); render()
  if(accountsPoll){clearInterval(accountsPoll);accountsPoll=null}
  if(activePage==='accounts')accountsPoll=setInterval(()=>{if(!document.hidden)load(false,false)},60000)
}
function toggleSidebar(){ document.getElementById('sidebar').classList.toggle('open') }
function initTheme(){
  const dark=localStorage.getItem('codex-theme')==='dark'||(!localStorage.getItem('codex-theme')&&matchMedia('(prefers-color-scheme:dark)').matches)
  document.documentElement.dataset.theme=dark?'dark':'light'; document.getElementById('themeButton').innerHTML=svg(dark?'sun':'moon')
}
function toggleTheme(){ const dark=document.documentElement.dataset.theme!=='dark'; document.documentElement.dataset.theme=dark?'dark':'light'; localStorage.setItem('codex-theme',dark?'dark':'light'); document.getElementById('themeButton').innerHTML=svg(dark?'sun':'moon') }
function setAccountViewMode(mode){
  accountViewMode=mode==='compact'?'compact':'cards'
  localStorage.setItem('codex-account-view',accountViewMode)
  render()
}
function setHealthRange(range){
  if(!['1h','24h','7d'].includes(range))return
  healthRange=range
  localStorage.setItem('codex-health-range',range)
  render()
}

async function load(showMessage=false,includeModels=true){
  const btn=document.getElementById('refreshButton'); btn.innerHTML=svg('refresh')
  try{
    const [c,s,d,r,m,e,p,cost]=await Promise.all([fetch(API+'/config'),fetch(API+'/stats'),fetch(API+'/diagnostics').catch(()=>null),fetch(API+'/resilience').catch(()=>null),includeModels?fetch('/v1/models').catch(()=>null):null,fetch(API+'/error-guide').catch(()=>null),fetch(API+'/prices').catch(()=>null),fetch(API+'/costs').catch(()=>null)])
    if(!c.ok||!s.ok) throw new Error('服务响应异常')
    cfg=(await c.json()).config||{}; statsData=await s.json()
    if(d?.ok)diagnosticsData=await d.json()
    if(r?.ok)diagnosticsData.circuits=(await r.json()).circuits||[]
    if(m?.ok)modelCatalog=((await m.json()).data||[]).map(model=>({id:model.id,name:model.display_name||model.id}))
    if(e?.ok)errorGuideData=(await e.json()).codes||[]
    if(p?.ok)priceCatalogData=await p.json()
    if(cost?.ok)costReportData=await cost.json()
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
    const p=(statsData.providers||{})[key]||{}, result=pingResults[key]
    const healthProviders=diagnosticsData.provider_health?.providers||{}
    const relayHealth=key==='relay'?Object.entries(healthProviders).filter(([id])=>id.startsWith('relay:')).map(([,value])=>value):[]
    const persisted=key==='relay'
      ? (relayHealth.find(item=>item.state==='unhealthy'||item.state==='auth_error')||relayHealth.find(item=>item.state==='degraded')||relayHealth[0])
      : healthProviders[key]
    const healthLabel={healthy:'正常',degraded:'受限',auth_error:'鉴权异常',unhealthy:'异常',unknown:'未知'}
    const status=result?(result.ok?'正常':'异常'):(persisted?healthLabel[persisted.state]||'未知':state)
    const statusClass=status==='正常'?'':status==='已配置'||status==='受限'||status==='未知'?'warn':'off'
    const latency=result?.latency??persisted?.last_latency_ms
    const checked=result?'刚刚检测':persisted?.last_checked_at?`最近 ${new Date(persisted.last_checked_at).toLocaleString('zh-CN')}`:'尚无健康记录'
    const trend=persisted?.windows?.[healthRange]
    const trendText=trend?.requests?`${healthRange} ${trend.success_rate??'-'}% · P95 ${fmt(trend.p95_latency_ms)} ms · 429 ${trend.rate_limited}`:checked
    const healthTitle=persisted?.last_error?` title="${esc(persisted.last_error)}"`:''
    return `<div class="provider-row"><div class="provider-name"><span class="provider-logo ${logo}">${logo==='chatgpt'?'G':logo==='openai'?'AI':logo==='deepseek'?'D':'R'}</span><div><strong>${name}</strong><small>${sub}</small></div></div><div class="latency-cell"${healthTitle}><span class="status ${statusClass}"><i></i>${status}</span><div class="cell-sub">${trendText}</div>${persisted?.trend_warning?`<div class="cell-sub" style="color:var(--red)">${esc(persisted.trend_warning.message)}</div>`:''}</div><div class="usage-cell"><span class="cell-sub">${fmt(p.requests)} 次请求</span><div class="mini-bar"><i style="width:${Math.min(100,(p.requests||0)/Math.max(1,totals().requests)*100)}%"></i></div></div><button class="btn btn-sm" onclick="pingChannel('${key}')">${svg('pulse')}检测</button></div>`
  }).join('')
}
function deploymentBanner(){
  const deployment=diagnosticsData.deployment
  if(!deployment)return ''
  const consistency=deployment.consistency||{}
  if(consistency.synchronized===true)return ''
  const source=deployment.source?.path||'未识别工作区'
  const installation=deployment.installation?.path||'未识别安装目录'
  const message=consistency.synchronized===false
    ? `检测到工作区与实际安装目录有 ${Number(consistency.difference_count)||0} 个运行文件不一致。`
    : '当前运行实例无法定位对应工作区，不能自动判断是否已部署最新代码。'
  const action=deployment.can_deploy?button('备份并部署更新','refresh','deployWorkspaceUpdate()','btn-danger'):''
  return `<div class="help-note" style="margin-bottom:18px;border-color:color-mix(in srgb,var(--red) 32%,var(--border));background:color-mix(in srgb,var(--red) 6%,var(--surface))"><div style="display:flex;align-items:center;justify-content:space-between;gap:14px"><div><b style="color:var(--red)">运行版本不一致</b><p>${esc(message)}<br>工作区：${esc(source)}<br>安装目录：${esc(installation)}</p></div>${action}</div></div>`
}
function diagnosisCenter(){
  const diagnosis=diagnosticsData.automatic_diagnosis
  if(!diagnosis)return ''
  const issues=diagnosis.issues||[]
  const tone=diagnosis.summary?.level==='critical'?'off':diagnosis.summary?.level==='warning'?'warn':''
  const body=issues.length?issues.slice(0,8).map(issue=>{
    const actions=(issue.actions||[]).map(item=>`<button class="btn btn-sm" onclick="runDiagnosisAction('${esc(item.id)}','${esc(item.target||'')}')">${esc(item.label)}</button>`).join('')
    return `<div class="provider-row" style="grid-template-columns:minmax(0,1fr) auto"><div><span class="status ${issue.level==='critical'?'off':'warn'}"><i></i><b>${esc(issue.title)}</b></span><div class="cell-sub" style="margin-top:5px">${esc(issue.conclusion)}</div></div><div class="card-actions">${actions}</div></div>`
  }).join(''):`<div class="help-note"><span class="status ${tone}"><i></i>${esc(diagnosis.summary?.conclusion||'未发现明显异常')}</span></div>`
  const pool=diagnosis.account_pool||{},ops=diagnosis.trends?.operational||{}
  const summary=`可用 ${Number(pool.eligible)||0} · 仅保存 ${Number(pool.stored_only)||0} · 冷却 ${Number(pool.cooling||0)+Number(pool.model_cooling||0)} · 额度不足 ${Number(pool.below_reserve)||0} · 并发满 ${Number(pool.busy)||0} · 24h 切换 ${Number(ops['24h']?.account_switches)||0} / 熔断 ${Number(ops['24h']?.circuit_opens)||0}`
  return card('自动诊断中心',summary,`<div class="card-body">${body}</div>`,button('重新分析','pulse','refreshDiagnosis()','btn-sm'))
}
function renderOverview(){
  const t=totals()
  const today=normalizedDaily(1)[0]
  const recent=allProviders().flatMap(p=>Object.entries(p.models||{})).sort((a,b)=>(b[1].requests||0)-(a[1].requests||0)).slice(0,4)
  const activity=recent.length?recent.map(([name,v])=>`<div class="activity"><span class="activity-icon">${svg('arrow')}</span><div><p><b>${esc(name)}</b> 完成 ${fmt(v.requests)} 次路由请求</p><small>输入 ${fmt(v.input_tokens)} · 输出 ${fmt(v.output_tokens)} Tokens</small></div></div>`).join(''):empty('pulse','暂无调用记录','请求将在这里实时汇总')
  return pageHead('控制台概览','统一查看模型网关、账号池和节点状态',button('检测全部通道','pulse','pingAll()','btn-primary'))+
    deploymentBanner()+
    `<div class="metrics">${metric('今日请求',fmt(today.requests),'pulse',`累计完成 ${fmt(t.requests)} 次`)}${metric('今日 Token',fmt(dailyTokens(today)),'analytics',`输入 ${fmt(today.input_tokens)} · 输出 ${fmt(today.output_tokens)}`)}${metric('连续活跃',`${activeStreak()} 天`,'server','以每天产生请求或 Token 记录计算')}${metric('账号池',String((cfg.chatgptAccounts||[]).length),'users',`今日 ${fmt(today.account_attempts)} 次账号路由尝试`)}</div>`+
    diagnosisCenter()+
    `<div class="grid overview-grid">${card('AI 使用日历','按月查看 · 默认显示当前月份 · 数据仅保存在本机',`<div class="card-body usage-calendar-body">${usageHeatmap()}</div>`)}${card('最近调用','按模型请求量排序',`<div class="card-body">${activity}</div>`)}${card('服务状态','上游通道与实时连通性',`<div class="card-body">${providerRows()}</div>`,button('管理服务','',"switchPage('providers')",'btn-sm'))}${card('运行信息','当前网关环境',`<div class="card-body"><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">默认模型</span><b>${esc(cfg.defaultModel||'-')}</b></div><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">统计更新时间</span><b>${statsData.updated?new Date(statsData.updated).toLocaleTimeString('zh-CN'):'-'}</b></div><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">部署模式</span><span class="badge">Local</span></div></div>`)}</div>`
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
    if(account?.usage_sync_status==='synced'&&(account?.usage?.primary||account?.usage?.secondary))return '<span class="cell-sub">官方当前未提供此额度窗口</span>'
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
function renderAccountsLegacy(){
  const accounts=cfg.chatgptAccounts||[]
  const threshold=Number(cfg.chatgptLowQuotaThreshold??10)
  const remainingOf=a=>{
    const values=[a.usage&&a.usage.primary,a.usage&&a.usage.secondary].filter(Boolean).map(w=>w.remaining_percent==null?(w.used_percent==null?null:100-Number(w.used_percent)):Number(w.remaining_percent)).filter(Number.isFinite)
    return values.length?Math.min(...values):null
  }
  const diagnosedAvailable=diagnosticsData.automatic_diagnosis?.account_pool?.eligible
  const available=Number.isFinite(Number(diagnosedAvailable))
    ? Number(diagnosedAvailable)
    : accounts.filter(a=>{
      const reserve=Number(a.low_quota_threshold??threshold)
      return (a.status==='active'||!a.status)&&a.routing_enabled!==false&&(remainingOf(a)==null||remainingOf(a)>reserve)
    }).length
  const activeId=cfg.activeChatgptAccountId
  const activeLabel=accounts.find(a=>a.id===activeId)
  const resetTotal=accounts.reduce((sum,a)=>sum+Number(a.reset_credits?.available_count||0),0)
  const beijingTime=value=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})
  const body=accounts.length?`<div class="table-wrap account-matrix-wrap"><table class="table account-matrix"><thead><tr><th>账号 / 优先级</th><th>套餐、额度与重置次数</th><th>健康与性能</th><th>路由状态</th><th>操作</th></tr></thead><tbody>${accounts.map((a,index)=>{
    const isActive=a.id===activeId
    const health=(statsData.accounts||{})[a.id]||{}
    const runtime=(diagnosticsData.accounts||[]).find(item=>item.id===a.id)||{}
    const oneHour=health.windows&&health.windows['1h'],day=health.windows&&health.windows['24h'],week=health.windows&&health.windows['7d']
    const recentRates=oneHour&&day?`<div class="cell-sub">1h ${oneHour.success_rate==null?'-':oneHour.success_rate+'%'} · 24h ${day.success_rate==null?'-':day.success_rate+'%'} · 7d ${week?.success_rate==null?'-':week.success_rate+'%'}</div>`:''
    const lastError=health.last_error_type?`<div class="cell-sub" title="${esc(health.last_error_message||health.last_error_type)}">最近错误：${esc(health.last_error_type)}${health.last_status?` (${health.last_status})`:''}</div>`:''
    const healthHtml=health.requests?`<div class="cell-main">${Number(health.success_rate||0).toFixed(1)}% 累计成功</div>${recentRates}<div class="cell-sub">${fmt(health.requests)} 次${health.rate_limited?` · ${health.rate_limited} 次 429`:''}</div>${lastError}`:'<span class="cell-sub">暂无请求</span>'
    const latencyHtml=health.requests?`<div class="cell-main">P95 ${fmt(health.p95_latency_ms)} ms</div><div class="cell-sub">P50 ${fmt(health.p50_latency_ms)} · 平均 ${fmt(health.average_latency_ms)} ms</div>`:'<span class="cell-sub">暂无数据</span>'
    const routeEnabled=a.routing_enabled!==false
    const accountReserve=Number(a.low_quota_threshold??threshold),atReserve=remainingOf(a)!=null&&remainingOf(a)<=accountReserve
    const usageStale=!a.usage_updated_at||(Date.now()-new Date(a.usage_updated_at).getTime()>30*60*1000)
    const modelCooldownCount=Object.values(a.model_cooldowns||{}).filter(until=>Number(until)>Date.now()).length
    const reset=a.reset_credits
    const resetCount=reset?Number(reset.available_count||0):null
    const resetExpiry=(reset?.expires_at||[]).slice(0,3)
    const resetHtml=`<div class="reset-credit-summary"><div><b>Codex 额度重置</b><span class="badge ${resetCount>0?'reset-available':''}">${resetCount==null?'待查询':`可用 ${resetCount} 次`}</span></div>${resetExpiry.length?resetExpiry.map(value=>`<small title="${esc(value)}">到期（北京时间）：${esc(beijingTime(value))}</small>`).join(''):`<small>${a.reset_credits_error?`查询失败：${esc(a.reset_credits_error)}`:reset?'暂无可用重置次数':'点击右侧“查询重置次数”获取'}</small>`}${reset?.updated_at?`<small>查询：${esc(beijingTime(reset.updated_at))}</small>`:''}</div>`
    const quotaHtml=`<div class="account-plan"><b>${esc(a.plan_type||'套餐待同步')}</b><span>${esc((a.account_id||a.id||'-').slice(0,20))}</span></div><div class="quota-pair"><div><label>5 小时额度</label>${usageWindowHtml(a.usage&&a.usage.primary,a)}${usageForecastHtml(a.usage_forecast&&a.usage_forecast.primary)}</div><div><label>1 周额度</label>${usageWindowHtml(a.usage&&a.usage.secondary,a)}${usageForecastHtml(a.usage_forecast&&a.usage_forecast.secondary)}</div></div>${resetHtml}<div class="cell-sub">额度更新：${a.usage_updated_at?esc(beijingTime(a.usage_updated_at)):'尚未同步'}</div>`
    const routeHtml=`<div class="route-state"><span class="status ${!routeEnabled||a.status==='auth_error'?'off':a.status==='cooldown'||atReserve?'warn':''}"><i></i>${!routeEnabled?'仅保存':a.status==='cooldown'?'账号冷却':a.status==='auth_error'?'登录失效':atReserve?'安全余量暂停':'参与路由'}</span>${isActive?'<span class="badge">本机账号</span>':'<span class="tag">备用登录</span>'}</div><div class="route-detail">${a.cooldown_until?`<span>恢复：${esc(beijingTime(a.cooldown_until))}</span>`:''}${modelCooldownCount?`<span>${modelCooldownCount} 个模型冷却</span>`:''}<span>并发 ${runtime.active_requests||0}/${runtime.concurrency_limit||3}</span></div><div class="weight-field"><label>路由权重</label><input class="input" type="number" min="1" max="100" value="${Number(a.routing_weight)||1}" onchange="updateAccountWeight('${esc(a.id)}',this.value)" title="weighted 策略下生效"></div>`
    const resetDisabled=resetCount==null||resetCount<=0
    const actionsHtml=`<div class="account-actions"><div class="account-action-row">${button(routeEnabled?'停用路由':'启用路由',routeEnabled?'x':'check',`toggleAccountRouting('${esc(a.id)}',${routeEnabled?'false':'true'})`,'btn-sm')}${isActive?'<span class="status"><i></i>当前本机</span>':button('切换本机','arrow',`switchAccount('${esc(a.id)}')`,'btn-sm')}</div><div class="account-action-row"><button class="btn btn-sm" onclick="openRenameAccount('${esc(a.id)}')" title="修改账号名称">${svg('edit')}改名</button><button class="btn btn-sm" onclick="refreshAccountUsageOne('${esc(a.id)}')" title="刷新 5 小时和每周额度">${svg('refresh')}刷新额度</button><button class="btn btn-sm btn-danger" onclick="removeAccount('${esc(a.id)}')" title="移除账号">${svg('trash')}</button></div><div class="reset-actions"><b>额度重置操作</b><div class="account-action-row"><button class="btn btn-sm" onclick="refreshAccountResetCreditsOne('${esc(a.id)}')">${svg('pulse')}查询重置次数</button><button class="btn btn-sm btn-danger" ${resetDisabled?'disabled title="请先查询并确认有可用重置次数"':`onclick="openResetQuota('${esc(a.id)}')"`}>${svg('refresh')}重置额度</button></div><small>重置前需输入账号名称并再次确认</small></div></div>`
    return `<tr draggable="true" data-account-id="${esc(a.id)}" ondragstart="startAccountDrag(event,'${esc(a.id)}')" ondragover="event.preventDefault()" ondrop="dropAccount(event,'${esc(a.id)}')"><td><div class="account-identity"><div class="cell-main" title="拖拽调整优先级"><span class="tag drag-handle">☰ ${index+1}</span> ${esc(a.label||a.email||'ChatGPT 账号')}</div><div class="tags">${isActive?'<span class="badge">Current</span>':'<span class="tag">Standby</span>'}${routeEnabled&&usageStale?'<span class="tag">额度待刷新</span>':''}${routeEnabled&&atReserve?'<span class="tag">已到安全余量</span>':''}</div><div class="cell-sub">${!routeEnabled?'仅保存 · 不参与路由':a.status==='cooldown'?'账号冷却中':a.status==='auth_error'?'登录已失效 · 请重新登录':atReserve?'已暂停 · 保留安全余量':'参与自动路由'}</div></div></td><td>${quotaHtml}</td><td><div class="health-block">${healthHtml}</div><div class="latency-block">${latencyHtml}</div></td><td>${routeHtml}</td><td>${actionsHtml}</td></tr>`
  }).join('')}</tbody></table></div>`:empty('accounts','账号池为空','通过官方登录或导入 auth.json 即可启用自动轮换',button('官方安全登录','shield','openOfficialLogin()','btn-primary'))
  const actions=button('官方安全登录','shield','openOfficialLogin()','btn-primary')+button('导入 auth.json','plus','openAccount()')+button('刷新全部用量','refresh','refreshAllUsage()')+button('查询全部重置次数','pulse','refreshAllResetCredits()')+button('重启 Codex','refresh','restartCodex()')
  const strategyOptions=Object.entries(accountStrategyLabels).map(([value,label])=>`<option value="${value}" ${cfg.chatgptAccountStrategy===value?'selected':''}>${label}</option>`).join('')
  const strategyBody=`<section class="account-strategy-bar"><div class="account-strategy-copy"><span class="eyebrow">ROUTING POLICY</span><strong>请求分配策略</strong><small>控制新请求如何进入账号池</small></div><label><span>账号选择模式</span><select id="f_chatgptAccountStrategy">${strategyOptions}</select></label><label class="strategy-threshold"><span>低额度避让阈值</span><div><input class="input" id="f_chatgptLowQuotaThreshold" type="number" min="0" max="100" value="${Number(cfg.chatgptLowQuotaThreshold??10)}"><small>%</small></div></label>${button('保存策略','check','saveConfig()','btn-primary')}</section>`
  const decisions=diagnosticsData.recent_route_decisions||[]
  const decisionBody=decisions.length?`<div class="table-wrap"><table class="table"><thead><tr><th>时间 / Request ID</th><th>模型</th><th>结果</th><th>选择与跳过原因</th></tr></thead><tbody>${decisions.slice(0,15).map(item=>{const skipped=(item.accounts||[]).filter(account=>account.result==='skipped').slice(0,4);const result=item.selected_account_label?`选择 ${esc(item.selected_account_label)}`:item.outcome==='queue_timeout'?'排队超时':item.outcome==='client_disconnected'?'客户端已断开':'没有可用账号';return `<tr><td><div class="cell-main">${new Date(item.at).toLocaleTimeString('zh-CN')}</div><div class="cell-sub">${esc(item.request_id||'-')}</div></td><td>${esc(item.model||'-')}</td><td><div class="cell-main">${result}</div><div class="cell-sub">${item.queue_wait_ms?`等待 ${fmt(item.queue_wait_ms)} ms`:'无需等待'}</div></td><td>${skipped.length?skipped.map(account=>`<div class="cell-sub"><b>${esc(account.label||account.id)}</b>：${esc(account.reason)}</div>`).join(''):'<span class="cell-sub">没有账号被跳过</span>'}</td></tr>`}).join('')}</tbody></table></div>`:empty('pulse','暂无路由决策','发起一次 ChatGPT 订阅模型请求后，将显示账号选择和跳过原因')
  return pageHead('ChatGPT 账号池','多账号统一托管，并在配额不足时自动切换',actions)+`<div class="metrics">${metric('账号总数',accounts.length,'users','全部订阅账号')}${metric('有效账号',available,'check',`${accounts.length-available} 个账号停用、冷却或到安全线`)}${metric('可用重置次数',resetTotal,'refresh','按账号分别使用 · 重置前二次确认')}${metric('当前账号',activeLabel?esc(activeLabel.label||activeLabel.account_id||'已选择'):'未选择','shield',`当前队列 ${Number(diagnosticsData.queue?.depth)||0} · 切换后本机生效`)}</div>`+card('路由策略','优先级模式使用下方拖拽顺序；权重模式使用每行权重',strategyBody)+card('账号健康矩阵','额度、重置次数、健康、路由和操作集中分组显示',body)+card('最近路由决策','解释每次请求为什么选择或跳过某个账号',decisionBody)
}
function renderAccounts(){
  const accounts=cfg.chatgptAccounts||[]
  const threshold=Number(cfg.chatgptLowQuotaThreshold??10)
  const remainingOf=a=>{
    const values=[a.usage&&a.usage.primary,a.usage&&a.usage.secondary].filter(Boolean).map(w=>w.remaining_percent==null?(w.used_percent==null?null:100-Number(w.used_percent)):Number(w.remaining_percent)).filter(Number.isFinite)
    return values.length?Math.min(...values):null
  }
  const activeId=cfg.activeChatgptAccountId
  const activeLabel=accounts.find(a=>a.id===activeId)
  const available=accounts.filter(a=>(a.status==='active'||!a.status)&&a.routing_enabled!==false&&(remainingOf(a)==null||remainingOf(a)>threshold)).length
  const resetTotal=accounts.reduce((sum,a)=>sum+Number(a.reset_credits?.available_count||0),0)
  const beijingTime=value=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})
  const cards=accounts.map((a,index)=>{
    const label=a.label||a.email||'ChatGPT 账号'
    const initials=Array.from(label.trim()).slice(0,2).join('').toUpperCase()||'AI'
    const isActive=a.id===activeId
    const routeEnabled=a.routing_enabled!==false
    const remaining=remainingOf(a)
    const accountReserve=Number(a.low_quota_threshold??threshold),atReserve=remaining!=null&&remaining<=accountReserve
    const usageStale=!a.usage_updated_at||(Date.now()-new Date(a.usage_updated_at).getTime()>30*60*1000)
    const modelCooldownCount=Object.values(a.model_cooldowns||{}).filter(until=>Number(until)>Date.now()).length
    const health=(statsData.accounts||{})[a.id]||{}
    const runtime=(diagnosticsData.accounts||[]).find(item=>item.id===a.id)||{}
    const oneHour=health.windows&&health.windows['1h']
    const day=health.windows&&health.windows['24h']
    const week=health.windows&&health.windows['7d']
    const rangeHealth=health.windows?.[healthRange]||health
    const successRate=rangeHealth.requests?`${Number(rangeHealth.success_rate||0).toFixed(1)}%`:'—'
    const requestCount=rangeHealth.requests?fmt(rangeHealth.requests):'—'
    const p95=rangeHealth.requests?`${fmt(rangeHealth.p95_latency_ms)} ms`:'—'
    const concurrency=`${runtime.active_requests||0}/${runtime.concurrency_limit||3}`
    const routeLabel=!routeEnabled?'仅保存':a.status==='cooldown'?'冷却中':a.status==='auth_error'?'登录失效':atReserve?'额度保护':'参与路由'
    const routeTone=!routeEnabled||a.status==='auth_error'?'off':a.status==='cooldown'||atReserve?'warn':'ok'
    const reset=a.reset_credits
    const resetCount=reset?Number(reset.available_count||0):null
    const resetExpiry=(reset?.expires_at||[])[0]
    const resetDisabled=resetCount==null||resetCount<=0
    const resetDetail=a.reset_credits_error
      ? `查询失败：${esc(a.reset_credits_error)}`
      : resetExpiry
        ? `最近到期：${esc(beijingTime(resetExpiry))}`
        : reset
          ? '当前没有可用重置次数'
          : '尚未查询重置次数'
    const hue=205+(index*47)%120
    return `<article class="account-profile-card ${routeTone==='off'?'is-muted':''}" style="--account-hue:${hue}" draggable="true" data-account-id="${esc(a.id)}" ondragstart="startAccountDrag(event,'${esc(a.id)}')" ondragover="event.preventDefault()" ondrop="dropAccount(event,'${esc(a.id)}')">
      <header class="account-profile-head">
        <div class="account-profile-main">
          <span class="account-rank drag-handle" title="拖拽调整优先级">${index+1}</span>
          <div class="account-avatar">${esc(initials)}</div>
          <div class="account-title">
            <div><strong>${esc(label)}</strong><span class="account-state ${routeTone}"><i></i>${routeLabel}</span></div>
            <small>${esc(a.plan_type||'套餐待同步')} · ${esc((a.account_id||a.id||'-').slice(0,24))}</small>
          </div>
        </div>
        <div class="account-head-actions">
          ${isActive?'<span class="account-local-badge">本机账号</span>':button('切换本机','arrow',`switchAccount('${esc(a.id)}')`,'btn-sm')}
          ${button(routeEnabled?'停用路由':'启用路由',routeEnabled?'x':'check',`toggleAccountRouting('${esc(a.id)}',${routeEnabled?'false':'true'})`,'btn-sm')}
        </div>
      </header>
      <div class="account-profile-body">
        <section class="account-card-section quota-section">
          <div class="account-section-head"><div><span>额度状态</span><small>${usageStale?'数据可能已过期':'最近数据有效'}</small></div><button class="account-link" onclick="refreshAccountUsageOne('${esc(a.id)}')">${svg('refresh')}刷新</button></div>
          <div class="account-quota-grid">
            <div class="account-quota-tile"><div class="account-tile-label"><span>5 小时</span><small>${!a.usage?.primary&&a.usage_sync_status==='synced'?'当前暂停':'短周期'}</small></div>${usageWindowHtml(a.usage&&a.usage.primary,a)}${usageForecastHtml(a.usage_forecast&&a.usage_forecast.primary)}</div>
            <div class="account-quota-tile"><div class="account-tile-label"><span>1 周</span><small>长周期</small></div>${usageWindowHtml(a.usage&&a.usage.secondary,a)}${usageForecastHtml(a.usage_forecast&&a.usage_forecast.secondary)}</div>
          </div>
        </section>
        <section class="account-card-section performance-section">
          <div class="account-section-head"><div><span>运行表现</span><small>${rangeHealth.requests?`${healthRange} 真实请求`:'等待请求样本'}</small></div></div>
          <div class="account-kpi-grid">
            <div><small>成功率</small><strong>${successRate}</strong></div>
            <div><small>请求数</small><strong>${requestCount}</strong></div>
            <div><small>P95 延迟</small><strong>${p95}</strong></div>
            <div><small>并发占用</small><strong>${concurrency}</strong></div>
          </div>
          <div class="account-performance-note">${oneHour||day||week?`1h ${oneHour?.success_rate==null?'—':oneHour.success_rate+'%'} · 24h ${day?.success_rate==null?'—':day.success_rate+'%'} · 7d ${week?.success_rate==null?'—':week.success_rate+'%'}`:'暂无分时健康数据'}${health.rate_limited?` · ${health.rate_limited} 次 429`:''}</div>
          ${health.trend_warning?`<div class="account-alert error">${esc(health.trend_warning.message)}</div>`:''}
        </section>
        <section class="account-card-section route-section">
          <div class="account-section-head"><div><span>调度设置</span><small>${isActive?'当前本机登录':'账号池托管账号'}</small></div></div>
          <div class="account-route-summary">
            <div><span class="account-state ${routeTone}"><i></i>${routeLabel}</span><small>${modelCooldownCount?`${modelCooldownCount} 个模型冷却`:'无模型冷却'}</small></div>
            <label><span>路由权重</span><input class="input" type="number" min="1" max="100" value="${Number(a.routing_weight)||1}" onchange="updateAccountWeight('${esc(a.id)}',this.value)" title="weighted 策略下生效"></label>
          </div>
          ${a.cooldown_until?`<div class="account-alert">预计恢复：${esc(beijingTime(a.cooldown_until))}</div>`:''}
          ${health.last_error_type?`<div class="account-alert error" title="${esc(health.last_error_message||health.last_error_type)}">最近错误：${esc(health.last_error_type)}${health.last_status?` · HTTP ${health.last_status}`:''}</div>`:''}
        </section>
      </div>
      <section class="account-reset-strip ${resetCount>0?'has-credit':''}">
        <div class="account-reset-icon">${svg('refresh')}</div>
        <div class="account-reset-copy">
          <span>Codex 额度重置 · <b class="reset-risk-label" style="color:var(--red);font-weight:800">高风险 / 不可撤销</b></span>
          <strong>${resetCount==null?'待查询':`${resetCount} 次可用`}</strong>
          <small>${resetDetail}${reset?.updated_at?` · 查询于 ${esc(beijingTime(reset.updated_at))}`:''}</small>
        </div>
        <div class="account-reset-actions">
          <button class="btn btn-sm" onclick="refreshAccountResetCreditsOne('${esc(a.id)}')">${svg('pulse')}查询次数</button>
          <button class="btn btn-sm btn-danger" ${resetDisabled?'disabled title="请先查询并确认有可用重置次数"':`onclick="openResetQuota('${esc(a.id)}')"`}>${svg('refresh')}重置额度</button>
        </div>
      </section>
      <footer class="account-profile-foot">
        <span>${a.usage_updated_at?`额度更新 ${esc(beijingTime(a.usage_updated_at))}`:'额度尚未同步'}</span>
        <div>
          <button class="account-link" onclick="openAccountPolicy('${esc(a.id)}')">${svg('shield')}额度策略</button>
          <button class="account-link" onclick="openRenameAccount('${esc(a.id)}')">${svg('edit')}修改名称</button>
          <button class="account-link danger" onclick="removeAccount('${esc(a.id)}')">${svg('trash')}移除账号</button>
        </div>
      </footer>
    </article>`
  }).join('')
  const compactRows=accounts.map((a,index)=>{
    const label=a.label||a.email||'ChatGPT 账号'
    const initials=Array.from(label.trim()).slice(0,2).join('').toUpperCase()||'AI'
    const isActive=a.id===activeId
    const routeEnabled=a.routing_enabled!==false
    const remaining=remainingOf(a)
    const accountReserve=Number(a.low_quota_threshold??threshold),atReserve=remaining!=null&&remaining<=accountReserve
    const runtime=(diagnosticsData.accounts||[]).find(item=>item.id===a.id)||{}
    const health=(statsData.accounts||{})[a.id]||{}
    const rangeHealth=health.windows?.[healthRange]||health
    const routeLabel=!routeEnabled?'仅保存':a.status==='cooldown'?'冷却中':a.status==='auth_error'?'登录失效':atReserve?'额度保护':'参与路由'
    const routeTone=!routeEnabled||a.status==='auth_error'?'off':a.status==='cooldown'||atReserve?'warn':'ok'
    const resetCount=a.reset_credits?Number(a.reset_credits.available_count||0):null
    const quotaResetText=window=>{
      if(!window)return '重置时间待同步'
      if(window.reset_after_seconds!=null)return formatDuration(window.reset_after_seconds)
      if(window.resets_at)return `${new Date(window.resets_at*1000).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})} 重置`
      return '重置时间待同步'
    }
    const quotaBar=(name,window)=>{
      if(!window||window.used_percent==null){
        const unavailable=a.usage_sync_status==='synced'&&(a.usage?.primary||a.usage?.secondary)
        return `<div class="compact-quota is-empty"><span><b>${name}</b><em>${unavailable?'未提供':'待同步'}</em></span><i></i><small>${unavailable?'官方当前未提供此窗口':quotaResetText(window)}</small></div>`
      }
      const value=Math.max(0,Math.min(100,window.remaining_percent==null?100-Number(window.used_percent):Number(window.remaining_percent)))
      const tone=value<=10?'var(--red)':value<=30?'var(--amber)':'var(--green)'
      return `<div class="compact-quota" style="--quota-color:${tone}"><span><b>${name}</b><em>${value.toFixed(0)}%</em></span><i><b style="width:${value}%"></b></i><small>${quotaResetText(window)}</small></div>`
    }
    const hue=205+(index*47)%120
    return `<article class="account-compact-row ${routeTone==='off'?'is-muted':''}" style="--account-hue:${hue}" draggable="true" data-account-id="${esc(a.id)}" ondragstart="startAccountDrag(event,'${esc(a.id)}')" ondragover="event.preventDefault()" ondrop="dropAccount(event,'${esc(a.id)}')">
      <div class="compact-identity">
        <span class="account-rank drag-handle" title="拖拽调整优先级">${index+1}</span>
        <div class="account-avatar">${esc(initials)}</div>
        <div><strong>${esc(label)}</strong><small>${esc(a.plan_type||'套餐待同步')} · ${esc((a.account_id||a.id||'-').slice(0,16))}</small></div>
      </div>
      <div class="compact-quota-group">${quotaBar('5 小时',a.usage&&a.usage.primary)}${quotaBar('1 周',a.usage&&a.usage.secondary)}</div>
      <div class="compact-health">
        <div><small>${healthRange} 成功率</small><strong>${rangeHealth.requests?Number(rangeHealth.success_rate||0).toFixed(1)+'%':'—'}</strong></div>
        <div><small>P95 延迟</small><strong>${rangeHealth.requests?fmt(rangeHealth.p95_latency_ms)+' ms':'—'}</strong></div>
        <div><small>并发</small><strong>${runtime.active_requests||0}/${runtime.concurrency_limit||3}</strong></div>
      </div>
      <div class="compact-status">
        <span class="account-state ${routeTone}"><i></i>${routeLabel}</span>
        <small>重置次数 <b>${resetCount==null?'待查询':resetCount}</b>${resetCount>0?' · <em class="reset-risk-label" style="color:var(--red);font-style:normal;font-weight:800">高风险</em>':''}${isActive?' · 本机账号':''}</small>
      </div>
      <div class="compact-actions">
        ${!isActive?`<button title="切换为本机账号" onclick="switchAccount('${esc(a.id)}')">${svg('arrow')}</button>`:''}
        <button title="刷新额度" onclick="refreshAccountUsageOne('${esc(a.id)}')">${svg('refresh')}</button>
        <button title="查询重置次数" onclick="refreshAccountResetCreditsOne('${esc(a.id)}')">${svg('pulse')}</button>
        <button title="额度与预留策略" onclick="openAccountPolicy('${esc(a.id)}')">${svg('shield')}</button>
        ${resetCount>0?`<button class="danger" title="高风险：消耗 1 次并重置额度（不可撤销）" onclick="openResetQuota('${esc(a.id)}')">${svg('refresh')}</button>`:''}
        <button title="${routeEnabled?'停用路由':'启用路由'}" onclick="toggleAccountRouting('${esc(a.id)}',${routeEnabled?'false':'true'})">${svg(routeEnabled?'x':'check')}</button>
      </div>
    </article>`
  }).join('')
  const compactHeader=`<div class="account-compact-header" aria-hidden="true"><span>账号 / 优先级</span><span class="compact-header-quota"><b>额度状态</b><small><i>5 小时周期</i><i>1 周周期</i></small></span><span class="compact-col-health">运行表现</span><span>路由 / 重置次数</span><span>快捷操作</span></div>`
  const viewSwitch=`<div class="account-view-switch" role="group" aria-label="账号展示方式"><button class="${accountViewMode==='compact'?'active':''}" onclick="setAccountViewMode('compact')" title="条状简约型">${svg('list')}<span>简约</span></button><button class="${accountViewMode==='cards'?'active':''}" onclick="setAccountViewMode('cards')" title="卡片全面型">${svg('cards')}<span>全面</span></button></div>`
  const rangeSwitch=`<div class="account-view-switch" role="group" aria-label="健康时间范围">${['1h','24h','7d'].map(range=>`<button class="${healthRange===range?'active':''}" onclick="setHealthRange('${range}')"><span>${range}</span></button>`).join('')}</div>`
  const accountBoard=accounts.length
    ? `<section class="account-board"><div class="account-board-head"><div><span class="eyebrow">ACCOUNT POOL</span><h2>${accountViewMode==='compact'?'账号快速总览':'账号运行面板'}</h2><p>${accountViewMode==='compact'?'按列对齐比较额度、重置时间、性能和路由状态。':'拖拽左上角序号调整优先级；额度、健康度和高风险操作按功能分区。'}</p></div><div class="account-board-tools"><div class="account-board-legend"><span><i class="ok"></i>正常</span><span><i class="warn"></i>受限</span><span><i class="off"></i>停用</span></div>${rangeSwitch}${viewSwitch}</div></div>${accountViewMode==='compact'?`<div class="account-compact-list">${compactHeader}${compactRows}</div>`:`<div class="account-card-grid">${cards}</div>`}</section>`
    : card('账号池', '尚未添加订阅账号', empty('accounts','账号池为空','通过官方登录或导入 auth.json 即可启用自动轮换',button('官方安全登录','shield','openOfficialLogin()','btn-primary')))
  const actions=button('官方安全登录','shield','openOfficialLogin()','btn-primary')+button('导入 auth.json','plus','openAccount()')+button('刷新全部用量','refresh','refreshAllUsage()')+button('查询全部重置次数','pulse','refreshAllResetCredits()')+button('重启 Codex','refresh','restartCodex()')
  const strategyOptions=Object.entries(accountStrategyLabels).map(([value,label])=>`<option value="${value}" ${cfg.chatgptAccountStrategy===value?'selected':''}>${label}</option>`).join('')
  const strategyBody=`<section class="account-strategy-bar"><div class="account-strategy-copy"><span class="eyebrow">ROUTING POLICY</span><strong>请求分配策略</strong><small>控制新请求如何进入账号池</small></div><label><span>账号选择模式</span><select id="f_chatgptAccountStrategy">${strategyOptions}</select></label><label class="strategy-threshold"><span>低额度避让阈值</span><div><input class="input" id="f_chatgptLowQuotaThreshold" type="number" min="0" max="100" value="${Number(cfg.chatgptLowQuotaThreshold??10)}"><small>%</small></div></label>${button('保存策略','check','saveConfig()','btn-primary')}</section>`
  const decisions=diagnosticsData.recent_route_decisions||[]
  const decisionBody=decisions.length?`<div class="table-wrap"><table class="table"><thead><tr><th>时间 / Request ID</th><th>模型</th><th>结果</th><th>选择与跳过原因</th></tr></thead><tbody>${decisions.slice(0,15).map(item=>{const skipped=(item.accounts||[]).filter(account=>account.result==='skipped').slice(0,4);const result=item.selected_account_label?`选择 ${esc(item.selected_account_label)}`:item.outcome==='queue_timeout'?'排队超时':item.outcome==='client_disconnected'?'客户端已断开':'没有可用账号';return `<tr><td><div class="cell-main">${new Date(item.at).toLocaleTimeString('zh-CN')}</div><div class="cell-sub">${esc(item.request_id||'-')}</div></td><td>${esc(item.model||'-')}</td><td><div class="cell-main">${result}</div><div class="cell-sub">${item.queue_wait_ms?`等待 ${fmt(item.queue_wait_ms)} ms`:'无需等待'}</div></td><td>${skipped.length?skipped.map(account=>`<div class="cell-sub"><b>${esc(account.label||account.id)}</b>：${esc(account.reason)}</div>`).join(''):'<span class="cell-sub">没有账号被跳过</span>'}</td></tr>`}).join('')}</tbody></table></div>`:empty('pulse','暂无路由决策','发起一次 ChatGPT 订阅模型请求后，将显示账号选择和跳过原因')
  return pageHead('ChatGPT 账号池','以账号为中心查看额度、性能、调度和重置能力',actions)+`<div class="metrics">${metric('账号总数',accounts.length,'users','全部订阅账号')}${metric('有效账号',available,'check',`${accounts.length-available} 个账号当前不可调度`)}${metric('可用重置次数',resetTotal,'refresh','高风险操作需要二次确认')}${metric('当前本机账号',activeLabel?esc(activeLabel.label||activeLabel.account_id||'已选择'):'未选择','shield',`等待队列 ${Number(diagnosticsData.queue?.depth)||0}`)}</div>`+strategyBody+accountBoard+card('最近路由决策','解释每次请求为什么选择或跳过某个账号',decisionBody)
}
function renderAnalytics(){
  const t=totals(), items=allProviders().flatMap(p=>Object.entries(p.models||{}).map(([name,v])=>({name,...v}))).sort((a,b)=>b.requests-a.requests)
  const days=normalizedDaily(30), today=days[days.length-1], accounts=accountSeriesMeta()
  const firstRecordedDay=days.findIndex(day=>day.requests||day.account_attempts||dailyTokens(day))
  const detailDays=firstRecordedDay>=0?days.slice(firstRecordedDay):days.slice(-1)
  const periodTokens=days.reduce((sum,day)=>sum+dailyTokens(day),0)
  const activeDays=days.filter(day=>dailyTokens(day)>0||day.requests>0).length
  const peak=days.reduce((best,day)=>dailyTokens(day)>dailyTokens(best)?day:best,days[0])
  const tokenTrend=trendChart(days,[
    {label:'总 Token',color:'#1769e0',fill:true,width:3,value:dailyTokens},
    {label:'输入',color:'#10a37f',value:day=>day.input_tokens},
    {label:'输出',color:'#f59e0b',value:day=>day.output_tokens}
  ],{id:'token-trend',unit:'Token'})
  const accountTrend=accounts.length?trendChart(days,accounts.map(account=>({
    label:account.label,color:account.color,value:day=>Number(day.accounts[account.id]?.requests)||0
  })),{id:'account-trend',unit:'次请求'}):empty('users','暂无账号数据','账号池产生请求后会按账号生成趋势')
  const max=Math.max(1,...items.map(i=>i.requests))
  const chartBody=items.length?`<div class="card-body"><div class="chart">${items.slice(0,10).map(i=>`<div class="chart-col"><div class="chart-bar" data-value="${fmt(i.requests)} 次" style="height:${Math.max(3,i.requests/max*90)}%"></div><label title="${esc(i.name)}">${esc(i.name)}</label></div>`).join('')}</div></div>`:empty('analytics','暂无统计数据','完成首次模型调用后将自动生成图表')
  const tableBody=items.length?`<div class="table-wrap"><table class="table"><thead><tr><th>模型</th><th>请求数</th><th>输入 Token</th><th>输出 Token</th><th>总量</th></tr></thead><tbody>${items.map(i=>`<tr><td class="cell-main">${esc(i.name)}</td><td>${fmt(i.requests)}</td><td>${fmt(i.input_tokens)}</td><td>${fmt(i.output_tokens)}</td><td><b>${fmt((i.input_tokens||0)+(i.output_tokens||0))}</b></td></tr>`).join('')}</tbody></table></div>`:''
  return pageHead('用量分析','按天、账号和模型分析本地 AI 使用情况',button('清空统计','trash','resetStats()','btn-danger'))+
    `<div class="metrics">${metric('今日请求',fmt(today.requests),'pulse',`累计 ${fmt(t.requests)} 次完成请求`)}${metric('今日 Token',fmt(dailyTokens(today)),'download',`输入 ${fmt(today.input_tokens)} · 输出 ${fmt(today.output_tokens)}`)}${metric('近 30 日 Token',fmt(periodTokens),'analytics',activeDays?`日均 ${fmt(periodTokens/activeDays)} · ${activeDays} 个活跃日`:'等待积累每日数据')}${metric('单日峰值',fmt(dailyTokens(peak)),'server',`${dayLabel(peak.key,true)} · 当前共 ${items.length} 个活跃模型`)}</div>`+
    `<div class="analytics-trend-grid">${card('每日 Token 变化趋势','最近 30 天 · 自动补齐无调用日期',`<div class="card-body trend-card-body">${tokenTrend}</div>`)}${card('账号每日使用趋势','路由尝试次数 · 重试单独计数',`<div class="card-body trend-card-body">${accountTrend}</div>`)}</div>`+
    card('每日账号明细',`${dayLabel(detailDays[0].key,true)} 至今 · 汇总与账号用量对照`,dailyAccountTable(detailDays,accounts))+
    `<div class="analytics-model-grid">${card('模型请求分布','按累计请求数排序',chartBody)}${card('累计用量明细',`${items.length} 个活跃模型`,tableBody||empty('analytics','暂无累计数据','完成首次模型调用后将显示模型明细'))}</div>`
}
function helpStep(number,title,desc,action='',done=false){
  return `<div class="help-step"><span class="help-number ${done?'done':''}">${done?svg('check'):number}</span><div><strong>${title}</strong><p>${desc}</p>${action?`<div class="help-action">${action}</div>`:''}</div></div>`
}
function helpFeature(icon,title,desc,page){
  return `<button class="help-feature" onclick="switchPage('${page}')"><span>${svg(icon)}</span><div><strong>${title}</strong><small>${desc}</small></div>${svg('arrow')}</button>`
}
function errorGuideRowsHtml(query=''){
  const term=String(query||'').trim().toLowerCase()
  const guides=errorGuideData.filter(item=>!term||[
    item.status,
    item.title,
    item.meaning,
    ...(item.causes||[]),
    ...(item.actions||[])
  ].join(' ').toLowerCase().includes(term))
  if(!guides.length)return empty('help','没有匹配的错误码','可输入 503、402、额度、认证、超时等关键词')
  return `<div class="table-wrap"><table class="table"><thead><tr><th>状态码</th><th>表示什么</th><th>常见原因</th><th>建议处理</th></tr></thead><tbody>${guides.map(item=>`<tr><td><span class="badge" style="font-size:12px">${Number(item.status)}</span><div class="cell-sub">HTTP</div></td><td><div class="cell-main">${esc(item.title)}</div><div style="max-width:260px;margin-top:5px;color:var(--muted);font-size:10px;line-height:1.65">${esc(item.meaning)}</div></td><td><div style="min-width:220px;color:var(--muted);font-size:10px;line-height:1.7">${(item.causes||[]).map(value=>`• ${esc(value)}`).join('<br>')}</div></td><td><div style="min-width:220px;color:var(--muted);font-size:10px;line-height:1.7">${(item.actions||[]).map((value,index)=>`${index+1}. ${esc(value)}`).join('<br>')}</div></td></tr>`).join('')}</tbody></table></div>`
}
function filterErrorGuide(value){
  const target=document.getElementById('error_guide_results')
  if(target)target.innerHTML=errorGuideRowsHtml(value)
}
function errorGuideLookup(){
  return `<div class="card-body" style="display:grid;gap:13px"><div class="help-note"><b>先看状态码，再看完整报错正文和来源</b><p>同一个状态码可能来自本地代理、ChatGPT、OpenAI API、DeepSeek 或中转节点。比如截图中的 503 明确写着账号池排队超时，应先检查账号池；402 通常表示对应上游的余额、计费或套餐权限不可用。</p></div><div class="field"><label>搜索错误码或关键词</label><input class="input" id="error_guide_query" inputmode="search" placeholder="例如：503、402、额度、登录、超时" oninput="filterErrorGuide(this.value)"><span class="hint">建议同时记录报错正文和 X-Codex-Proxy-Request-Id，便于进一步定位。</span></div></div><div id="error_guide_results">${errorGuideRowsHtml()}</div>`
}
function renderHelp(){
  const quotaResetGuide=`<div class="help-manual"><div class="help-note" style="border-color:color-mix(in srgb,var(--red) 28%,var(--border));background:color-mix(in srgb,var(--red) 6%,var(--surface-2))"><b style="color:var(--red)">高风险：会消耗 1 次重置机会且无法撤销</b><p>只有账号确实有可用重置次数并且你明确需要立即恢复额度时才使用；不确定时不要操作。</p></div><ol><li><b>先查询重置次数。</b><span>进入账号池，点击目标账号的“查询次数”，确认可用次数和到期时间。</span></li><li><b>核对目标账号。</b><span>点击标有“高风险”的重置入口，检查弹窗中的账号名称，再完整输入该名称。</span></li><li><b>勾选两项风险确认。</b><span>分别确认目标账号正确，以及操作会消耗 1 次机会并且不可撤销。</span></li><li><b>完成最终系统确认。</b><span>只有三步全部完成后才会提交。提交期间不要关闭弹窗、刷新页面或重复点击，等待额度和剩余次数自动刷新。</span></li></ol></div>`
  const quotaPolicyGuide=`<div class="help-manual"><ol><li><b>普通用户保持 10% 安全余量。</b><span>需要账号独立保护时，在账号卡片底部点击“额度策略”。</span></li><li><b>按需要设置每日上限。</b><span>请求数和输入/输出 Token 任一达到上限，该账号当天停止接收新请求；0 表示不限。</span></li><li><b>重要任务使用预留。</b><span>填写模型名或会话 ID 后，普通请求不会占用该账号，匹配任务会优先进入。</span></li><li><b>紧急继续只用于必要任务。</b><span>它会临时绕过安全线和每日上限，必须勾选风险并再次确认；最长 24 小时，到期自动恢复。</span></li><li><b>查看 1h / 24h / 7d。</b><span>近期成功率和 P95 延迟比累计数字更适合判断账号是否正在异常。</span></li></ol></div>`
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
    card('HTTP 报错代码查找表','支持按状态码和原因关键词搜索',errorGuideLookup())+
    card('自动诊断中心怎么用？','在概览页把错误码与实时运行状态合并分析',`<div class="card-body help-note"><p>出现 401、402、429、502 或 503 时先回到“控制台概览”。诊断中心会列出仅保存、登录失效、冷却、额度不足、每日上限、预留、并发占满和 Provider 熔断数量。优先点击结论旁的“刷新额度”“重新登录”或“检测 Provider”，不要连续盲目重试。1h、24h、7d 健康范围可在账号池切换；近期预警比累计数据更适合判断当前故障。</p></div>`)+
    card('智能路由与预算怎么用？','进阶功能默认关闭，不确定时保持默认',`<div class="card-body help-manual"><ol><li><b>普通模型默认不跨供应商。</b><span>只有在系统设置明确开启回退，或主动选择 auto 系列模型时才会跨 Provider。</span></li><li><b>先配置准确的回退链。</b><span>每行填写 provider | model；401、402、403 和参数错误不会进入下一线路。</span></li><li><b>按目标选择虚拟模型。</b><span>auto 综合、auto-fast 低延迟、auto-cheap 低成本、auto-reliable 高成功率与充足额度。</span></li><li><b>核对价格目录。</b><span>初始价格只是本地估算，设置预算前请对照服务商最新价格。</span></li><li><b>选择预算动作。</b><span>fallback 会切到计划中的免费/后备线路；stop 会在请求上游前返回 402。</span></li></ol></div>`)+
    `<div class="grid"><div>${card('四步快速开始',`${accounts.length} 个账号 · ${enabled} 个参与路由`,`<div class="card-body help-steps">${steps}</div>`)}${card('ChatGPT 账号完整操作步骤','第一次使用建议逐条完成',exactGuide)}${card('每账号额度与预留怎么设置？','安全余量、每日上限、预留和紧急继续',quotaPolicyGuide)}${card('额度重置怎么安全操作？','高风险功能 · 使用前逐项确认',quotaResetGuide)}${card('API 和中转节点怎么配置？','按你选择的接入方式阅读',otherGuides)}${card('常见问题和故障排查','从登录、额度到账号切换',faq)}</div><div>${card('左侧功能都有什么？','点击即可前往',`<div class="help-features">${helpFeature('overview','控制台概览','看服务是否正常、最近有没有调用','overview')}${helpFeature('providers','模型服务','配置官方 API 和 DeepSeek','providers')}${helpFeature('relays','中转节点','添加第三方兼容服务','relays')}${helpFeature('accounts','账号池','添加账号、查看额度和切换策略','accounts')}${helpFeature('analytics','用量分析','查看请求和 Token 用量','analytics')}${helpFeature('settings','系统设置','选择默认模型和显示偏好','settings')}</div>`)}${card('四个重要概念','先分清这些就不容易误操作',concepts)}${card('页面状态怎么看？','看到这些文字时该做什么',statusGuide)}${card('新手安全原则','避免误操作和凭据泄露',`<div class="card-body help-note"><p>① 只登录自己拥有的账号；② 只在 OpenAI 官方页面输入密码和验证码；③ 不上传 auth.json；④ 不频繁刷新额度或反复登录；⑤ 不确定时保持“仅保存”，不要切换本机账号。</p></div>`)}</div></div>`
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
  const deployment=diagnosticsData.deployment||{},runtime=deployment.runtime||{},consistency=deployment.consistency||{}
  const shortCommit=value=>value?String(value).slice(0,10):'未知'
  const info=`<div class="card-body"><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">网关版本</span><b>${esc(runtime.version||'未知')}</b></div><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">运行 Commit</span><code>${esc(shortCommit(runtime.commit))}</code></div><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">启动时间</span><b>${runtime.started_at?esc(new Date(runtime.started_at).toLocaleString('zh-CN')):'未知'}</b></div><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">运行文件路径</span><code style="max-width:330px;overflow:hidden;text-overflow:ellipsis" title="${esc(runtime.entry||runtime.path||'')}">${esc(runtime.entry||runtime.path||'未知')}</code></div><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">工作区</span><code style="max-width:330px;overflow:hidden;text-overflow:ellipsis" title="${esc(deployment.source?.path||'')}">${esc(deployment.source?.path||'未识别')}</code></div><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">安装目录</span><code style="max-width:330px;overflow:hidden;text-overflow:ellipsis" title="${esc(deployment.installation?.path||'')}">${esc(deployment.installation?.path||'未识别')}</code></div><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">部署一致性</span><span class="status ${consistency.synchronized===true?'':consistency.synchronized===false?'off':'warn'}"><i></i>${consistency.synchronized===true?'已同步':consistency.synchronized===false?`${Number(consistency.difference_count)||0} 个文件不一致`:'无法判断'}</span></div><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">管理 API</span><code>/admin/api</code></div><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">配置热重载</span><span class="badge">已启用</span></div><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">凭据保护</span><span class="status ${credentialProtection.enabled?'':'off'}"><i></i>${credentialProtection.enabled?'DPAPI + AES-256-GCM':'未启用'}</span></div><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">数据存储</span><span>本地 JSON</span></div></div>${deployment.can_deploy?`<div class="form-footer">${button('备份并部署工作区更新','refresh','deployWorkspaceUpdate()','btn-danger')}</div>`:''}`
  const snapshots=diagnosticsData.config_snapshots||[]
  const snapshotOptions=snapshots.map(item=>`<option value="${esc(item.name)}">${new Date(item.created_at).toLocaleString('zh-CN')} · ${esc(item.name.split('-').slice(6).join('-').replace('.json','')||'配置')}</option>`).join('')
  const rollback=`<div class="card-body"><div class="field"><label>配置快照 <span class="hint">最多保留最近 10 份</span></label><select id="config_snapshot">${snapshotOptions||'<option value="">暂无快照</option>'}</select></div></div><div class="form-footer">${button('回滚所选快照','refresh','rollbackConfigSnapshot()','btn-danger')}</div>`
  const accountBackups=diagnosticsData.account_backups||[]
  const accountBackupOptions=accountBackups.map(item=>`<option value="${esc(item.name)}">${new Date(item.created_at).toLocaleString('zh-CN')} · ${item.account_count==null?'格式待验证':item.account_count+' 个账号'}</option>`).join('')
  const accountRestore=`<div class="card-body"><div class="field"><label>账号备份 <span class="hint">删除和恢复前自动创建</span></label><select id="account_backup">${accountBackupOptions||'<option value="">暂无账号备份</option>'}</select><span class="hint">恢复仅补回当前缺失的账号，不覆盖现有账号、Token、名称或活动账号。敏感字段由当前 Windows 用户的 DPAPI 密钥加密。</span></div></div><div class="form-footer">${button('恢复缺失账号','refresh','restoreAccountBackup()','btn-danger')}</div>`
  const operations=`<div class="card-body"><div class="provider-row" style="grid-template-columns:1fr auto"><div><b>脱敏诊断报告</b><div class="cell-sub">包含队列、并发、额度和运行状态，不包含 Token</div></div>${button('下载报告','download','downloadDiagnostics()')}</div><div class="provider-row" style="grid-template-columns:1fr auto"><div><b>异常状态修复</b><div class="cell-sub">清理过期租约和异常冷却，不修改账号凭据</div></div>${button('立即检查','shield','repairRuntime()')}</div><div class="provider-row" style="grid-template-columns:1fr auto"><div><b>Provider 健康历史</b><div class="cell-sub">清空持久化的最近连通状态，不影响熔断或配置</div></div>${button('清空健康历史','refresh','resetProviderHealth()')}</div><div class="provider-row" style="grid-template-columns:1fr auto"><div><b>优雅重启代理</b><div class="cell-sub">停止接收新请求，等待当前请求完成后由看门狗恢复</div></div>${button('优雅重启','refresh','gracefulRestartProxy()','btn-danger')}</div></div>`
  const circuits=diagnosticsData.circuits||[]
  const openCircuits=circuits.filter(item=>item.state!=='closed')
  const circuitBody=`<div class="card-body">${circuits.length?circuits.map(item=>{const remaining=item.state==='open'?Math.max(0,30-Math.floor((Date.now()-Number(item.openedAt||0))/1000)):0;return `<div class="provider-row" style="grid-template-columns:1fr auto"><div><b>${esc(item.name)}</b><div class="cell-sub">${item.lastFailure?.message?esc(item.lastFailure.message):'暂无最近错误'}</div></div><span class="status ${item.state==='closed'?'':item.state==='half-open'?'warn':'off'}"><i></i>${item.state==='closed'?'正常':item.state==='half-open'?'正在探测':`熔断中 · 约 ${remaining} 秒后探测`}</span></div>`}).join(''):'<span class="cell-sub">尚无 Provider 熔断记录</span>'}</div><div class="form-footer">${button('重置熔断状态','refresh','resetCircuits()',openCircuits.length?'btn-danger':'')}</div>`
  const fallbackChain=(cfg.fallbackChain||[]).map(item=>`${item.provider} | ${item.model}`).join('\n')
  const smartRouting=`<div class="card-body"><div class="form-grid"><div class="field full"><label style="display:flex;align-items:center;gap:8px"><input id="f_crossProviderFallbackEnabled" type="checkbox" ${cfg.crossProviderFallbackEnabled?'checked':''}> 显式启用跨 Provider 回退</label><span class="hint">默认关闭。401、402、403 和请求格式错误永不跨供应商盲目重试。</span></div><div class="field full"><label>回退链 <span class="hint">每行 provider | model</span></label><textarea id="f_fallbackChain" spellcheck="false">${esc(fallbackChain)}</textarea></div><div class="field full"><label>允许回退的 HTTP 状态</label><input class="input" id="f_fallbackStatuses" value="${esc((cfg.fallbackStatuses||[429,502,503,504]).join(', '))}"></div><div class="field full"><div class="help-note"><b>虚拟模型</b><p><code>auto</code> 综合质量与可用性；<code>auto-fast</code> 优先低延迟；<code>auto-cheap</code> 优先免费/低价；<code>auto-reliable</code> 优先成功率与账号余量。选择这些模型本身即表示明确允许跨 Provider。</p></div></div></div></div><div class="form-footer">${button('保存智能路由','check','saveConfig()','btn-primary')}</div>`
  const budgetJson=JSON.stringify(cfg.providerBudgets||{},null,2)
  const priceJson=JSON.stringify(priceCatalogData.prices||{},null,2)
  const costProviders=Object.entries(costReportData.providers||{}).filter(([,value])=>value.total_usd||value.daily_usd||value.budget?.configured)
  const costRows=costProviders.length?costProviders.map(([provider,value])=>`<div class="provider-row" style="grid-template-columns:1fr auto"><div><b>${esc(provider)}</b><div class="cell-sub">今日 $${Number(value.daily_usd||0).toFixed(4)} · 本月 $${Number(value.monthly_usd||0).toFixed(4)} · 累计 $${Number(value.total_usd||0).toFixed(4)}</div></div><span class="status ${value.budget?.exceeded?'off':value.budget?.configured?'warn':''}"><i></i>${value.budget?.exceeded?'预算已满':value.budget?.configured?'预算监控中':'未设预算'}</span></div>`).join(''):'<span class="cell-sub">尚无付费线路成本记录</span>'
  const costBody=`<div class="card-body"><div class="metrics" style="grid-template-columns:repeat(2,minmax(0,1fr));margin-bottom:14px">${metric('今日估算',`$${Number(costReportData.today_usd||0).toFixed(4)}`,'analytics','按本地价格目录计算')}${metric('累计估算',`$${Number(costReportData.total_usd||0).toFixed(4)}`,'analytics','仅供预算治理参考')}</div>${costRows}<div class="field full" style="margin-top:14px"><label>Provider 预算 JSON <span class="hint">daily_usd / monthly_usd / action: fallback|stop</span></label><textarea id="f_providerBudgets" spellcheck="false">${esc(budgetJson)}</textarea></div></div><div class="form-footer">${button('保存预算','check','saveConfig()','btn-primary')}</div>`
  const priceBody=`<div class="card-body"><div class="help-note"><p>${esc(priceCatalogData.notice||'价格为本地估算，请自行核对服务商价格。')} · 更新于 ${priceCatalogData.updated_at?esc(new Date(priceCatalogData.updated_at).toLocaleString('zh-CN')):'未知'}</p></div><div class="field full" style="margin-top:12px"><label>每百万 Token 价格 JSON</label><textarea id="price_catalog_json" spellcheck="false" style="min-height:220px">${esc(priceJson)}</textarea></div></div><div class="form-footer">${button('更新价格目录','check','savePriceCatalog()','btn-primary')}</div>`
  return pageHead('系统设置','配置全局路由行为与管理控制台偏好')+`<div class="grid"><div>${card('路由偏好','应用于未指定模型或上游的请求',body)}${card('智能路由与显式回退','默认不跨供应商；必须主动开启或选择 auto 模型',smartRouting)}${card('成本与预算','请求、今日、月度成本估算及线路门禁',costBody)}${card('模型价格目录','本地可更新，不会自动修改真实账单',priceBody)}${card('配置快照与回滚','只恢复设置，不回退账号 Token 和 API Key',rollback)}${card('账号备份与恢复','安全合并，不覆盖当前有效凭据',accountRestore)}${card('外观','保存在当前浏览器',`<div class="card-body"><div class="provider-row" style="grid-template-columns:1fr auto"><div><b>深色显示模式</b><div class="cell-sub">切换控制台配色，不影响网关服务</div></div>${button('切换主题','moon','toggleTheme()')}</div></div>`)}</div><div>${card('系统信息','当前运行环境',info)}${card('Provider 熔断状态',openCircuits.length?`${openCircuits.length} 个通道暂不可用`:'所有已记录通道正常',circuitBody)}${card('运维与安全','普通使用无需操作',operations)}</div></div>`
}
function render(){
  const fn={overview:renderOverview,providers:renderProviders,relays:renderRelays,accounts:renderAccounts,analytics:renderAnalytics,settings:renderSettings,help:renderHelp}[activePage]
  const app=document.getElementById('app'), shouldAnimate=animateNextRender
  app.classList.toggle('is-entering',shouldAnimate)
  app.innerHTML=fn()
  animateNextRender=false
  if(shouldAnimate)setTimeout(()=>app.classList.remove('is-entering'),520)
}

function collectConfig(){
  const keys=['deepseekApiKey','openaiApiKey','openaiOrgId','openaiProjectId','upstreamUrl','chatgptResponsesUrl','openaiApiBaseUrl','openaiApiResponsesUrl','openaiApiChatCompletionsUrl','openaiApiUpstream','defaultModel','chatgptAccountStrategy','chatgptLowQuotaThreshold']
  const data={}; keys.forEach(k=>{ const el=document.getElementById('f_'+k); if(el)data[k]=el.value.trim() })
  const fallbackEnabled=document.getElementById('f_crossProviderFallbackEnabled')
  if(fallbackEnabled)data.crossProviderFallbackEnabled=fallbackEnabled.checked===true
  const chain=document.getElementById('f_fallbackChain')
  if(chain)data.fallbackChain=chain.value.split(/\r?\n/).map(line=>{
    const [provider,...modelParts]=line.split('|')
    return {provider:provider?.trim(),model:modelParts.join('|').trim()}
  }).filter(item=>item.provider&&item.model)
  const statuses=document.getElementById('f_fallbackStatuses')
  if(statuses)data.fallbackStatuses=statuses.value.split(',').map(Number).filter(code=>Number.isInteger(code)&&code>=400&&code<=599)
  const budgets=document.getElementById('f_providerBudgets')
  if(budgets)data.providerBudgets=JSON.parse(budgets.value||'{}')
  return data
}
async function saveConfig(){
  try{ const r=await fetch(API+'/config',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(collectConfig())}); const d=await r.json(); if(!r.ok)throw new Error(d.error?.message||'保存失败'); cfg={...cfg,...d.config}; render(); toast('配置已保存并热重载') }catch(e){toast(e.message,'error')}
}
async function savePriceCatalog(){
  try{
    const prices=JSON.parse(document.getElementById('price_catalog_json')?.value||'{}')
    const response=await fetch(API+'/prices',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({notice:priceCatalogData.notice,prices})})
    const data=await response.json()
    if(!response.ok)throw new Error(data.error?.message||'价格目录更新失败')
    priceCatalogData=data.catalog
    await load(false,false)
    toast(data.message||'价格目录已更新')
  }catch(error){toast(error.message,'error')}
}
async function pingChannel(type,relayId){
  toast('正在检测通道…')
  try{ const r=await fetch(API+'/ping',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(relayId?{type,relayId}:{type})}); const d=await r.json(); pingResults[relayId?'relay:'+relayId:type]=d; render(); toast(d.ok?`连接正常 · ${d.latency} ms`:(d.error||'连接失败'),d.ok?'success':'error') }catch(e){toast(e.message,'error')}
}
async function pingAll(){
  toast('正在检测全部通道…')
  try{ const r=await fetch(API+'/ping-all',{method:'POST'}),d=await r.json(); Object.entries(d.results||{}).forEach(([k,v])=>pingResults[k]=v); render(); toast(d.allOk?'全部通道连接正常':'部分通道检测失败',d.allOk?'success':'error') }catch(e){toast(e.message,'error')}
}
async function refreshDiagnosis(){
  try{
    const response=await fetch(API+'/diagnosis',{cache:'no-store'}),data=await response.json()
    if(!response.ok)throw new Error(data.error?.message||'诊断失败')
    diagnosticsData.automatic_diagnosis=data
    render()
    toast(data.summary?.conclusion||'诊断已更新')
  }catch(error){toast(error.message,'error')}
}
async function runDiagnosisAction(id,target){
  if(id==='refresh_quota'){
    await refreshAllUsage()
    return refreshDiagnosis()
  }
  if(id==='ping_providers'){
    switchPage('providers')
    await pingAll()
    return refreshDiagnosis()
  }
  if(id==='official_login'){
    switchPage('accounts')
    return openOfficialLogin()
  }
  if(target?.startsWith('#'))switchPage(target.slice(1))
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
function loginPreflightHtml(data){
  if(!data)return '<span class="status warn"><i></i>正在检测 Codex CLI、app-server OAuth 和私密浏览器…</span>'
  const candidates=(data.candidates||[]).map(item=>`<div style="display:flex;justify-content:space-between;gap:10px"><span>${esc(item.source)}</span><span class="status ${item.ok?'':'off'}"><i></i>${item.ok?esc(item.version||'可用'):esc(item.error||'不可用')}</span></div>`).join('')
  const browser=data.browser
    ? `<div style="display:flex;justify-content:space-between;gap:10px"><span>私密浏览器</span><span class="status"><i></i>${esc(data.browser.kind)} · 可用</span></div>`
    : '<div style="display:flex;justify-content:space-between;gap:10px"><span>私密浏览器</span><span class="status warn"><i></i>未找到，将提供手动登录链接</span></div>'
  const repairs=data.ok?'':`<div class="help-note" style="margin-top:10px"><b>修复命令</b><p><code>${(data.repair_commands||[]).map(esc).join('<br>')}</code></p></div>`
  return `<div style="display:grid;gap:8px"><div class="status ${data.ok?'':'off'}"><i></i>${esc(data.message||'预检完成')}</div>${candidates||'<span class="cell-sub">没有发现 Codex CLI</span>'}${browser}${repairs}<button class="btn btn-sm" type="button" onclick="copyLoginDiagnostics()">${svg('download')}复制登录诊断</button></div>`
}
async function openOfficialLogin(){
  loginPreflightData=null
  showModal('OpenAI 官方安全登录',`<div class="form-grid"><div class="field full"><div style="padding:13px;border-radius:10px;background:var(--primary-soft);color:var(--primary);font-size:11px;line-height:1.7">登录通过隔离的 Codex app-server 浏览器 OAuth 完成，不会修改本机现有 Codex 的 auth.json。新账号默认仅保存，不参与代理路由。</div></div><div class="field full"><label>登录环境预检</label><div id="login_preflight" class="help-note">${loginPreflightHtml(null)}</div></div><div class="field full"><label>邮箱或账号备注 <span class="hint">仅用于账号池中识别，可选</span></label><input class="input" id="login_label" type="email" autocomplete="email" placeholder="例如 name@example.com"></div><div class="field full"><label style="display:flex;align-items:center;gap:8px"><input id="login_routing_enabled" type="checkbox"> 登录后立即参与自动路由</label><span class="hint">不勾选时只放入账号池，不影响当前 Codex，也不会被代理选中。</span></div><div class="field full"><label>登录流程</label><div id="login_status" class="input" style="height:auto;min-height:48px;display:flex;align-items:center;gap:9px;flex-wrap:wrap"><span class="status off"><i></i>等待预检</span></div></div><div class="field full"><span class="hint">完成官方页面的登录和授权后，本地回调会自动通知后台并导入账号。重复账号会被拒绝，不会覆盖已有账号。</span></div></div>`,'开始官方登录','startOfficialLogin()')
  const submit=modal?.querySelector('.modal-foot .btn-primary')
  if(submit)submit.disabled=true
  try{
    const response=await fetch(API+'/chatgpt-login/preflight',{cache:'no-store'}),data=await response.json()
    loginPreflightData=data
    const target=document.getElementById('login_preflight')
    if(target)target.innerHTML=loginPreflightHtml(data)
    if(submit)submit.disabled=!data.ok
    const status=document.getElementById('login_status')
    if(status)status.innerHTML=`<span class="status ${data.ok?'':'off'}"><i></i>${data.ok?'预检通过，可以开始官方登录':esc(data.message||'预检失败')}</span>`
  }catch(error){
    const target=document.getElementById('login_preflight')
    if(target)target.innerHTML=loginPreflightHtml({ok:false,message:error.message,candidates:[],repair_commands:[]})
  }
}
async function copyLoginDiagnostics(){
  if(!loginPreflightData)return toast('预检尚未完成','error')
  const text=JSON.stringify(loginPreflightData,null,2)
  try{await navigator.clipboard.writeText(text);toast('登录诊断已复制')}catch{toast(text,'error')}
}
function loginStatusContent(d){
  const state=d.status==='waiting'?'warn':d.status==='success'?'':'off'
  const link=typeof d.verificationUrl==='string'&&d.verificationUrl.startsWith('https://')?`<a class="btn btn-sm btn-primary" href="${esc(d.verificationUrl)}" target="_blank" rel="noopener noreferrer">打开验证页（请确认私密模式）</a>`:''
  const code=d.userCode?`<code style="font-size:15px;font-weight:700;letter-spacing:1px">${esc(d.userCode)}</code><button class="btn btn-sm" onclick="copyDeviceCode('${esc(d.userCode)}')">复制验证码</button>`:''
  const cancel=d.status==='waiting'?button('取消','','cancelOfficialLogin()','btn-sm'):''
  const runtime=d.codexSource?`<span class="tag" title="${esc(d.codexVersion||'版本未知')}">${esc(d.codexSource)} · ${esc(d.codexVersion||'版本未知')}</span>`:''
  return `<span class="status ${state}"><i></i>${esc(d.message||'等待设备授权信息…')}</span>${runtime}${code}${link}${cancel}`
}
async function copyDeviceCode(code){
  try{await navigator.clipboard.writeText(code);toast('设备验证码已复制')}catch{toast('复制失败，请手动复制验证码','error')}
}
async function startOfficialLogin(){
  if(!loginPreflightData?.ok)return toast('请先等待登录环境预检通过','error')
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
async function refreshAccountResetCreditsOne(id){
  toast('正在查询 Codex 重置次数…')
  try{const r=await fetch(API+'/chatgpt-accounts/'+encodeURIComponent(id)+'/reset-credits',{method:'POST'}),d=await r.json();if(!r.ok)throw new Error(d.error?.message||'查询失败');cfg=d.config;render();toast(d.message||'Codex 重置次数已查询')}catch(e){toast(e.message,'error')}
}
async function refreshAllResetCredits(){
  toast('正在查询全部账号的 Codex 重置次数…')
  try{const r=await fetch(API+'/chatgpt-accounts/refresh-reset-credits-all',{method:'POST'}),d=await r.json();if(!r.ok)throw new Error(d.error?.message||'查询失败');cfg=d.config;render();toast(d.message||'查询完成')}catch(e){toast(e.message,'error')}
}
function openResetQuota(id){
  const account=(cfg.chatgptAccounts||[]).find(item=>item.id===id)
  if(!account)return toast('账号不存在','error')
  const count=Number(account.reset_credits?.available_count||0)
  if(count<=0)return toast('请先查询并确认该账号有可用重置次数','error')
  const name=account.label||account.account_id||account.id
  const expiry=(account.reset_credits?.expires_at||[]).map(value=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})).join('；')
  showModal('重置 Codex 额度',`<div class="reset-warning"><b>高风险操作 · 消耗 1 次 · 不可撤销</b><p>账号：${esc(name)}<br>当前可用：${count} 次${expiry?`<br>到期（北京时间）：${esc(expiry)}`:''}</p><p>必须依次完成账号名称、风险选项和最终系统确认，才会提交重置。</p></div><div class="field"><label>第一步：输入完整账号名称 <b>${esc(name)}</b></label><input class="input" id="reset_account_confirmation" autocomplete="off" placeholder="输入上方完整账号名称" oninput="updateResetQuotaConfirmation('${esc(id)}')"><span class="hint">名称必须完全一致，用于防止选错账号。</span></div><div class="reset-confirmations help-note" style="display:grid;gap:10px;margin-top:15px"><b>第二步：勾选以下两项确认</b><label style="display:flex;align-items:flex-start;gap:9px;cursor:pointer"><input type="checkbox" id="reset_target_confirmation" style="margin-top:2px" onchange="updateResetQuotaConfirmation('${esc(id)}')"><span>我确认当前要重置的目标账号是 <strong>${esc(name)}</strong>。</span></label><label style="display:flex;align-items:flex-start;gap:9px;cursor:pointer"><input type="checkbox" id="reset_credit_confirmation" style="margin-top:2px" onchange="updateResetQuotaConfirmation('${esc(id)}')"><span>我已知晓此操作会立即消耗 <strong>1 次重置机会</strong>，提交后无法撤销。</span></label></div><p class="reset-final-hint" style="margin:13px 0 0;color:var(--muted);font-size:10px">第三步：点击下方按钮后，系统还会进行最后一次确认。</p>`,'确认并继续',`resetAccountQuota('${esc(id)}')`)
  const submit=modal?.querySelector('.modal-foot .btn-primary')
  if(submit){
    submit.id='reset_quota_submit'
    submit.classList.remove('btn-primary')
    submit.classList.add('btn-danger')
    submit.disabled=true
  }
  setTimeout(()=>document.getElementById('reset_account_confirmation')?.focus(),0)
}
function updateResetQuotaConfirmation(id){
  const account=(cfg.chatgptAccounts||[]).find(item=>item.id===id)
  const name=account&&(account.label||account.account_id||account.id)
  const entered=document.getElementById('reset_account_confirmation')?.value.trim()
  const targetConfirmed=document.getElementById('reset_target_confirmation')?.checked===true
  const creditConfirmed=document.getElementById('reset_credit_confirmation')?.checked===true
  const submit=document.getElementById('reset_quota_submit')
  const ready=Boolean(name&&entered===name&&targetConfirmed&&creditConfirmed&&!resetQuotaSubmitting)
  if(submit){
    submit.disabled=!ready
    submit.textContent=resetQuotaSubmitting?'正在提交…':'确认并继续'
  }
  return ready
}
async function resetAccountQuota(id){
  const account=(cfg.chatgptAccounts||[]).find(item=>item.id===id)
  if(!account)return toast('账号不存在','error')
  if(resetQuotaSubmitting)return toast('额度重置正在提交，请勿重复操作','error')
  const name=account.label||account.account_id||account.id
  const entered=document.getElementById('reset_account_confirmation')?.value.trim()
  if(entered!==name)return toast('账号名称不匹配，未执行重置','error')
  const confirmedTargetAccount=document.getElementById('reset_target_confirmation')?.checked===true
  const confirmedCreditConsumption=document.getElementById('reset_credit_confirmation')?.checked===true
  if(!confirmedTargetAccount||!confirmedCreditConsumption)return toast('请先勾选全部风险确认项','error')
  if(!confirm(`最后确认：确定立即重置「${name}」的 Codex 额度吗？\n\n此操作会消耗 1 次重置机会，提交后无法撤销。`))return
  resetQuotaSubmitting=true
  updateResetQuotaConfirmation(id)
  try{
    const r=await fetch(API+'/chatgpt-accounts/'+encodeURIComponent(id)+'/reset-quota',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmed:true,confirmedTargetAccount,confirmedCreditConsumption,confirmedAccountId:account.account_id,confirmedAccountLabel:name})}),d=await r.json()
    if(!r.ok)throw new Error(d.error?.message||'额度重置失败')
    cfg=d.config;closeModal();render();toast(d.message||'Codex 额度已重置')
  }catch(e){toast(e.message,'error')}
  finally{
    resetQuotaSubmitting=false
    updateResetQuotaConfirmation(id)
  }
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
function openAccountPolicy(id){
  const account=(cfg.chatgptAccounts||[]).find(item=>item.id===id)
  if(!account)return toast('账号不存在','error')
  const globalReserve=Number(cfg.chatgptLowQuotaThreshold??10)
  const emergencyUntil=Date.parse(account.emergency_continue_until||'')
  const emergencyActive=Number.isFinite(emergencyUntil)&&emergencyUntil>Date.now()
  showModal('账号额度与预留策略',`<div class="form-grid">
    <div class="field"><label>安全余量 <span class="hint">账号独立阈值</span></label><input class="input" id="policy_reserve" type="number" min="0" max="100" value="${Number(account.low_quota_threshold??globalReserve)}"></div>
    <div class="field"><label>每日请求上限 <span class="hint">0 为不限</span></label><input class="input" id="policy_requests" type="number" min="0" value="${Number(account.daily_request_limit||0)}"></div>
    <div class="field full"><label>每日 Token 上限 <span class="hint">输入 + 输出，0 为不限</span></label><input class="input" id="policy_tokens" type="number" min="0" value="${Number(account.daily_token_limit||0)}"></div>
    <div class="field full"><label>预留模型 <span class="hint">逗号分隔；设置后普通模型不能使用该账号</span></label><input class="input" id="policy_models" value="${esc((account.reserved_models||[]).join(', '))}" placeholder="gpt-important"></div>
    <div class="field full"><label>预留会话 ID <span class="hint">逗号分隔；匹配 session-id / thread-id</span></label><input class="input" id="policy_sessions" value="${esc((account.reserved_session_ids||[]).join(', '))}" placeholder="重要会话 ID"></div>
    <div class="field full"><div class="help-note"><b style="color:var(--red)">紧急继续使用</b><p>临时绕过安全余量和每日上限，最长 24 小时，到期自动恢复。可能耗尽当前额度，仅在重要任务中使用。</p>${emergencyActive?`<p>当前有效至 ${esc(new Date(emergencyUntil).toLocaleString('zh-CN'))}</p>`:''}</div></div>
    <div class="field"><label>临时持续分钟 <span class="hint">留空保持，0 立即关闭</span></label><input class="input" id="policy_emergency_minutes" type="number" min="0" max="1440" placeholder="例如 60"></div>
    <div class="field"><label style="display:flex;align-items:center;gap:8px"><input id="policy_emergency_confirm" type="checkbox"> 我确认可能耗尽额度</label></div>
  </div>`,'保存策略',`saveAccountPolicy('${esc(id)}')`)
}
async function saveAccountPolicy(id){
  const emergencyRaw=String(document.getElementById('policy_emergency_minutes')?.value||'').trim()
  const emergencyMinutes=emergencyRaw===''?null:Math.max(0,Number(emergencyRaw)||0)
  const confirmedEmergencyRisk=document.getElementById('policy_emergency_confirm')?.checked===true
  if(emergencyMinutes>0&&!confirmedEmergencyRisk)return toast('启用紧急继续前必须勾选风险确认','error')
  if(emergencyMinutes>0&&!confirm(`确定临时绕过额度保护 ${emergencyMinutes} 分钟吗？到期后会自动恢复。`))return
  const split=id=>String(document.getElementById(id)?.value||'').split(',').map(value=>value.trim()).filter(Boolean)
  const body={
    lowQuotaThreshold:Number(document.getElementById('policy_reserve')?.value),
    dailyRequestLimit:Number(document.getElementById('policy_requests')?.value),
    dailyTokenLimit:Number(document.getElementById('policy_tokens')?.value),
    reservedModels:split('policy_models'),
    reservedSessionIds:split('policy_sessions'),
    ...(emergencyMinutes===null?{}:{emergencyContinueMinutes:emergencyMinutes,confirmedEmergencyRisk})
  }
  try{
    const r=await fetch(API+'/chatgpt-accounts/'+encodeURIComponent(id)+'/routing',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),d=await r.json()
    if(!r.ok)throw new Error(d.error?.message||'额度策略更新失败')
    cfg=d.config;closeModal();render();toast(d.message||'账号额度策略已更新')
  }catch(e){toast(e.message,'error')}
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
async function deployWorkspaceUpdate(){
  const deployment=diagnosticsData.deployment||{}
  const differenceCount=Number(deployment.consistency?.difference_count)||0
  if(!confirm(`确定部署工作区更新到实际安装目录吗？\n\n不一致文件：${differenceCount}\n安装目录：${deployment.installation?.path||'未知'}\n\n系统会先备份，随后重启并执行健康检查；验证失败会自动回滚。`))return
  try{
    const response=await fetch(API+'/deploy-update',{method:'POST'}),data=await response.json()
    if(!response.ok)throw new Error(data.error?.message||'无法启动部署')
    toast(data.message||'安全部署已启动')
    for(let attempt=0;attempt<100;attempt++){
      await new Promise(resolve=>setTimeout(resolve,1000))
      try{
        const live=await fetch('/live',{cache:'no-store'})
        if(!live.ok)continue
        const runtimeResponse=await fetch(API+'/runtime-info',{cache:'no-store'})
        if(!runtimeResponse.ok)continue
        const runtime=await runtimeResponse.json()
        if(runtime.consistency?.synchronized===true){
          toast(`部署完成 · ${runtime.runtime?.version||'版本未知'} · ${String(runtime.runtime?.commit||'').slice(0,10)}`)
          await load(false,false)
          return
        }
        if(runtime.last_deployment?.status==='rolled_back'){
          throw new Error(`部署验证失败，已自动回滚：${runtime.last_deployment.error||'未知原因'}`)
        }
      }catch(error){
        if(/已自动回滚/.test(error.message))throw error
      }
    }
    throw new Error('部署仍在进行或健康检查超时，请查看安装目录中的 .last-deployment.json')
  }catch(error){toast(error.message,'error')}
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
async function resetProviderHealth(){
  if(!confirm('确定清空 Provider 健康历史吗？这不会修改配置、账号或当前熔断状态。'))return
  try{const r=await fetch(API+'/provider-health',{method:'DELETE'}),d=await r.json();if(!r.ok)throw new Error(d.error?.message||'清空失败');diagnosticsData.provider_health=d.provider_health||{providers:{}};render();toast(d.message||'Provider 健康历史已清空')}catch(e){toast(e.message,'error')}
}
async function resetStats(){if(!confirm('确定清空全部本地用量统计吗？'))return;try{const r=await fetch(API+'/stats',{method:'DELETE'});statsData=await r.json();render();toast('统计数据已清空')}catch(e){toast(e.message,'error')}}
function toast(message,type='success'){document.querySelector('.toast')?.remove();const el=document.createElement('div');el.className='toast '+type;el.innerHTML=`${svg(type==='error'?'x':'check')}<span>${esc(message)}</span>`;document.body.appendChild(el);setTimeout(()=>el.remove(),2800)}

window.addEventListener('hashchange',()=>switchPage(location.hash.slice(1)))
document.getElementById('refreshButton').innerHTML=svg('refresh')
document.getElementById('menuButton').innerHTML=svg('overview')
initTheme(); switchPage(activePage); load()
