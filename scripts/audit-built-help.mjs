import { chromium, expect } from "@playwright/test";
import { writeFileSync, readFileSync } from "node:fs";
import pg from "pg";
const base="http://localhost:3300";
const browser=await chromium.launch({headless:true});
const results=[];
async function login(page,email){await page.goto(base+"/login");await page.getByLabel("Email or username").fill(email);await page.getByLabel("Password",{exact:true}).fill("Test-password-123");await page.getByRole("button",{name:"Sign in",exact:true}).click();await page.waitForURL("**/dashboard");}
try{
 const context=await browser.newContext();const p=await context.newPage();
 await login(p,"audit.trainer");await p.goto(base+"/settings?tab=help");await p.getByRole("link",{name:/Open Help & User Guide/}).click();await expect(p.getByLabel("Search help articles")).toBeVisible();
 results.push({name:"Production build: Super Admin opens help through Administration",status:"passed"});
 await p.getByLabel("Search help articles").fill("insufficient stock");await expect(p.getByRole("heading",{name:"Troubleshooting",exact:true,level:3})).toBeVisible();results.push({name:"Production build: searchable help",status:"passed"});
 for(const format of ["pdf","quick","docx"]){const r=await context.request.get(`${base}/api/help/manual?format=${format}`);const bytes=await r.body();expect(r.status()).toBe(200);expect(bytes.subarray(0,format==="docx"?2:4).toString()).toBe(format==="docx"?"PK":"%PDF");expect(r.headers()['cache-control']).toBe('private, no-store');results.push({name:`Production build: ${format} manual download`,status:"passed",bytes:bytes.length});}
 const training=JSON.parse(readFileSync('docs/audit/evidence/training/reconciliation.json','utf8'));
 for(const [type,key] of [['purchase_order','po'],['client_po','cpo'],['sales_order','so'],['ra_bill','ra'],['client_invoice','invoice'],['supplier_bill','bill']]){const pdf=await context.request.get(`${base}/api/documents/pdf?type=${type}&id=${training.ids[key]}`);expect(pdf.status()).toBe(200);expect((await pdf.body()).subarray(0,4).toString()).toBe('%PDF');results.push({name:`Standalone saved-document PDF: ${type}`,status:'passed'});}
 const logo=await context.request.get(base+"/_next/image?url=%2Flogo1.png&w=1200&q=75");expect(logo.status()).toBe(200);expect(logo.headers()['content-type']).toMatch(/^image\//);results.push({name:"Standalone build: company logo optimization with native image libraries",status:"passed"});
 const bad=await context.request.get(base+"/api/help/manual?format=..%2F..%2F.env");expect(bad.status()).toBe(400);results.push({name:"Production build: invalid manual format cannot select a file path",status:"passed"});
 const c=new pg.Client({connectionString:"postgresql://audit:audit_local_only@localhost:5544/watcon_audit_test"});await c.connect();const row=(await c.query("SELECT u.email FROM users u JOIN roles r ON r.id=u.role_id WHERE r.key='USER' LIMIT 1")).rows[0];await c.end();
 const restricted=await browser.newContext();const rp=await restricted.newPage();await login(rp,row.email);await rp.goto(base+"/help");await expect(rp.getByRole('heading',{name:'Page not found',exact:true})).toBeVisible();expect((await restricted.request.get(base+"/api/help/manual")).status()).toBe(404);results.push({name:"Production build: employee help and manual restricted by owner policy",status:"passed"});
 const anonymous=await browser.newContext();expect((await anonymous.request.get(base+"/api/help/manual")).status()).toBe(401);results.push({name:"Production build: anonymous manual denied",status:"passed"});
}catch(e){results.push({name:"Production build help validation",status:"failed",error:String(e)});process.exitCode=1;console.error(String(e));}finally{writeFileSync('docs/audit/evidence/built-help.json',JSON.stringify({results},null,2));await browser.close();}

