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

const AdminAnalyticsUI=Object.freeze({render:renderAnalytics})
