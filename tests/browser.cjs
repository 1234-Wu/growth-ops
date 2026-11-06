/* Optional browser verification using an already installed Playwright + Chrome.
 * Starts an isolated server/database; never touches the actual workspace data. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'growth-browser-'));
  const artifacts = path.join(__dirname, 'artifacts'); fs.mkdirSync(artifacts, {recursive:true});
  const port = await new Promise((resolve,reject) => {const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
  const base = `http://127.0.0.1:${port}`;
  const token = 'isolated-browser-verification';
  const child = spawn(process.env.PYTHON || 'python3', ['server.py','--port',String(port)], {cwd:root,env:{...process.env,GROWTH_DATA_DIR:dir,GROWTH_API_KEY:token,GROWTH_SEED:'1'},stdio:['ignore','pipe','pipe']});
  let serverLog='';child.stderr.on('data',b=>serverLog+=b.toString());
  let browser;
  const request = async (resource, method='GET', body) => {
    const response=await fetch(base+'/api/v1/'+resource,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:body?JSON.stringify(body):undefined});
    const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;
  };
  try {
    for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{} if(child.exitCode!==null)throw Error(serverLog);await new Promise(r=>setTimeout(r,100));}
    browser = await chromium.launch({channel:'chrome',headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/dashboard');
    await page.getByLabel('API Key',{exact:true}).fill('incorrect-test-key');
    await page.getByRole('button',{name:'进入工作台',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'密钥不正确'}).waitFor();
    assert.equal(await page.locator('nav').count(),0);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('growthOpsApiKey')),null);
    await page.getByLabel('API Key',{exact:true}).fill(token);
    await page.getByRole('button',{name:'进入工作台',exact:true}).click();
    await page.getByRole('heading',{name:'仪表盘',exact:true}).waitFor();
    await page.locator('.metric-tile').first().waitFor();
    assert.equal(await page.locator('body').innerText().then(t=>t.includes('[object Object]')),false);
    const go=async(route)=>{const link=page.locator(`nav a[href="/${route}"]`);const heading=(await link.innerText()).trim();await link.click();await page.waitForURL('**/'+route);await page.getByRole('heading',{name:heading,exact:true}).waitFor();await page.waitForLoadState('networkidle');};
    const create=async(resource,fields)=>{
      await go(resource);
      await page.locator('input[name="title"]').fill(fields.title);
      for(const [name,value] of Object.entries(fields)){if(name==='title')continue;const input=page.locator(`[name="${name}"]`);if(await input.evaluate(e=>e.tagName)==='SELECT')await input.selectOption(value);else await input.fill(value);}
      const promise=page.waitForResponse(r=>r.url()===base+'/api/v1/'+resource&&r.request().method()==='POST');
      await page.getByRole('button',{name:'创建',exact:true}).click();
      const response=await promise;const payload=await response.json();assert.equal(response.status(),201,JSON.stringify({response:payload,request:response.request().postDataJSON()}));
      await page.waitForLoadState('networkidle');
      return payload.item;
    };
    const account='account-example-x';
    const product=await create('products',{title:'浏览器验收产品'});
    const strategy=await create('strategies',{title:'浏览器验收策略',account_id:account,body:'先验证一个具体用户问题，保留证据。'});
    await page.locator('input[name="title"]').fill('浏览器验收策略 · 修订');
    let savedPromise=page.waitForResponse(r=>r.url().endsWith('/strategies/'+strategy.id)&&r.request().method()==='PATCH');
    await page.getByRole('button',{name:'保存',exact:true}).click();
    let saved=await savedPromise;assert.equal(saved.status(),200,await saved.text());
    assert.equal((await request('strategies/'+strategy.id)).item.version,2);
    assert.equal((await request('strategies/'+strategy.id+'/history')).items.length,2);
    const task=await create('tasks',{title:'浏览器验收任务',account_id:account,acceptance_criteria:'记录一条真实动作及观察计划'});
    const action=await create('actions',{title:'浏览器验收动作',account_id:account,task_id:task.id,strategy_id:strategy.id,action_type:'research'});
    const metric=await create('metrics',{title:'零值快照',account_id:account,metric_name:'views',value:'0',availability:'valid',metric_type:'cumulative',observed_at:'2026-09-08T16:30',action_id:action.id,source:'browser_test'});
    assert.equal(metric.data.value,0);assert.match(metric.data.observed_at,/Z$/);
    assert.equal(await page.locator('[name="value"]').inputValue(),'0');
    await page.locator('input[name="title"]').fill('零值快照 · 更正说明');
    savedPromise=page.waitForResponse(r=>r.url().endsWith('/metrics/'+metric.id)&&r.request().method()==='PATCH');
    await page.getByRole('button',{name:'保存',exact:true}).click();
    saved=await savedPromise;assert.equal(saved.status(),200,await saved.text());
    assert.equal((await request('metrics/'+metric.id)).item.data.value,0);
    await create('reviews',{title:'浏览器验收复盘',account_id:account,action_id:action.id,facts:'观测值为零',hypothesis:'样本不足，不能判断内容无效',evidence:metric.id,next_steps:'继续观察并记录后续快照'});
    await create('observations',{title:'浏览器验收监测',account_id:account,action_id:action.id,due_at:'2026-09-09T16:30'});
    const context=await request('accounts/'+account+'/context');assert.ok(context.actions.some(x=>x.id===action.id));assert.equal(context.reviews.length,1);
    for(const route of ['dashboard','tasks','actions','contents','observations','metrics','strategies','reviews','knowledge','skills','accounts','products','platforms','reconciliation','settings']){await go(route);assert.ok(!(await page.locator('body').innerText()).includes('[object Object]'));}
    const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'导出 JSON',exact:true}).click();const download=await downloadPromise;const exportPath=path.join(dir,'export.json');await download.saveAs(exportPath);const exported=JSON.parse(fs.readFileSync(exportPath));assert.equal(exported.schema_version,1);assert.ok(exported.records.some(x=>x.id===action.id));assert.ok(exported.versions.length>=2);
    await go('dashboard');await page.screenshot({animations:'disabled',path:path.join(artifacts,'dashboard-desktop.png'),fullPage:true});
    await page.locator(`a.compact-item[data-record-id="${action.id}"]`).click();
    await page.waitForURL('**/actions');
    await page.waitForFunction(title=>document.querySelector('input[name="title"]')?.value===title,action.title);
    await go('tasks');
    await page.locator('input[name="title"]').fill('未保存草稿保留验证');
    await page.locator('[name="acceptance_criteria"]').fill('搜索重绘后仍保留这段文字');
    const searchResponse=page.waitForResponse(r=>r.url().includes('/api/v1/tasks?')&&r.url().includes('q='));
    await page.getByRole('searchbox').fill('浏览器');await searchResponse;
    await page.waitForFunction(()=>document.activeElement?.getAttribute('type')==='search');
    assert.equal(await page.locator('input[name="title"]').inputValue(),'未保存草稿保留验证');
    assert.equal(await page.locator('[name="acceptance_criteria"]').inputValue(),'搜索重绘后仍保留这段文字');
    await go('actions');await page.screenshot({animations:'disabled',path:path.join(artifacts,'actions-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});await page.reload();await page.waitForLoadState('networkidle');
    const width=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));assert.ok(width.scroll<=width.client+2,JSON.stringify(width));
    await page.screenshot({animations:'disabled',path:path.join(artifacts,'actions-mobile.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    // A rejected credential after a valid login must return to the login screen.
    await page.route('**/api/v1/**',route=>route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:{code:'unauthorized',message:'Missing or invalid bearer token'}})}));
    await page.reload();
    await page.getByRole('alert').filter({hasText:'密钥不正确'}).waitFor();
    assert.equal(await page.locator('nav').count(),0);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('growthOpsApiKey')),null);
    const summary={result:'PASS',checks:['invalid_key_stays_on_login','expired_key_clears_login','real_login','15_independent_routes','create_product_strategy_task_action_metric_review_observation','numeric_patch_version','strategy_history','zero_metric_roundtrip','context_links','full_export_with_history','dashboard_record_drilldown','draft_and_focus_survive_search','mobile_no_overflow','no_browser_errors'],artifacts:'tests/artifacts',testData:'isolated temporary database, removed after test'};
    fs.writeFileSync(path.join(artifacts,'browser-results.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
  } finally {
    if(browser)await browser.close();
    child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));
    fs.rmSync(dir,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e.stack);process.exitCode=1});
