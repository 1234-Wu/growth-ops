/* v1.1 UI verification against a fresh, isolated real server. */
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const net=require('node:net');const {spawn}=require('node:child_process');const {chromium}=require('playwright');
(async()=>{
 const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'growth-reliability-'));
 const artifacts=path.join(__dirname,'artifacts');fs.mkdirSync(artifacts,{recursive:true});
 const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n))})});
 const base=`http://127.0.0.1:${port}`,token='isolated-reliability-check';
 const server=spawn(process.env.PYTHON||'python3',['server.py','--port',String(port)],{cwd:root,env:{...process.env,GROWTH_DATA_DIR:dir,GROWTH_API_KEY:token,GROWTH_SEED:'1'},stdio:['ignore','ignore','pipe']});
 let log='',browser;server.stderr.on('data',b=>log+=b.toString());
 const api=async(p,method='GET',body)=>{const r=await fetch(base+'/api/v1/'+p,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:body?JSON.stringify(body):undefined});const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value};
 try{
  for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break}catch{}if(server.exitCode!==null)throw Error(log);await new Promise(r=>setTimeout(r,100))}
  const account='account-example-x';
  const strategy=(await api('strategies','POST',{title:'核验策略 · v1',account_id:account,data:{body:'原始执行依据'}})).item;
  const task=(await api('tasks','POST',{title:'逾期任务验收',account_id:account,status:'planned',data:{due_at:'2000-01-01T00:00:00Z'}})).item;
  const action=(await api('actions','POST',{title:'核验发布验收',account_id:account,status:'completed',data:{action_type:'publish',occurred_at:'2026-09-01T09:00:00+08:00',external_id:'fixture-post',evidence_url:'https://example.test/fixture-post',verification_status:'pending',task_id:task.id,strategy_id:strategy.id,review_due_at:'2000-01-01T00:00:00Z'}})).item;
  await api('strategies/'+strategy.id,'PATCH',{version:strategy.version,title:'核验策略 · v2',data:{body:'后续修订，不覆盖旧动作'}});
  const obs=(await api('observations','POST',{title:'逾期监测验收',account_id:account,status:'pending',data:{action_id:action.id,due_at:'2000-01-01T00:00:00Z'}})).item;
  await api('metrics','POST',{title:'指标验收',account_id:account,data:{action_id:action.id,metric_name:'views',metric_type:'cumulative',availability:'valid',value:0,observed_at:'2026-09-02T00:00:00Z',source:'fixture'}});
  const before=await api('reconciliation?account_id='+account);
  assert.ok(before.items.some(x=>x.kind==='unverified_action'&&x.record_id===action.id));
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/reconciliation');await page.getByLabel('API Key',{exact:true}).fill(token);await page.getByRole('button',{name:'进入工作台',exact:true}).click();
  await page.getByRole('heading',{name:'执行对账',exact:true}).waitFor();await page.waitForLoadState('networkidle');
  assert.ok((await page.locator('main').innerText()).includes('核验发布验收'));
  await page.screenshot({animations:'disabled',path:path.join(artifacts,'reconciliation-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('.reconciliation-table tbody tr').first().locator('td').nth(4).evaluate(e=>getComputedStyle(e).display),'table-cell');
  await page.screenshot({animations:'disabled',path:path.join(artifacts,'reconciliation-mobile-issues.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('nav a[href="/actions"]').click();await page.getByRole('heading',{name:'运营动作',exact:true}).waitFor();
  await page.getByRole('row').filter({hasText:'核验发布验收'}).click();
  await page.waitForFunction(()=>document.querySelector('[name="title"]')?.value==='核验发布验收');
  await page.locator('[name="verification_status"]').selectOption('verified');
  await page.locator('[name="verified_at"]').fill('2026-09-08T16:00');
  await page.locator('[name="verification_evidence"]').fill('隔离验收：回查内容与外部ID一致');
  const save=page.waitForResponse(r=>r.url().endsWith('/actions/'+action.id)&&r.request().method()==='PATCH');
  await page.getByRole('button',{name:'保存',exact:true}).click();const saved=await save;assert.equal(saved.status(),200,await saved.text());
  const verified=(await api('actions/'+action.id)).item;assert.equal(verified.data.verification_status,'verified');
  const after=await api('reconciliation?account_id='+account);assert.ok(!after.items.some(x=>x.kind==='unverified_action'&&x.record_id===action.id));
  const context=await api('actions/'+action.id+'/context');assert.equal(context.strategy_resolution,'exact');assert.equal(context.strategy.version,1);assert.equal(context.strategy.data.body,'原始执行依据');assert.equal(context.collections.metrics.total,1);
  await page.getByRole('button',{name:'动作上下文',exact:true}).click();
  await page.getByText('原始执行依据',{exact:false}).first().waitFor();
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({animations:'disabled',path:path.join(artifacts,'action-context-desktop.png'),fullPage:true});
  // Use actual business-time filters through the visible controls.
  const controls=page.locator('[name="time_field"]');await controls.selectOption('occurred_at');
  await page.locator('[name="date_from"]').fill('2020-01-01T00:00');await page.locator('[name="date_to"]').fill('2020-01-02T00:00');
  const filtered=page.waitForResponse(r=>r.url().includes('/api/v1/actions?')&&r.url().includes('time_field=occurred_at'));
  await page.getByRole('button',{name:'应用筛选',exact:true}).click();const filteredResponse=await filtered;const empty=await filteredResponse.json();assert.equal(empty.total,0);
  await api('reviews','POST',{title:'已完成复盘',account_id:account,status:'active',data:{action_id:action.id,facts:'真实测试事实',period_start:'2026-09-01T00:00:00Z',period_end:'2026-09-03T00:00:00Z'}});
  await api('observations/'+obs.id,'PATCH',{version:obs.version,status:'completed'});
  await api('tasks/'+task.id,'PATCH',{version:task.version,status:'completed'});
  const closed=await api('reconciliation?account_id='+account);assert.equal(closed.total,0);
  await page.locator('nav a[href="/reconciliation"]').click();await page.getByRole('heading',{name:'执行对账',exact:true}).waitFor();await page.waitForLoadState('networkidle');
  await page.setViewportSize({width:390,height:844});await page.reload();await page.waitForLoadState('networkidle');
  const widths=await page.evaluate(()=>[document.documentElement.scrollWidth,document.documentElement.clientWidth]);assert.ok(widths[0]<=widths[1]+2,JSON.stringify(widths));
  await page.screenshot({animations:'disabled',path:path.join(artifacts,'reconciliation-mobile.png'),fullPage:true});assert.deepEqual(errors,[]);
  const result={result:'PASS',checks:['reconciliation_page_and_source_records','real_verification_update_clears_issue','pinned_strategy_context','visible_business_time_filter','complete_loop_clears_all_issues','mobile_no_overflow','no_browser_errors'],data:'isolated temporary database, deleted after test'};
  fs.writeFileSync(path.join(artifacts,'reliability-browser-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 }finally{if(browser)await browser.close();server.kill('SIGTERM');await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));fs.rmSync(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
