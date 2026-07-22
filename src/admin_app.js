const MANAGEMENT = window.__TORVYE_MANAGEMENT__ || Object.freeze({mode:'standalone',surface:'browser',apiBase:'/admin/api'})
const API = MANAGEMENT.apiBase || '/admin/api'
const CENTRAL_MANAGEMENT = MANAGEMENT.mode === 'gateway'
const FULL_CONSOLE_PAGES = new Set(['overview','providers','relays','accounts','analytics','settings','help'])
const browserBootstrapHash = location.hash.startsWith('#browser?') ? location.hash : ''
let cfg = {}, statsData = { providers: {} }, diagnosticsData = { accounts: [], queue: {}, config_snapshots: [], account_backups: [], recent_route_decisions: [], provider_health: {providers:{}}, credential_protection: {}, circuits: [] }, modelCatalog = [], activePage = FULL_CONSOLE_PAGES.has(location.hash.slice(1)) ? location.hash.slice(1) : 'overview'
let pingResults = {}, modal = null, loginPoll = null, accountsPoll = null, draggedAccountId = null, resetQuotaSubmitting = false
let errorGuideData = []
let loginPreflightData = null
let priceCatalogData = { prices: {} }, costReportData = { providers: {} }
let accountImportFileName = ''
let accountImportFiles = []
let batchLoginQueue = [], batchLoginIndex = 0, batchLoginPreflightData = null
let activeLoginUi = null
let accountViewMode = localStorage.getItem('codex-account-view') === 'compact' ? 'compact' : 'cards'
let accountCategory = ['all','issues','stable_pool','disposable_pool','discarded','refreshable','temporary','expiring','expired','incompatible'].includes(localStorage.getItem('codex-account-category')) ? localStorage.getItem('codex-account-category') : 'all'
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
const ADMIN_ACTIONS = new Set([
  'toggleSidebar','load','toggleTheme','switchPage','shiftUsageCalendarMonth','resetUsageCalendarMonth',
  'deployWorkspaceUpdate','refreshDiagnosis','pingAll','pingChannel','runDiagnosisAction','toggleSecret',
  'saveConfig','openRelay','saveRelay','removeRelay','closeModal','readRelayLink','parseRelayLink',
  'importCurrentAccount','saveAccount',
  'openAuthFilePicker','authDrag','authDrop','openBatchOfficialLogin','loadAuthFiles','clearManualAccountImport',
  'openRenameAccount','saveAccountRenameOnEnter','saveAccountRename','copyLoginDiagnostics',
  'copyBatchLoginCredential','startBatchOfficialLogin','advanceBatchOfficialLogin','finishBatchOfficialLogin',
  'cancelBatchOfficialLogin','skipBatchOfficialLogin',
  'loadBatchLoginFiles','copyDeviceCode','startOfficialLogin','cancelOfficialLogin',
  'updateResetQuotaConfirmation','resetAccountQuota','updateAccountPoolTierPolicyForm','saveAccountPolicy',
  'filterErrorGuide','copyProxyAddress','startAccountDrag',
  'preventAdminDrag','dropAccount','refreshAccountUsageOne','updateAccountWeight',
  'refreshAccountResetCreditsOne','openResetQuota','openAccountPolicy','removeAccount','switchAccount',
  'toggleAccountRouting','setAccountViewMode','setHealthRange','setAccountCategory','openOfficialLogin',
  'checkAllAccountStatus','refreshAllUsage','refreshAllResetCredits','restartCodex','openAccount',
  'rollbackConfigSnapshot','restoreAccountBackup','downloadDiagnostics','repairRuntime',
  'resetProviderHealth','gracefulRestartProxy','resetCircuits','savePriceCatalog','resetStats'
])
function splitAdminActionArguments(source){
  const values=[]
  let current='',quote='',escaped=false
  for(const char of source){
    if(escaped){current+=char;escaped=false;continue}
    if(char==='\\'){current+=char;escaped=true;continue}
    if(quote){current+=char;if(char===quote)quote='';continue}
    if(char==="'"||char==='"'){current+=char;quote=char;continue}
    if(char===','){values.push(current.trim());current='';continue}
    current+=char
  }
  if(quote||escaped)throw new Error('Malformed admin action arguments')
  if(current.trim())values.push(current.trim())
  return values
}
function parseAdminActionArgument(token,event,element){
  if(token==='event')return event
  if(token==='this')return element
  if(token==='this.value')return element.value
  if(token==='this.files')return element.files
  if(token==='true')return true
  if(token==='false')return false
  if(token==='null')return null
  if(/^-?\d+(?:\.\d+)?$/.test(token))return Number(token)
  if((token.startsWith("'")&&token.endsWith("'"))||(token.startsWith('"')&&token.endsWith('"'))){
    const quote=token[0]
    let value=''
    for(let index=1;index<token.length-1;index++){
      const char=token[index]
      if(char!=='\\'){value+=char;continue}
      index++
      const escaped=token[index]
      value+=escaped==='n'?'\n':escaped==='r'?'\r':escaped==='t'?'\t':escaped===quote?quote:escaped
    }
    return value
  }
  throw new Error('Unsupported admin action argument')
}
function dispatchAdminAction(event){
  if(!(event.target instanceof Element))return
  const attribute=`data-admin-on${event.type}`
  const element=event.target.closest(`[${attribute}]`)
  if(!element)return
  const expression=element.getAttribute(attribute)||''
  const match=/^([A-Za-z_$][\w$]*)\((.*)\)$/.exec(expression.trim())
  if(!match||!ADMIN_ACTIONS.has(match[1]))return
  const action=globalThis[match[1]]
  if(typeof action!=='function')return
  try{
    const args=splitAdminActionArguments(match[2]).map(token=>parseAdminActionArgument(token,event,element))
    const result=action(...args)
    if(result&&typeof result.catch==='function')result.catch(error=>toast(error?.message||'操作失败','error'))
  }catch(error){
    toast(error?.message||'操作失败','error')
  }
}
for(const eventName of ['click','change','input','keydown','dragstart','dragover','dragleave','drop']){
  document.addEventListener(eventName,dispatchAdminAction)
}
function openAuthFilePicker(){document.getElementById('auth_file')?.click()}
function clearManualAccountImport(input){
  if(!input.value.trim())return
  accountImportFiles=[]
  accountImportFileName=''
  const preview=document.getElementById('auth_file_preview')
  if(preview)preview.innerHTML=''
}
function saveAccountRenameOnEnter(event,id){if(event.key==='Enter')void saveAccountRename(id)}
function preventAdminDrag(event){event.preventDefault()}
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
      <div class="usage-calendar-toolbar"><div><strong>${year} 年 ${month} 月</strong><span>${isCurrent?'当前月份':'历史月份'}</span></div><div class="usage-calendar-nav"><button data-admin-onclick="shiftUsageCalendarMonth(-1)" title="上一个月">‹</button>${isCurrent?'':`<button class="calendar-today" data-admin-onclick="resetUsageCalendarMonth()">本月</button>`}<button data-admin-onclick="shiftUsageCalendarMonth(1)" title="下一个月" ${isCurrent?'disabled':''}>›</button></div></div>
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
  document.getElementById('nav').innerHTML=navGroups.map(([g,items])=>`<div class="nav-label">${g}</div>${items.map(([id,label])=>`<button class="nav-btn ${activePage===id?'active':''}" data-admin-onclick="switchPage('${id}')">${svg(id)}<span>${label}</span></button>`).join('')}`).join('')
}
function switchPage(page){
  activePage=pages[page]?page:'overview'; location.hash=activePage
  const [title,sub]=pages[activePage]
  const centralSubtitles={
    overview:'查看中央 Gateway 运行状态与资源使用情况',
    providers:'管理中央上游模型服务与只写凭据',
    relays:'管理中央 OpenAI 兼容节点与模型路由',
    accounts:'管理中央 ChatGPT 订阅账号与自动轮换',
    analytics:'查看中央请求、Token 与模型用量',
    settings:'查看中央 Gateway 路由、费率与安全状态',
    help:'中央统一管理平台使用教程'
  }
  document.getElementById('top-title').textContent=title
  document.getElementById('top-subtitle').textContent=CENTRAL_MANAGEMENT?(centralSubtitles[activePage]||sub):sub
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
function setAccountCategory(category){
  if(!['all','issues','stable_pool','disposable_pool','discarded','refreshable','temporary','expiring','expired','incompatible'].includes(category))return
  accountCategory=category
  localStorage.setItem('codex-account-category',category)
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
    const [c,s,d,r,m,e,p,cost]=await Promise.all([fetch(API+'/config'),fetch(API+'/stats'),fetch(API+'/diagnostics').catch(()=>null),fetch(API+'/resilience').catch(()=>null),includeModels?fetch(CENTRAL_MANAGEMENT?API+'/models':'/v1/models').catch(()=>null):null,fetch(API+'/error-guide').catch(()=>null),fetch(API+'/prices').catch(()=>null),fetch(API+'/costs').catch(()=>null)])
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
function button(text,icon,fn,cls=''){ return `<button class="btn ${cls}" data-admin-onclick="${fn}">${icon?svg(icon):''}${text}</button>` }
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
    return `<div class="provider-row"><div class="provider-name"><span class="provider-logo ${logo}">${logo==='chatgpt'?'G':logo==='openai'?'AI':logo==='deepseek'?'D':'R'}</span><div><strong>${name}</strong><small>${sub}</small></div></div><div class="latency-cell"${healthTitle}><span class="status ${statusClass}"><i></i>${status}</span><div class="cell-sub">${trendText}</div>${persisted?.trend_warning?`<div class="cell-sub" style="color:var(--red)">${esc(persisted.trend_warning.message)}</div>`:''}</div><div class="usage-cell"><span class="cell-sub">${fmt(p.requests)} 次请求</span><div class="mini-bar"><i style="width:${Math.min(100,(p.requests||0)/Math.max(1,totals().requests)*100)}%"></i></div></div><button class="btn btn-sm" data-admin-onclick="pingChannel('${key}')">${svg('pulse')}检测</button></div>`
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
    const actions=(issue.actions||[]).map(item=>`<button class="btn btn-sm" data-admin-onclick="runDiagnosisAction('${esc(item.id)}','${esc(item.target||'')}',event)">${esc(item.label)}</button>`).join('')
    return `<div class="provider-row" style="grid-template-columns:minmax(0,1fr) auto"><div><span class="status ${issue.level==='critical'?'off':'warn'}"><i></i><b>${esc(issue.title)}</b></span><div class="cell-sub" style="margin-top:5px">${esc(issue.conclusion)}</div></div><div class="card-actions">${actions}</div></div>`
  }).join(''):`<div class="help-note"><span class="status ${tone}"><i></i>${esc(diagnosis.summary?.conclusion||'未发现明显异常')}</span></div>`
  const pool=diagnosis.account_pool||{},ops=diagnosis.trends?.operational||{}
  const summary=`可用 ${Number(pool.eligible)||0} · 仅保存 ${Number(pool.stored_only)||0} · 冷却 ${Number(pool.cooling||0)+Number(pool.model_cooling||0)} · 额度不足 ${Number(pool.below_reserve)||0} · 并发满 ${Number(pool.busy)||0} · 24h 切换 ${Number(ops['24h']?.account_switches)||0} / 熔断 ${Number(ops['24h']?.circuit_opens)||0}`
  return card('自动诊断中心',summary,`<div class="card-body">${body}</div>`,button('重新分析','pulse','refreshDiagnosis()','btn-sm'))
}
function renderOverview(){
  const t=totals()
  const today=normalizedDaily(1)[0]
  const recent=allProviders().flatMap(p=>Object.entries(p.models||{})).filter(([,v])=>(Number(v.requests)||0)>0).sort((a,b)=>(b[1].requests||0)-(a[1].requests||0)).slice(0,4)
  const activity=recent.length?recent.map(([name,v])=>`<div class="activity"><span class="activity-icon">${svg('arrow')}</span><div><p><b>${esc(name)}</b> 完成 ${fmt(v.requests)} 次路由请求</p><small>输入 ${fmt(v.input_tokens)} · 输出 ${fmt(v.output_tokens)} Tokens</small></div></div>`).join(''):empty('pulse','暂无调用记录','请求将在这里实时汇总')
  return pageHead('控制台概览','统一查看模型网关、账号池和节点状态',button('检测全部通道','pulse','pingAll()','btn-primary'))+
    deploymentBanner()+
    `<div class="metrics">${metric('今日请求',fmt(today.requests),'pulse',`累计完成 ${fmt(t.requests)} 次`)}${metric('今日 Token',fmt(dailyTokens(today)),'analytics',`输入 ${fmt(today.input_tokens)} · 输出 ${fmt(today.output_tokens)}`)}${metric('连续活跃',`${activeStreak()} 天`,'server','以每天产生请求或 Token 记录计算')}${metric('账号池',String((cfg.chatgptAccounts||[]).length),'users',`今日 ${fmt(today.account_attempts)} 次账号路由尝试`)}</div>`+
    diagnosisCenter()+
    `<div class="grid overview-grid">${card('AI 使用日历',CENTRAL_MANAGEMENT?'按月查看 · 中央统计':'按月查看 · 默认显示当前月份 · 数据仅保存在本机',`<div class="card-body usage-calendar-body">${usageHeatmap()}</div>`)}${card('最近调用','按模型请求量排序',`<div class="card-body">${activity}</div>`)}${card('服务状态','上游通道与实时连通性',`<div class="card-body">${providerRows()}</div>`,button('管理服务','',"switchPage('providers')",'btn-sm'))}${card('运行信息','当前网关环境',`<div class="card-body"><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">默认模型</span><b>${esc(cfg.defaultModel||'-')}</b></div><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">统计更新时间</span><b>${statsData.updated?new Date(statsData.updated).toLocaleTimeString('zh-CN'):'-'}</b></div><div class="provider-row" style="grid-template-columns:1fr auto"><span class="cell-sub">部署模式</span><span class="badge">${CENTRAL_MANAGEMENT?'Central Gateway':'Local'}</span></div></div>`)}</div>`
}
function field(name,label,type='text',hint='',full=false){
  const value=cfg[name]||'', password=type==='password'
  return `<div class="field ${full?'full':''}"><label>${label}${hint?` <span class="hint">${hint}</span>`:''}</label><div class="input-wrap"><input class="input" id="f_${name}" type="${password?'password':'text'}" value="${esc(value)}">${password?`<button class="icon-btn" type="button" data-admin-onclick="toggleSecret('f_${name}',this)">${svg('eye')}</button>`:''}</div></div>`
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
  const body=relays.length?`<div class="table-wrap"><table class="table"><thead><tr><th>节点</th><th>状态</th><th>模型</th><th>操作</th></tr></thead><tbody>${relays.map(r=>`<tr><td><div class="cell-main">${esc(r.name)}</div><div class="cell-sub">${esc(r.base_url)}</div></td><td><span class="status ${pingResults['relay:'+r.id]?.ok?'':'off'}"><i></i>${pingResults['relay:'+r.id]?(pingResults['relay:'+r.id].ok?'正常':'异常'):'未检测'}</span></td><td><div class="tags">${(r.models||[]).slice(0,4).map(m=>`<span class="tag">${esc(m)}</span>`).join('')}${(r.models||[]).length>4?`<span class="tag">+${r.models.length-4}</span>`:''}</div></td><td><div class="card-actions"><button class="btn btn-sm" data-admin-onclick="pingChannel('relay','${esc(r.id)}')">${svg('pulse')}</button><button class="btn btn-sm" data-admin-onclick="openRelay('${esc(r.id)}')">${svg('edit')}</button><button class="btn btn-sm btn-danger" data-admin-onclick="removeRelay('${esc(r.id)}')">${svg('trash')}</button></div></td></tr>`).join('')}</tbody></table></div>`:empty('relays','还没有中转节点','添加 OpenAI 兼容 API 节点，构建多线路容灾',button('添加第一个节点','plus','openRelay()','btn-primary'))
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
function render(){
  const fn={
    overview:renderOverview,
    providers:renderProviders,
    relays:renderRelays,
    accounts:AdminAccountsUI.render,
    analytics:AdminAnalyticsUI.render,
    settings:AdminSettingsUI.render,
    help:AdminTutorialUI.render
  }[activePage]
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
async function runDiagnosisAction(id,target,event){
  if(id==='refresh_quota'){
    await refreshAllUsage()
    return refreshDiagnosis()
  }
  if(id==='check_accounts'){
    switchPage('accounts')
    return checkAllAccountStatus()
  }
  if(id==='ping_providers'){
    switchPage('providers')
    await pingAll()
    return refreshDiagnosis()
  }
  if(id==='official_login'){
    switchPage('accounts')
    return openOfficialLogin(event)
  }
  if(target?.startsWith('#'))switchPage(target.slice(1))
}
function showModal(title,body,saveText,saveFn){
  closeModal(); const el=document.createElement('div'); el.className='modal-overlay'; el.onclick=e=>{if(e.target===el)closeModal()}
  el.innerHTML=`<div class="modal"><div class="modal-head"><strong>${title}</strong><button class="icon-btn" data-admin-onclick="closeModal()">${svg('x')}</button></div><div class="modal-body">${body}</div><div class="modal-foot">${button('取消','','closeModal()')}${button(saveText,'check',saveFn,'btn-primary')}</div></div>`; document.body.appendChild(el); modal=el
}
function clearBatchLoginSecrets(){
  for(const item of batchLoginQueue)item.password=''
  batchLoginQueue=[];batchLoginIndex=0;batchLoginPreflightData=null
}
function closeModal(){
  const batchWaiting=batchLoginQueue[batchLoginIndex]?.status==='waiting'
  const shouldCancelLogin=Boolean(activeLoginUi)||batchWaiting
  activeLoginUi=null
  if(loginPoll)clearInterval(loginPoll)
  loginPoll=null
  for(const file of accountImportFiles)file.content=''
  accountImportFiles=[];accountImportFileName=''
  clearBatchLoginSecrets()
  if(shouldCancelLogin)fetch(API+'/chatgpt-login/cancel',{method:'POST'}).catch(()=>{})
  if(modal)modal.remove()
  modal=null
}
function openRelay(id=''){
  const r=(cfg.relays||[]).find(x=>x.id===id)||{id:'',name:'',base_url:'https://api.openai.com/v1',api_key:'',models:['gpt-5.4','gpt-5.4-mini']}
  const quick=id?'':`<div class="field full"><label>CC Switch 快捷导入链接 <span class="hint">兼容 ccswitch://v1/import</span></label><div class="input-wrap"><input class="input" id="relay_deeplink" placeholder="粘贴供应商提供的 ccswitch:// 快捷链接"><button class="btn" data-admin-onclick="readRelayLink()">${svg('download')}读取剪贴板</button><button class="btn" data-admin-onclick="parseRelayLink()">解析</button></div><span class="hint" id="relay_link_hint">链接只在本地解析，不会访问供应商网站。</span></div><div class="divider full">或者手动填写</div>`
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
  const currentImport=CENTRAL_MANAGEMENT?'':`<button class="quick-option" data-admin-onclick="importCurrentAccount()">${svg('refresh')}<strong>一键导入当前账号</strong><small>完整 OAuth 凭据<br>可自动续约</small></button>`
  showModal('快捷导入 ChatGPT 账号',`<div class="quick-import">${currentImport}<button class="quick-option" id="auth_drop" data-admin-onclick="openAuthFilePicker()" data-admin-ondragover="authDrag(event,true)" data-admin-ondragleave="authDrag(event,false)" data-admin-ondrop="authDrop(event)">${svg('download')}<strong>批量选择账号文件</strong><small>CPA/sub2 自动验权<br>兼容 Token 才能临时直用</small></button><button class="quick-option" data-admin-onclick="openBatchOfficialLogin(event)">${svg('users')}<strong>批量官方登录</strong><small>把临时或不兼容账号转为<br>可自动续约账号</small></button></div><input id="auth_file" type="file" multiple accept=".json,.txt,application/json,text/plain" class="hidden" data-admin-onchange="loadAuthFiles(this.files)">
  <div class="help-note" style="margin-top:12px"><b>系统会自动分类并校验 OAuth 客户端</b><p><b>稳定保险池：</b>默认用于完整可续约账号；仅在日抛池不可用时参与，并保留安全余量。<br><b>日抛优先池：</b>默认用于仅 Access Token 的临时账号；优先消耗到 0，周额度 7 天仍未恢复就自动停用弃号。<br><b>权限不兼容：</b>某些 CPA/sub2 Token 虽能查询额度，但不能调用 Codex Responses，将强制仅保存并提示官方登录。</p></div><div id="auth_file_preview" style="display:grid;gap:7px;margin:10px 0"></div>
  <div class="divider">或者手动粘贴单个账号</div><div class="form-grid"><div class="field full"><label>单账号备注 <span class="hint">批量文件会使用文件内名称</span></label><input class="input" id="account_label" maxlength="80" placeholder="例如：备用账号"></div><div class="field full"><label>账号池分级</label><select class="input" id="account_pool_tier"><option value="">自动：可续约进稳定池，临时号进日抛池</option><option value="stable">稳定保险池</option><option value="disposable">日抛优先池</option></select><span class="hint">可以在账号“额度策略”中随时调整，已弃号需先改为稳定池才能恢复。</span></div><div class="field full"><label style="display:flex;align-items:center;gap:8px"><input id="account_routing_enabled" type="checkbox"> 导入后立即参与自动路由</label><span class="hint">日抛号会优先使用到 0；不兼容 Token 即使勾选也会强制仅保存。</span></div><div class="field full"><label>账号文件内容</label><textarea id="account_json" style="min-height:150px" placeholder='粘贴 auth.json、sub2/CPA JSON 或完整凭据 TXT' data-admin-oninput="clearManualAccountImport(this)"></textarea><span class="hint" id="auth_file_hint">凭据只发送到本机管理接口，不会访问文件来源网站。</span></div></div>`,'安全导入','saveAccount()')
  accountImportFiles=[];accountImportFileName=''
}
function openRenameAccount(id){
  const account=(cfg.chatgptAccounts||[]).find(item=>item.id===id)
  if(!account)return toast('账号不存在','error')
  showModal('修改账号名称',`<div class="form-grid"><div class="field full"><label>账号名称</label><input class="input" id="rename_account_label" maxlength="80" value="${esc(account.label||account.email||'')}" placeholder="例如：工作账号" data-admin-onkeydown="saveAccountRenameOnEnter(event,'${esc(id)}')"><span class="hint">仅修改本地显示名称，不影响 OpenAI 账号信息或登录状态。</span></div></div>`,'保存名称',`saveAccountRename('${esc(id)}')`)
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
function authDrop(event){authDrag(event,false);loadAuthFiles(event.dataTransfer?.files)}
function renderAccountImportPreview(preview){
  const target=document.getElementById('auth_file_preview')
  if(!target)return
  target.innerHTML=(preview||[]).map(item=>{
    const state=!item.accounts
      ? {tone:'off',label:'不能直导',detail:'未发现 ChatGPT access_token + account_id；邮箱 OAuth 不能替代'}
      : item.incompatible
        ? {tone:'off',label:'不可用于订阅通道',detail:`OAuth 客户端/权限与 Codex 官方登录不兼容；可保存但不能直接使用，请改用批量官方登录`}
      : item.invalidTemporary
        ? {tone:'off',label:'临时令牌无效',detail:'Access Token 已到期或无法读取到期时间'}
        : item.temporary
          ? {tone:'warn',label:'临时直导',detail:`${item.temporary} 个账号 · 最早剩余 ${item.countdown||'未知'}${item.duplicate_accounts?` · 与前面文件重复 ${item.duplicate_accounts} 个`:''}`}
          : {tone:'',label:'可自动续约',detail:`${item.refreshable} 个账号 · 包含 ChatGPT Refresh Token${item.duplicate_accounts?` · 与前面文件重复 ${item.duplicate_accounts} 个`:''}`}
    return `<div class="provider-row" style="grid-template-columns:minmax(0,1fr) auto;padding:9px 10px"><div style="min-width:0"><div class="cell-main">${esc(item.name)}</div><div class="cell-sub">${esc(state.detail)}</div></div><span class="status ${state.tone}"><i></i>${state.label}</span></div>`
  }).join('')
}
async function loadAuthFiles(files){
  const selected=[...(files||[])]
  if(!selected.length)return
  if(selected.length>300)return toast('单次最多选择 300 个账号文件','error')
  if(selected.some(file=>!/\.(json|txt)$/i.test(file.name)))return toast('请选择 JSON 或 TXT 账号文件','error')
  if(selected.some(file=>file.size>2*1024*1024))return toast('单个账号文件不能超过 2 MiB','error')
  if(selected.reduce((sum,file)=>sum+file.size,0)>20*1024*1024)return toast('单次文件总大小不能超过 20 MiB','error')
  try{
    const entries=await Promise.all(selected.map(async file=>({name:file.name,content:await file.text()})))
    if(entries.some(file=>!file.content.trim()))throw new Error('选择的文件中存在空文件')
    accountImportFiles=entries
    accountImportFileName=entries.length===1?entries[0].name:''
    renderAccountImportPreview(AdminUIBehaviors.inspectDirectImportFiles(entries))
    const textarea=document.getElementById('account_json')
    if(textarea)textarea.value=entries.length===1?entries[0].content:''
    document.getElementById('auth_file_hint').textContent=`已读取 ${entries.length} 个文件 · 将逐文件识别为临时或可续约账号，并自动去重`
    toast(`已读取 ${entries.length} 个账号文件`)
  }catch(e){toast('无法读取文件：'+e.message,'error')}
}
async function loadAuthFile(file){return loadAuthFiles(file?[file]:[])}
async function importCurrentAccount(){
  try{
    const poolTier=String(document.getElementById('account_pool_tier')?.value||'stable')
    const r=await fetch(API+'/chatgpt-accounts/import-current?poolTier='+encodeURIComponent(poolTier),{method:'POST'}),d=await r.json()
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
  return `<div style="display:grid;gap:8px"><div class="status ${data.ok?'':'off'}"><i></i>${esc(data.message||'预检完成')}</div>${candidates||'<span class="cell-sub">没有发现 Codex CLI</span>'}${browser}${repairs}<button class="btn btn-sm" type="button" data-admin-onclick="copyLoginDiagnostics()">${svg('download')}复制登录诊断</button></div>`
}
function ignoreAccidentalModalTrigger(event){
  if(event&&event.button!=null&&event.button!==0)return true
  const selection=String(window.getSelection?.()?.toString()||'').trim()
  if(selection){
    event?.preventDefault?.()
    event?.stopPropagation?.()
    return true
  }
  return false
}
async function cancelStaleOfficialLogin(){
  try{
    const response=await fetch(API+'/chatgpt-login/status',{cache:'no-store'}),data=await response.json()
    if(data.status!=='waiting')return false
    await fetch(API+'/chatgpt-login/cancel',{method:'POST'})
    return true
  }catch{return false}
}
async function openOfficialLogin(event){
  if(ignoreAccidentalModalTrigger(event))return
  loginPreflightData=null
  showModal('OpenAI 官方安全登录',`<div class="form-grid"><div class="field full"><div style="padding:13px;border-radius:10px;background:var(--primary-soft);color:var(--primary);font-size:11px;line-height:1.7">登录通过隔离的 Codex app-server 浏览器 OAuth 完成，不会修改本机现有 Codex 的 auth.json。分类会随登录结果一起写入账号记录，新账号默认仅保存。</div></div><div class="field full"><label>登录环境预检</label><div id="login_preflight" class="help-note">${loginPreflightHtml(null)}</div></div><div class="field full"><label>邮箱或账号备注 <span class="hint">仅用于账号池中识别，可选</span></label><input class="input" id="login_label" type="email" autocomplete="email" placeholder="例如 name@example.com"></div><div class="field full"><label>账号分类</label><select class="input" id="login_pool_tier"><option value="stable">稳定保险池</option><option value="disposable">日抛优先池</option></select><span class="hint">正式长期订阅选稳定池；短期购买或准备耗尽额度的账号选日抛池。</span></div><div class="field full"><label style="display:flex;align-items:center;gap:8px"><input id="login_routing_enabled" type="checkbox"> 登录后立即参与自动路由</label><span class="hint">不勾选时只放入账号池，不影响当前 Codex，也不会被代理选中。</span></div><div class="field full"><label>登录流程</label><div id="login_status" class="input" style="height:auto;min-height:48px;display:flex;align-items:center;gap:9px;flex-wrap:wrap"><span class="status off"><i></i>等待预检</span></div></div><div class="field full"><span class="hint">完成官方页面的登录和授权后，本地回调会自动通知后台，并同时保存账号分类。重复账号会被拒绝，不会覆盖已有账号。</span></div></div>`,'开始官方登录','startOfficialLogin()')
  const submit=modal?.querySelector('.modal-foot .btn-primary')
  if(submit)submit.disabled=true
  try{
    const staleCancelled=await cancelStaleOfficialLogin()
    const response=await fetch(API+'/chatgpt-login/preflight',{cache:'no-store'}),data=await response.json()
    loginPreflightData=data
    const target=document.getElementById('login_preflight')
    if(target)target.innerHTML=loginPreflightHtml(data)
    if(submit)submit.disabled=!data.ok
    const status=document.getElementById('login_status')
    if(status)status.innerHTML=`<span class="status ${data.ok?'':'off'}"><i></i>${data.ok?(staleCancelled?'已清理上次未完成的登录，可以重新开始':'预检通过，可以开始官方登录'):esc(data.message||'预检失败')}</span>`
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
function batchLoginStateLabel(status){
  return {
    pending:'待登录',
    waiting:'登录中',
    success:'已导入',
    error:'失败',
    skipped:'已跳过',
    duplicate:'池中已有',
    cancelled:'已取消'
  }[status]||'待登录'
}
function batchLoginPrimary({label='开始登录',disabled=false,action='startBatchOfficialLogin()'}={}){
  const submit=modal?.querySelector('.modal-foot .btn-primary')
  if(!submit)return
  submit.textContent=label
  submit.disabled=disabled
  submit.setAttribute('onclick',action)
}
function renderBatchLoginQueue(){
  const list=document.getElementById('batch_login_queue')
  const current=batchLoginQueue[batchLoginIndex]
  if(list){
    list.innerHTML=batchLoginQueue.length?`<div style="display:grid;gap:7px">${batchLoginQueue.map((item,index)=>`
      <div class="provider-row" style="grid-template-columns:auto 1fr auto;padding:9px 10px;${index===batchLoginIndex?'outline:2px solid var(--primary-soft);':''}">
        <b>${index+1}</b>
        <div style="min-width:0"><div class="cell-main">${esc(item.label||item.email)}</div><div class="cell-sub">${esc(item.email)} · ${item.password?'已读取登录密码':'需要手动输入密码'} · ${esc((item.sourceNames||[]).join('、'))}</div></div>
        <span class="status ${item.status==='success'?'':item.status==='pending'||item.status==='waiting'?'warn':'off'}"><i></i>${batchLoginStateLabel(item.status)}</span>
      </div>`).join('')}</div>`:'<span class="cell-sub">请选择 CPA、sub2 或配套 TXT 文件。</span>'
  }
  const currentBox=document.getElementById('batch_login_current')
  if(currentBox){
    currentBox.innerHTML=current?`<div style="display:grid;gap:9px">
      <div><b>当前 ${batchLoginIndex+1}/${batchLoginQueue.length}：${esc(current.label||current.email)}</b><div class="cell-sub">${esc(current.email)}</div></div>
      <div style="display:flex;gap:7px;flex-wrap:wrap">
        <button class="btn btn-sm" type="button" data-admin-onclick="copyBatchLoginCredential('email')">${svg('download')}复制邮箱</button>
        <button class="btn btn-sm" type="button" data-admin-onclick="copyBatchLoginCredential('password')" ${current.password?'':'disabled'}>${svg('shield')}复制登录密码</button>
        ${current.status==='waiting'?button('取消当前登录','x','cancelBatchOfficialLogin()','btn-sm'):''}
        ${current.status==='error'?button('跳过此账号','arrow','skipBatchOfficialLogin()','btn-sm'):''}
      </div>
      <span class="hint">密码只保存在当前页面内存中，不会发送给代理。完成一个账号后请关闭其私密窗口，再登录下一个。</span>
    </div>`:'<span class="cell-sub">尚未生成登录队列。</span>'
  }
  if(!batchLoginPreflightData?.ok||!current){
    batchLoginPrimary({label:'开始登录队列',disabled:true})
    return
  }
  if(current.status==='waiting'){
    batchLoginPrimary({label:'等待官方登录…',disabled:true})
    return
  }
  if(current.status==='success'||current.status==='skipped'||current.status==='duplicate'){
    const hasNext=batchLoginQueue.slice(batchLoginIndex+1).some(item=>['pending','error','cancelled'].includes(item.status))
    batchLoginPrimary(hasNext
      ? {label:'登录下一个',action:'advanceBatchOfficialLogin()'}
      : {label:'完成',action:'finishBatchOfficialLogin()'})
    return
  }
  batchLoginPrimary({
    label:current.status==='error'||current.status==='cancelled'?'重试当前账号':`登录第 ${batchLoginIndex+1} 个账号`,
    action:'startBatchOfficialLogin()'
  })
}
async function loadBatchLoginFiles(files){
  const selected=[...(files||[])]
  if(!selected.length)return
  if(selected.length>300)return toast('单次最多选择 300 个文件','error')
  if(selected.some(file=>file.size>2*1024*1024))return toast('单个账号文件不能超过 2 MiB','error')
  if(selected.reduce((sum,file)=>sum+file.size,0)>20*1024*1024)return toast('单次文件总大小不能超过 20 MiB','error')
  try{
    const entries=await Promise.all(selected.map(async file=>({name:file.name,content:await file.text()})))
    const candidates=AdminUIBehaviors.extractOfficialLoginCandidates(entries)
    if(!candidates.length)throw new Error('文件中没有识别到邮箱；请使用包含 email 字段的 CPA/sub2 JSON 或配套 TXT')
    const existingById=new Map((cfg.chatgptAccounts||[]).map(item=>[String(item.account_id||''),item]))
    batchLoginQueue=candidates.map(item=>({
      ...item,
      status:item.accountId&&existingById.has(item.accountId)&&existingById.get(item.accountId)?.credential_mode!=='temporary_access'?'duplicate':'pending',
      message:''
    }))
    batchLoginIndex=Math.max(0,batchLoginQueue.findIndex(item=>item.status==='pending'))
    const hint=document.getElementById('batch_login_file_hint')
    if(hint)hint.textContent=`已读取 ${selected.length} 个文件，识别到 ${batchLoginQueue.length} 个唯一账号`
    renderBatchLoginQueue()
  }catch(error){toast(error.message,'error')}
}
async function openBatchOfficialLogin(event){
  if(ignoreAccidentalModalTrigger(event))return
  showModal('批量官方登录队列',`<div class="form-grid">
    <div class="field full"><div class="help-note"><b>适用于缺少 ChatGPT refresh_token 的 CPA/sub2 文件</b><p>系统只从本地文件生成邮箱队列，然后逐个打开 OpenAI 官方登录。不会自动处理验证码、MFA 或验证码挑战，也不会把密码发送到后台。</p></div></div>
    <div class="field full"><label>登录环境预检</label><div id="batch_login_preflight" class="help-note">${loginPreflightHtml(null)}</div></div>
    <div class="field full"><label>选择账号文件 <span class="hint">可以一次选择多个 CPA、sub2 和 TXT 文件，自动按邮箱/账号 ID 去重</span></label><input id="batch_login_files" type="file" multiple accept=".json,.txt,application/json,text/plain" class="input" data-admin-onchange="loadBatchLoginFiles(this.files)"><span class="hint" id="batch_login_file_hint">文件只在浏览器本地解析；最多识别 100 个账号。</span></div>
    <div class="field full"><label>这批账号的分类</label><select class="input" id="batch_login_pool_tier"><option value="disposable">日抛优先池</option><option value="stable">稳定保险池</option></select><span class="hint">批量登录通常用于短期 CPA/sub2，默认日抛；如果是自有长期订阅号，请改为稳定池。</span></div>
    <div class="field full"><label style="display:flex;align-items:center;gap:8px"><input id="batch_login_routing_enabled" type="checkbox"> 登录成功后立即参与自动路由</label><span class="hint">建议保持关闭，全部登录后刷新额度并逐个启用。</span></div>
    <div class="field full"><label>当前账号</label><div id="batch_login_current" class="help-note"><span class="cell-sub">尚未生成登录队列。</span></div></div>
    <div class="field full"><label>登录状态</label><div id="batch_login_status" class="input" style="height:auto;min-height:48px;display:flex;align-items:center;gap:9px;flex-wrap:wrap"><span class="status off"><i></i>等待选择文件</span></div></div>
    <div class="field full"><label>账号队列</label><div id="batch_login_queue"><span class="cell-sub">请选择账号文件。</span></div></div>
  </div>`,'开始登录队列','startBatchOfficialLogin()')
  batchLoginQueue=[];batchLoginIndex=0;batchLoginPreflightData=null
  batchLoginPrimary({label:'开始登录队列',disabled:true})
  try{
    await cancelStaleOfficialLogin()
    const response=await fetch(API+'/chatgpt-login/preflight',{cache:'no-store'}),data=await response.json()
    batchLoginPreflightData=data
    const target=document.getElementById('batch_login_preflight')
    if(target)target.innerHTML=loginPreflightHtml(data)
    renderBatchLoginQueue()
  }catch(error){
    const target=document.getElementById('batch_login_preflight')
    if(target)target.innerHTML=loginPreflightHtml({ok:false,message:error.message,candidates:[],repair_commands:[]})
  }
}
async function copyBatchLoginCredential(kind){
  const current=batchLoginQueue[batchLoginIndex]
  const value=kind==='password'?current?.password:current?.email
  if(!value)return toast(kind==='password'?'文件中没有 OpenAI 登录密码':'没有可复制的邮箱','error')
  try{await navigator.clipboard.writeText(value);toast(kind==='password'?'登录密码已复制':'邮箱已复制')}catch{toast('复制失败，请从原始文件手动复制','error')}
}
async function startBatchOfficialLogin(){
  const current=batchLoginQueue[batchLoginIndex]
  if(!batchLoginPreflightData?.ok||!current||current.status==='waiting')return
  activeLoginUi='batch'
  current.status='waiting';current.message=''
  renderBatchLoginQueue()
  const status=document.getElementById('batch_login_status')
  if(status)status.innerHTML='<span class="status warn"><i></i>正在启动 OpenAI 官方登录页…</span>'
  try{
    const routingEnabled=document.getElementById('batch_login_routing_enabled')?.checked===true
    const poolTier=document.getElementById('batch_login_pool_tier')?.value||'disposable'
    const r=await fetch(API+'/chatgpt-login/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label:current.label||current.email,email:current.email,routingEnabled,poolTier})}),d=await r.json()
    if(activeLoginUi!=='batch'){
      if(r.ok)fetch(API+'/chatgpt-login/cancel',{method:'POST'}).catch(()=>{})
      return
    }
    if(!r.ok)throw new Error(d.error?.message||'无法启动登录')
    if(status)status.innerHTML=loginStatusContent(d)
    if(loginPoll)clearInterval(loginPoll)
    loginPoll=setInterval(checkBatchOfficialLogin,1200)
  }catch(error){
    if(activeLoginUi==='batch')activeLoginUi=null
    current.status='error';current.message=error.message
    if(status)status.innerHTML=`<span class="status off"><i></i>${esc(error.message)}</span>`
    renderBatchLoginQueue()
  }
}
async function checkBatchOfficialLogin(){
  try{
    const r=await fetch(API+'/chatgpt-login/status'),d=await r.json()
    const current=batchLoginQueue[batchLoginIndex],status=document.getElementById('batch_login_status')
    if(!current||!status)return
    const decision=AdminUIBehaviors.loginPollDecision(d.status)
    if(!decision.terminal){status.innerHTML=loginStatusContent(d);return}
    activeLoginUi=null
    clearInterval(loginPoll);loginPoll=null
    current.status=decision.outcome==='success'?'success':decision.outcome
    current.message=d.message||''
    status.innerHTML=decision.outcome==='success'
      ? `<span class="status"><i></i>${esc(d.message||'账号已导入')}。请关闭刚才的私密窗口，再点击“登录下一个”。</span>`
      : `<span class="status off"><i></i>${esc(d.message||'登录未完成')}</span>`
    renderBatchLoginQueue()
  }catch(error){
    activeLoginUi=null
    if(loginPoll)clearInterval(loginPoll)
    loginPoll=null
    const current=batchLoginQueue[batchLoginIndex]
    if(current){current.status='error';current.message=error.message}
    renderBatchLoginQueue()
    toast(error.message,'error')
  }
}
async function cancelBatchOfficialLogin(){
  activeLoginUi=null
  await fetch(API+'/chatgpt-login/cancel',{method:'POST'}).catch(()=>{})
  if(loginPoll)clearInterval(loginPoll)
  loginPoll=null
  const current=batchLoginQueue[batchLoginIndex]
  if(current)current.status='cancelled'
  const status=document.getElementById('batch_login_status')
  if(status)status.innerHTML='<span class="status off"><i></i>当前账号登录已取消</span>'
  renderBatchLoginQueue()
}
function skipBatchOfficialLogin(){
  const current=batchLoginQueue[batchLoginIndex]
  if(current)current.status='skipped'
  advanceBatchOfficialLogin()
}
function advanceBatchOfficialLogin(){
  const next=batchLoginQueue.findIndex((item,index)=>index>batchLoginIndex&&['pending','error','cancelled'].includes(item.status))
  if(next<0)return finishBatchOfficialLogin()
  batchLoginIndex=next
  const status=document.getElementById('batch_login_status')
  if(status)status.innerHTML='<span class="status warn"><i></i>正在准备下一个账号…</span>'
  renderBatchLoginQueue()
  startBatchOfficialLogin()
}
async function finishBatchOfficialLogin(){
  activeLoginUi=null
  const completed=batchLoginQueue.filter(item=>item.status==='success').length
  clearBatchLoginSecrets()
  closeModal()
  await load()
  toast(`批量登录完成，成功导入 ${completed} 个账号`)
}
function loginStatusContent(d){
  const state=d.status==='waiting'?'warn':d.status==='success'?'':'off'
  const link=typeof d.verificationUrl==='string'&&d.verificationUrl.startsWith('https://')?`<a class="btn btn-sm btn-primary" href="${esc(d.verificationUrl)}" target="_blank" rel="noopener noreferrer">打开验证页（请确认私密模式）</a>`:''
  const code=d.userCode?`<code style="font-size:15px;font-weight:700;letter-spacing:1px">${esc(d.userCode)}</code><button class="btn btn-sm" data-admin-onclick="copyDeviceCode('${esc(d.userCode)}')">复制验证码</button>`:''
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
  const poolTier=document.getElementById('login_pool_tier')?.value||'stable'
  const status=document.getElementById('login_status')
  status.innerHTML=`<span class="status warn"><i></i>正在启动 OpenAI 官方登录页面…</span>`
  activeLoginUi='single'
  try{
    const r=await fetch(API+'/chatgpt-login/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label,email:label,routingEnabled,poolTier})}),d=await r.json()
    if(activeLoginUi!=='single'){
      if(r.ok)fetch(API+'/chatgpt-login/cancel',{method:'POST'}).catch(()=>{})
      return
    }
    if(!r.ok)throw new Error(d.error?.message||'无法启动登录')
    status.innerHTML=loginStatusContent(d)
    loginPoll=setInterval(checkOfficialLogin,1200)
  }catch(e){if(activeLoginUi==='single')activeLoginUi=null;status.innerHTML=`<span class="status off"><i></i>${esc(e.message)}</span>`;toast(e.message,'error')}
}
async function checkOfficialLogin(){
  try{
    const r=await fetch(API+'/chatgpt-login/status'),d=await r.json(),status=document.getElementById('login_status')
    if(!status)return
    const decision=AdminUIBehaviors.loginPollDecision(d.status)
    if(!decision.terminal){status.innerHTML=loginStatusContent(d);return}
    activeLoginUi=null
    clearInterval(loginPoll);loginPoll=null
    if(decision.outcome==='success'){status.innerHTML=`<span class="status"><i></i>${esc(d.message)}</span>`;toast(d.message);setTimeout(async()=>{closeModal();await load()},700)}
    else{status.innerHTML=`<span class="status off"><i></i>${esc(d.message||'登录未完成')}</span>`;toast(d.message||'登录未完成','error')}
  }catch(e){activeLoginUi=null;clearInterval(loginPoll);loginPoll=null;toast(e.message,'error')}
}
async function cancelOfficialLogin(){activeLoginUi=null;await fetch(API+'/chatgpt-login/cancel',{method:'POST'});if(loginPoll)clearInterval(loginPoll);loginPoll=null;const status=document.getElementById('login_status');if(status)status.innerHTML='<span class="status off"><i></i>登录已取消</span>'}
async function saveAccount(){
  const content=document.getElementById('account_json').value.trim(),label=document.getElementById('account_label').value.trim(),routingEnabled=document.getElementById('account_routing_enabled')?.checked===true
  const poolTier=String(document.getElementById('account_pool_tier')?.value||'')
  const payloads=accountImportFiles.length?accountImportFiles:(content?[{name:accountImportFileName,content}]:[])
  if(!payloads.length)return toast('请粘贴或选择账号文件','error')
  try{
    let imported=0,skipped=0,rejected=0,temporary=0,refreshable=0,incompatible=0,stable=0,disposable=0
    const errors=[]
    for(const payload of payloads){
      const r=await fetch(API+'/chatgpt-accounts/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:payload.content,label:payloads.length===1?label:'',routingEnabled,sourceName:payload.name,...(poolTier?{poolTier}:{})})}),d=await r.json()
      if(!r.ok){errors.push(`${payload.name||'手动内容'}：${d.error?.message||'导入失败'}`);continue}
      cfg=d.config
      imported+=Number(d.result?.imported||0);skipped+=Number(d.result?.skipped||0);rejected+=Number(d.result?.rejected||0)
      temporary+=Number(d.result?.temporary||0);refreshable+=Number(d.result?.refreshable||0)
      incompatible+=Number(d.result?.incompatible||0)
      stable+=Number(d.result?.stable||0);disposable+=Number(d.result?.disposable||0)
    }
    if(!imported&&!skipped&&!rejected)throw new Error(errors.join('；')||'没有可导入账号')
    for(const payload of payloads)payload.content=''
    accountImportFiles=[]
    closeModal();render()
    toast(`导入完成：新增 ${imported}（稳定 ${stable} / 日抛 ${disposable}；临时 ${temporary} / 可续约 ${refreshable}${incompatible?` / 不兼容 ${incompatible}`:''}），重复 ${skipped}${rejected?`，无效 ${rejected}`:''}${errors.length?`，${errors.length} 个文件无法解析`:''}`,errors.length||rejected||incompatible?'error':'')
  }catch(e){toast(e.message,'error')}
}
async function removeAccount(id){const account=(cfg.chatgptAccounts||[]).find(item=>item.id===id);const name=account?.label||account?.email||'未命名账号',shortId=String(account?.account_id||id).slice(0,12);if(!confirm(`确定移除账号「${name}」吗？\n账号 ID：${shortId}…\n\n删除前会自动创建独立账号备份。`))return;try{const r=await fetch(API+'/chatgpt-accounts/'+encodeURIComponent(id),{method:'DELETE'}),d=await r.json();if(!r.ok)throw new Error(d.error?.message||'移除失败');cfg=d.config;render();toast('账号已移除，删除前数据已备份')}catch(e){toast(e.message,'error')}}
async function refreshAllUsage(){
  toast('正在同步全部账号的用量和重置次数…')
  try{const r=await fetch(API+'/chatgpt-accounts/refresh-usage-all',{method:'POST'}),d=await r.json();if(!r.ok)throw new Error(d.error?.message||'同步失败');cfg=d.config;render();toast(d.message||'用量和重置次数已同步',d.result?.errors?.length?'error':'success')}catch(e){toast(e.message,'error')}
}
async function refreshAccountUsageOne(id){
  toast('正在同步账号用量和重置次数…')
  try{const r=await fetch(API+'/chatgpt-accounts/'+encodeURIComponent(id)+'/refresh-usage',{method:'POST'}),d=await r.json();if(!r.ok)throw new Error(d.error?.message||'同步失败');cfg=d.config;render();toast(d.message||'账号用量和重置次数已同步',d.result?.warnings?.length?'error':'success')}catch(e){toast(e.message,'error')}
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
  showModal('重置 Codex 额度',`<div class="reset-warning"><b>高风险操作 · 消耗 1 次 · 不可撤销</b><p>账号：${esc(name)}<br>当前可用：${count} 次${expiry?`<br>到期（北京时间）：${esc(expiry)}`:''}</p><p>必须依次完成账号名称、风险选项和最终系统确认，才会提交重置。</p></div><div class="field"><label>第一步：输入完整账号名称 <b>${esc(name)}</b></label><input class="input" id="reset_account_confirmation" autocomplete="off" placeholder="输入上方完整账号名称" data-admin-oninput="updateResetQuotaConfirmation('${esc(id)}')"><span class="hint">名称必须完全一致，用于防止选错账号。</span></div><div class="reset-confirmations help-note" style="display:grid;gap:10px;margin-top:15px"><b>第二步：勾选以下两项确认</b><label style="display:flex;align-items:flex-start;gap:9px;cursor:pointer"><input type="checkbox" id="reset_target_confirmation" style="margin-top:2px" data-admin-onchange="updateResetQuotaConfirmation('${esc(id)}')"><span>我确认当前要重置的目标账号是 <strong>${esc(name)}</strong>。</span></label><label style="display:flex;align-items:flex-start;gap:9px;cursor:pointer"><input type="checkbox" id="reset_credit_confirmation" style="margin-top:2px" data-admin-onchange="updateResetQuotaConfirmation('${esc(id)}')"><span>我已知晓此操作会立即消耗 <strong>1 次重置机会</strong>，提交后无法撤销。</span></label></div><p class="reset-final-hint" style="margin:13px 0 0;color:var(--muted);font-size:10px">第三步：点击下方按钮后，系统还会进行最后一次确认。</p>`,'确认并继续',`resetAccountQuota('${esc(id)}')`)
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
  const state=AdminUIBehaviors.quotaResetState({expectedAccount:name,enteredAccount:entered,targetConfirmed,creditConfirmed,submitting:resetQuotaSubmitting})
  AdminUIBehaviors.applyQuotaResetButtonState(submit,state)
  return state.ready
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
  if(!confirm(AdminUIBehaviors.quotaResetFinalMessage(name)))return
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
  const poolTier=['stable','disposable'].includes(account.pool_tier)?account.pool_tier:(account.credential_mode==='temporary_access'?'disposable':'stable')
  const emergencyUntil=Date.parse(account.emergency_continue_until||'')
  const emergencyActive=Number.isFinite(emergencyUntil)&&emergencyUntil>Date.now()
  showModal('账号额度与预留策略',`<div class="form-grid">
    <div class="field full"><label>账号池分级</label><select class="input" id="policy_pool_tier" data-original="${poolTier}" data-admin-onchange="updateAccountPoolTierPolicyForm()"><option value="stable" ${poolTier==='stable'?'selected':''}>稳定保险池</option><option value="disposable" ${poolTier==='disposable'?'selected':''}>日抛优先池</option></select><span class="hint" id="policy_pool_tier_hint"></span></div>
    <div class="field"><label>安全余量 <span class="hint">稳定池账号独立阈值</span></label><input class="input" id="policy_reserve" type="number" min="0" max="100" value="${Number(account.low_quota_threshold??globalReserve)}"></div>
    <div class="field"><label>每日请求上限 <span class="hint">0 为不限</span></label><input class="input" id="policy_requests" type="number" min="0" value="${Number(account.daily_request_limit||0)}"></div>
    <div class="field full"><label>每日 Token 上限 <span class="hint">输入 + 输出，0 为不限</span></label><input class="input" id="policy_tokens" type="number" min="0" value="${Number(account.daily_token_limit||0)}"></div>
    <div class="field full"><label>预留模型 <span class="hint">逗号分隔；设置后普通模型不能使用该账号</span></label><input class="input" id="policy_models" value="${esc((account.reserved_models||[]).join(', '))}" placeholder="gpt-important"></div>
    <div class="field full"><label>预留会话 ID <span class="hint">逗号分隔；匹配 session-id / thread-id</span></label><input class="input" id="policy_sessions" value="${esc((account.reserved_session_ids||[]).join(', '))}" placeholder="重要会话 ID"></div>
    <div class="field full"><div class="help-note"><b style="color:var(--red)">紧急继续使用</b><p>临时绕过安全余量和每日上限，最长 24 小时，到期自动恢复。可能耗尽当前额度，仅在重要任务中使用。</p>${emergencyActive?`<p>当前有效至 ${esc(new Date(emergencyUntil).toLocaleString('zh-CN'))}</p>`:''}</div></div>
    <div class="field"><label>临时持续分钟 <span class="hint">留空保持，0 立即关闭</span></label><input class="input" id="policy_emergency_minutes" type="number" min="0" max="1440" placeholder="例如 60"></div>
    <div class="field"><label style="display:flex;align-items:center;gap:8px"><input id="policy_emergency_confirm" type="checkbox"> 我确认可能耗尽额度</label></div>
  </div>`,'保存策略',`saveAccountPolicy('${esc(id)}')`)
  updateAccountPoolTierPolicyForm()
}
function accountCheckTone(state){
  if(state==='healthy')return ''
  if(['quota_low','quota_exhausted','rate_limited','temporary_unavailable'].includes(state))return 'warn'
  return 'off'
}
function accountCheckResultsHtml(result){
  const accounts=result?.accounts||[]
  const summary=result?.summary||{}
  const summaryText=Object.entries(summary).map(([state,count])=>{
    const sample=accounts.find(item=>item.state===state)
    return `${sample?.label||state} ${count}`
  }).join(' · ')
  const rows=accounts.map(item=>{
    const remaining=item.remaining_percent==null?'额度未知':`剩余 ${Number(item.remaining_percent).toFixed(0)}%`
    const reset=item.reset_credits_synced?'重置次数已同步':'重置次数未同步'
    const status=item.http_status?` · HTTP ${item.http_status}`:''
    return `<div class="provider-row" style="grid-template-columns:minmax(180px,.8fr) minmax(0,1.5fr);align-items:start">
      <div><div class="cell-main">${esc(item.account_label||item.id)}</div><div class="cell-sub">${esc(remaining)} · ${esc(reset)}${esc(status)}</div></div>
      <div><span class="status ${accountCheckTone(item.state)}"><i></i><b>${esc(item.label||item.state)}</b></span><div class="cell-sub" style="margin-top:5px">${esc(item.reason||'没有返回具体原因')}</div></div>
    </div>`
  }).join('')
  return `<div class="help-note"><b>非消耗式状态检查</b><p>只验证凭据、账号用量和重置次数端点，不发送模型请求，因此“基础检查正常”不代表所有模型权限都一定可用。</p><p>${esc(summaryText||'没有账号')}</p></div><div style="display:grid;gap:7px;margin-top:12px;max-height:58vh;overflow:auto">${rows||'<span class="cell-sub">账号池为空</span>'}</div>`
}
async function checkAllAccountStatus(){
  toast('正在逐个检查全部账号状态，请勿重复点击…')
  try{
    const r=await fetch(API+'/chatgpt-accounts/check-all',{method:'POST'}),d=await r.json()
    if(!r.ok)throw new Error(d.error?.message||'账号状态检查失败')
    cfg=d.config
    try{const diagnostics=await fetch(API+'/diagnostics',{cache:'no-store'});if(diagnostics.ok)diagnosticsData=await diagnostics.json()}catch{}
    render()
    showModal('全部账号状态检查',accountCheckResultsHtml(d.result),'完成','closeModal()')
    toast(d.message||'账号状态检查完成',d.result?.issues?'error':'success')
  }catch(e){toast(e.message,'error')}
}
function updateAccountPoolTierPolicyForm(){
  const tier=document.getElementById('policy_pool_tier')?.value
  const reserve=document.getElementById('policy_reserve')
  const hint=document.getElementById('policy_pool_tier_hint')
  if(reserve)reserve.disabled=tier==='disposable'
  if(hint)hint.textContent=tier==='disposable'
    ? '优先于稳定池使用，安全余量固定为 0；周额度归零后 7 天仍未恢复会自动停用。'
    : '仅在没有可用日抛账号时参与路由，并按安全余量保留保险额度。'
}
async function saveAccountPolicy(id){
  const emergencyRaw=String(document.getElementById('policy_emergency_minutes')?.value||'').trim()
  const emergencyMinutes=emergencyRaw===''?null:Math.max(0,Number(emergencyRaw)||0)
  const confirmedEmergencyRisk=document.getElementById('policy_emergency_confirm')?.checked===true
  if(emergencyMinutes>0&&!confirmedEmergencyRisk)return toast('启用紧急继续前必须勾选风险确认','error')
  if(emergencyMinutes>0&&!confirm(`确定临时绕过额度保护 ${emergencyMinutes} 分钟吗？到期后会自动恢复。`))return
  const split=id=>String(document.getElementById(id)?.value||'').split(',').map(value=>value.trim()).filter(Boolean)
  const tierSelect=document.getElementById('policy_pool_tier')
  const selectedTier=String(tierSelect?.value||'')
  const originalTier=String(tierSelect?.dataset.original||'')
  const body={
    ...(selectedTier&&selectedTier!==originalTier?{poolTier:selectedTier}:{}),
    ...(selectedTier==='disposable'?{}:{lowQuotaThreshold:Number(document.getElementById('policy_reserve')?.value)}),
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

function fullConsoleRouteFromManagementRoute(route){
  return ({
    providers:'accounts',
    diagnostics:'settings',
    usage:'analytics'
  })[route]||'overview'
}
function renderManagementBootstrapError(message){
  document.getElementById('nav').innerHTML=''
  document.getElementById('top-title').textContent='统一管理平台'
  document.getElementById('top-subtitle').textContent='需要一级管理员授权'
  document.getElementById('app').innerHTML=`<div class="card"><div class="card-body">${empty('shield','无法打开管理平台',message)}</div></div>`
}
async function bootstrapCentralManagement(){
  const environment=document.getElementById('side-environment')
  if(environment)environment.textContent='Central Gateway · Level-1'
  if(!CENTRAL_MANAGEMENT)return true
  let route='overview'
  try{
    let sessionResponse
    if(browserBootstrapHash){
      const values=new URLSearchParams(browserBootstrapHash.slice('#browser?'.length))
      if([...values.keys()].some(key=>key!=='ticket'&&key!=='route'))throw new Error('管理页面链接无效')
      const ticket=values.get('ticket'),requestedRoute=values.get('route')
      if(!ticket||ticket.length<16||!requestedRoute)throw new Error('管理页面票据无效或已过期')
      route=fullConsoleRouteFromManagementRoute(requestedRoute)
      history.replaceState(null,'',`${location.pathname}#${route}`)
      sessionResponse=await fetch('/api/v1/webview/session',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({ticket})
      })
    }else{
      sessionResponse=await fetch(API+'/session',{cache:'no-store'})
    }
    const session=await sessionResponse.json().catch(()=>({}))
    if(!sessionResponse.ok)throw new Error(session.error?.message||'管理会话无效或已过期')
    if(session.account?.role!=='level1')throw new Error('浏览器完整管理平台仅对一级管理员开放')
    activePage=route
    return true
  }catch(error){
    history.replaceState(null,'',location.pathname)
    renderManagementBootstrapError(error.message||'管理会话建立失败，请从 AI Editor 账户菜单重新打开')
    return false
  }
}
async function startFullConsole(){
  document.getElementById('refreshButton').innerHTML=svg('refresh')
  document.getElementById('menuButton').innerHTML=svg('overview')
  initTheme()
  document.documentElement.dataset.managementMode=CENTRAL_MANAGEMENT?'gateway':'standalone'
  if(!await bootstrapCentralManagement())return
  switchPage(activePage)
  await load()
}
window.addEventListener('hashchange',()=>{
  const page=location.hash.slice(1)
  if(FULL_CONSOLE_PAGES.has(page))switchPage(page)
})
void startFullConsole()
