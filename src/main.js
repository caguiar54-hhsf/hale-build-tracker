import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./style.css";
import { supabase } from "./supabase.js";

const $ = s => document.querySelector(s);
/* IBM Plex draws the ʻokina (U+02BB) with wide spacing; show the tighter ‘ instead. Stored text is unchanged. */
const okina = t => t.replace(/\u02BB/g, "\u2018");
const esc = s => okina(String(s ?? "")).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money = n => { n = Number(n)||0; const cents = Math.abs(Math.round(n*100)) % 100 !== 0; return n.toLocaleString("en-US",{style:"currency",currency:"USD",minimumFractionDigits:cents?2:0,maximumFractionDigits:cents?2:0}); };
const fmtDate = d => { if(!d) return ""; const t = new Date(d+"T12:00:00"); return isNaN(t) ? d : t.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}); };
const today = () => { const t=new Date(); t.setMinutes(t.getMinutes()-t.getTimezoneOffset()); return t.toISOString().slice(0,10); };

const S = { project:{}, phases:[], costs:[], log:[], contacts:[], selections:[], allowances:{},
  changes:[], draws:[], punch:[], documents:[], questions:[], vendors:[], loaded:false };
let readOnly = false;
const selFilter = { room:"all", cat:"all", phase:"all", group:"room" };
/* Best-guess phase for a selection type, matched on phase titles so it still works if phases are renamed */
const SEL_PHASE_HINT = {"Lighting":/fixture|applian/i, "Plumbing fixtures":/fixture|applian/i, "Appliances":/applian|fixture/i,
  "Cabinets":/finish|cabinet/i, "Countertops":/finish|counter|cabinet/i, "Flooring":/finish|floor/i, "Tile":/finish|tile|floor/i, "Hardware":/finish|fixture/i,
  "Paint & finishes":/finish|paint/i, "Doors & windows":/window|door/i, "Exterior & lanai":/siding|exterior|lanai|roof/i};
function guessPhase(cat){ const re = SEL_PHASE_HINT[cat]; const p = re && S.phases.find(x=>re.test(x.title)); return p ? p.id : ""; }
const phaseOf = s => s.phaseId && S.phases.find(p=>p.id===s.phaseId);
const ui = { punchList:"punch", qFilter:"open", docCat:"all", tlRange:"upcoming", spendBy:"category", costShow:"all", costCat:"all", costPhase:"all", vendTrade:"all" };
const CO_ST = {proposed:"Proposed", approved:"Approved", rejected:"Rejected"};
const CO_CLASS = {proposed:"active", approved:"done", rejected:"failed"};
const DRAW_ST = {upcoming:"Upcoming", requested:"Requested", inspected:"Lender inspected", funded:"Funded"};
const DRAW_CLASS = {upcoming:"", requested:"active", inspected:"active", funded:"done"};
const PUNCH_ST = {open:"Open", fixed:"Fixed", verified:"Verified"};
const PUNCH_CLASS = {open:"active", fixed:"scheduled", verified:"done"};
const DOC_CATS = ["Permit","Plans & drawings","Contract","Change order","Lien release","Invoice / receipt","Inspection report","Warranty / manual","Insurance","Loan","Photo","Other"];
const slug = s => String(s||"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,80) || "unnamed";
const CATS = ["Lighting","Cabinets","Countertops","Flooring","Plumbing fixtures","Appliances","Tile","Hardware","Doors & windows","Paint & finishes","Exterior & lanai","Other"];
const ROOMS = ["Kitchen","Living room","Dining","Primary bedroom","Bedroom","Bathroom","Primary bath","Laundry","Lanai","Garage","Exterior","Whole house"];
const SEL_ST = {considering:"Considering", chosen:"Chosen", ordered:"Ordered", delivered:"Delivered", installed:"Installed"};
const SEL_CLASS = {considering:"", chosen:"done", ordered:"active", delivered:"done", installed:"done"};
const COMMITTED = new Set(["chosen","ordered","delivered","installed"]);
const isAsset = id => typeof id==="string" && /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpe?g|png|webp|gif|pdf)$/i.test(id);
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const blob = id => urlCache.get(id)?.url || PIXEL;
const safeUrl = u => /^https?:\/\/[^\s"'<>]+$/i.test(String(u||"").trim()) ? String(u).trim() : "";
const selTotal = s => (+s.price||0) * (s.qty===null||s.qty===undefined||s.qty==="" ? 1 : +s.qty||0);

const STATUS = {todo:"Not started", active:"In progress", done:"Done"};
const INSP = {none:"No inspection", scheduled:"Scheduled", passed:"Passed", failed:"Failed"};
const COST_ST = {estimate:"Quote / estimate", committed:"Contracted or ordered", paid:"Paid in full"};
const COST_CATS = ["Labor","Materials","Subcontractor","Permits & fees","Professional services","Equipment & rentals","Utilities & hookups","Appliances & fixtures","Insurance & loan costs","Other"];
const PAY_METHODS = ["Check","Bank transfer","Credit card","Cash","Other"];
/* Where a payment's money came from: "own" (their own money), "draw:<id>" (a construction-loan draw).
   Older payments may only say method "Loan draw" (loan, draw not chosen) or nothing at all (not specified). */
function srcOf(p){
  if(p.source==="own") return {type:"own"};
  if(typeof p.source==="string" && p.source.startsWith("draw:")){ const id = p.source.slice(5); return S.draws.some(d=>d.id===id) ? {type:"draw", id} : {type:"loan"}; }
  if(p.method==="Loan draw") return {type:"loan"};
  return {type:"unset"};
}
const VENDOR_TRADES = ["General contractor","Excavation & grading","Concrete & foundation","Framing","Roofing","Electrical","Plumbing","Septic / wastewater","HVAC & solar","Windows & doors","Insulation & drywall","Painting","Flooring & tile","Cabinets & countertops","Landscaping","Architect / designer","Engineer","Surveyor","Building supplier","Equipment rental","Other"];
/* A vendor record's id may be a slug of its name (created from a cost) or a random id (added by hand);
   costs are matched to vendor records by name either way. */
function vendorKey(name){ const k = slug(name); const v = S.vendors.find(x => x.id===k || slug(x.name)===k); return v ? v.id : k; }
function insState(v){
  if(!v?.insuranceExp) return null; const d = daysTo(v.insuranceExp);
  if(d < 0) return ["failed", `Insurance expired ${fmtDate(v.insuranceExp)}`];
  if(d <= 30) return ["scheduled", `Insurance expires in ${d} day${d===1?"":"s"}`];
  return ["done", `Insured until ${fmtDate(v.insuranceExp)}`];
}
const drawLabel = d => `Draw ${d.number??""}${d.milestone?` · ${d.milestone}`:""}`;
function srcLabel(p){ const s = srcOf(p); if(s.type==="own") return "Own money"; if(s.type==="draw"){ const d = S.draws.find(x=>x.id===s.id); return d ? drawLabel(d) : "Loan"; } if(s.type==="loan") return "Loan (draw not chosen)"; return "Source not set"; }
function drawSpend(){
  const map = {}; S.draws.forEach(d => map[d.id] = {spent:0, items:[]});
  S.costs.forEach(c => payList(c).forEach(p => { const s = srcOf(p); if(s.type==="draw"){ map[s.id].spent += +p.amount||0; map[s.id].items.push({c,p}); } }));
  return map;
}
function fundingSplit(){
  let loan=0, own=0, unset=0, nUnset=0;
  S.costs.forEach(c => payList(c).forEach(p => { const a = +p.amount||0; const s = srcOf(p);
    if(s.type==="draw"||s.type==="loan") loan += a; else if(s.type==="own") own += a; else { unset += a; nUnset++; } }));
  return {loan, own, unset, nUnset};
}
function defaultSource(){
  const sp = drawSpend();
  const open = S.draws.filter(d => d.status==="funded" && (+d.amount||0) - sp[d.id].spent > 0.004);
  return open.length ? "draw:" + open[open.length-1].id : "own";
}
function sourceOptions(sel){
  const opts = [["own","Own money"], ...S.draws.map(d => ["draw:"+d.id, drawLabel(d) + (d.status==="funded" ? "" : ` (${(DRAW_ST[d.status]||"").toLowerCase()})`)])];
  if(sel && !opts.some(o=>o[0]===sel)) opts.unshift([sel, sel==="loan" ? "Loan (draw not chosen)" : "Source not set"]);
  return opts.map(([v,l]) => `<option value="${esc(v)}" ${v===sel?"selected":""}>${esc(l)}</option>`).join("");
}
const srcValue = p => { const s = srcOf(p); return s.type==="own" ? "own" : s.type==="draw" ? "draw:"+s.id : s.type; };
const STATE = {quote:["Quote",""], committed:["Not paid yet","active"], partial:["Partly paid","active"], held:["Retainage held","held"], paid:["Paid","done"]};
const catOf = c => c.category || "Uncategorized";

/* ---------- small UI helpers (data layer is at the bottom of this file) ---------- */
function setRO(v){ readOnly = v; document.body.classList.toggle("ro", v); }
function showNotice(t){ const n=$("#notice"); n.textContent=t; n.hidden=false; }
function hideNotice(){ $("#notice").hidden=true; }

/* ---------- derived ---------- */
/* One cost = a contract or purchase. Payments chip away at it; retainage is the part billed but held back.
   paid    = cash actually paid (including retainage releases)
   held    = retainage withheld and not yet released
   balance = still owed overall (amount - paid), which includes held retainage */
function payList(c){
  if(Array.isArray(c.payments) && c.payments.length) return c.payments;
  if(c.status==="paid" && +c.amount) return [{id:"legacy", date:c.date||"", kind:"payment", amount:+c.amount, retained:0, method:"", note:"Marked paid in full", legacy:true, ...(c.paidFrom?{source:c.paidFrom}:{})}];
  return [];
}
function costMath(c){
  const amt = Math.max(0, +c.amount||0);
  const pct = Math.max(0, Math.min(100, +c.retainagePct||0));
  const pays = payList(c);
  const paid = pays.reduce((a,p)=>a+(+p.amount||0),0);
  const held = Math.max(0, pays.reduce((a,p)=>a+(p.kind==="release" ? -(+p.amount||0) : (+p.retained||0)),0));
  const balance = Math.max(0, amt - paid);
  const unbilled = Math.max(0, amt - paid - held);
  const state = paid===0 && held===0 ? (c.status==="estimate" ? "quote" : "committed")
    : paid >= amt - 0.005 ? "paid" : held>0 && unbilled < 0.005 ? "held" : "partial";
  return {amt, pct, paid, held, balance, unbilled, state, pays};
}
function totals(){
  let paid=0, held=0, owed=0, quoted=0, committed=0;
  S.costs.forEach(c=>{ const m = costMath(c); paid += m.paid; held += m.held;
    if(m.state==="quote") quoted += m.balance; else owed += m.balance;
    committed += Math.max(m.amt, m.paid); });
  const budget = +S.project.budget || 0;
  return {paid, held, owed, quoted, est: owed+quoted, budget, committed, left: budget - committed};
}
/* Money per phase. committed = what the phase will cost as things stand (contracts, orders, quotes, or more if overpaid). */
function phaseMoney(){
  const map = {}; const blank = () => ({paid:0, held:0, owed:0, quoted:0, committed:0, n:0});
  S.phases.forEach(p => map[p.id] = blank()); map[""] = blank();
  S.costs.forEach(c => { const k = c.phaseId && map[c.phaseId] ? c.phaseId : ""; const m = costMath(c); const g = map[k];
    g.paid += m.paid; g.held += m.held; g.n++; g.committed += Math.max(m.amt, m.paid);
    if(m.state==="quote") g.quoted += m.balance; else g.owed += Math.max(0, m.balance - m.held); });
  return map;
}
function daysTo(d){ if(!d) return null; return Math.round((new Date(d+"T12:00:00") - new Date(today()+"T12:00:00"))/864e5); }

/* ---------- header ---------- */
function renderHeader(){
  const p = S.project;
  $("#pname").textContent = okina(p.name || "House build");
  $("#paddr").textContent = okina([p.address || "Hilo, Hawaiʻi", p.sqft ? Number(p.sqft).toLocaleString()+" sq ft" : ""].filter(Boolean).join(" · "));
  const done = S.phases.filter(x=>x.status==="done").length, tot = S.phases.length;
  const t = totals(), dd = daysTo(p.targetDate);
  const v = [];
  v.push(`<span>Phases <b>${done}/${tot}</b> done</span>`);
  if(t.budget) v.push(`<span>Paid <b>${money(t.paid)}</b> of <b>${money(t.budget)}</b></span>`);
  else v.push(`<span>Paid <b>${money(t.paid)}</b></span>`);
  if(dd!==null) v.push(`<span>Move-in <b>${dd>=0 ? dd+" days" : Math.abs(dd)+" days past"}</b> ${dd>=0?"to go":"target"}</span>`);
  $("#vitals").innerHTML = v.join("");
  $("#strip").innerHTML = S.phases.map(x=>`<i class="${esc(x.status)}"></i>`).join("");
}

/* ---------- views ---------- */
const GROUPS = {
  home:{views:[["overview","Overview"]]},
  schedule:{views:[["phases","Phases"],["timeline","Timeline"]]},
  money:{views:[["budget","Budget"],["changes","Change orders"],["draws","Loan draws"],["vendors","Vendors"]]},
  selections:{views:[["selections","Selections"]]},
  site:{views:[["log","Site log"],["punch","Punch list"],["questions","Questions"]]},
  files:{views:[["documents","Documents"],["warranties","Warranties"],["contacts","Contacts"],["sharing","Sharing"]]},
};
const VIEW_GROUP = {}; Object.entries(GROUPS).forEach(([g,o])=>o.views.forEach(([v])=>VIEW_GROUP[v]=g));
const lastSub = {};
const VIEW_FN = () => ({overview:vOverview, phases:vPhases, timeline:vTimeline, budget:vBudget, changes:vChanges, draws:vDraws, vendors:vVendors,
  selections:vSelections, log:vLog, punch:vPunch, questions:vQuestions, documents:vDocuments, contacts:vContacts, sharing:vSharing, warranties:vWarranties});
function currentView(){ const h = location.hash.slice(1); return VIEW_GROUP[h] ? h : "overview"; }
function subCount(v){
  if(v==="changes") return S.changes.filter(c=>c.status==="proposed").length;
  if(v==="punch") return S.punch.filter(p=>p.status==="open").length;
  if(v==="questions") return S.questions.filter(q=>q.status!=="answered").length;
  if(v==="draws") return S.draws.filter(d=>d.status==="requested"||d.status==="inspected").length;
  return 0;
}
function render(){
  renderHeader();
  const v = currentView(), g = VIEW_GROUP[v];
  lastSub[g] = v;
  document.querySelectorAll("#tabs a").forEach(a => { const ag = a.dataset.g; a.setAttribute("href", "#"+(lastSub[ag] || GROUPS[ag].views[0][0])); a.setAttribute("aria-current", ag===g ? "page" : "false"); });
  const subs = GROUPS[g].views;
  const subnav = subs.length>1 ? `<nav class="sub" aria-label="Sections">${subs.map(([sv,sl])=>{ const c=subCount(sv); return `<a href="#${sv}" aria-current="${sv===v?"page":"false"}">${sl}${c?`<span class="ct">${c}</span>`:""}</a>`; }).join("")}</nav>` : "";
  $("#view").innerHTML = subnav + VIEW_FN()[v]();
  if(v==="log") fillAuthors();
}
window.addEventListener("hashchange", () => { render(); window.scrollTo(0,0); });

/* upcoming dated events across the whole build */
function events(){
  const ev = [];
  const ph = id => S.phases.find(p=>p.id===id)?.title;
  S.phases.forEach(p=>{
    if(p.start) ev.push({date:p.start, kind:"Start", text:p.title, view:"phases", done:p.status!=="todo"});
    if(p.end) ev.push({date:p.end, kind:"Finish", text:p.title, view:"phases", done:p.status==="done"});
    if(p.inspectionDate && p.inspectionStatus!=="none") ev.push({date:p.inspectionDate, kind:"Inspection", text:(p.inspection||"Inspection")+" · "+p.title, view:"phases", done:p.inspectionStatus==="passed", flag:p.inspectionStatus==="scheduled"});
  });
  S.selections.forEach(s=>{ if(s.orderBy && !["ordered","delivered","installed"].includes(s.status)) ev.push({date:s.orderBy, kind:"Order by", text:s.item+(s.room?` · ${s.room}`:""), view:"selections", flag:true});
    if(s.status==="ordered" && s.deliveryDate) ev.push({date:s.deliveryDate, kind:"Delivery", text:s.item+(s.purchase?.vendor?` · ${s.purchase.vendor}`:""), view:"selections"}); });
  S.draws.forEach(d=>{
    if(d.targetDate && d.status==="upcoming") ev.push({date:d.targetDate, kind:"Draw", text:`Draw ${d.number??""}: ${d.milestone||""}`, view:"draws"});
    if(d.requestedDate && d.status!=="upcoming") ev.push({date:d.requestedDate, kind:"Draw requested", text:`Draw ${d.number??""}: ${d.milestone||""}`, view:"draws", done:d.status==="funded"});
  });
  S.punch.forEach(p=>{ if(p.due && p.status==="open") ev.push({date:p.due, kind:"Punch due", text:p.item, view:"punch", flag:true}); });
  S.costs.forEach(c=>{ const m = costMath(c); if(c.due && m.state!=="quote" && m.balance - m.held > 0) ev.push({date:c.due, kind:"Payment due", text:`${c.item}${c.vendor?` · ${c.vendor}`:""} · ${money(m.balance - m.held)}`, view:"budget", flag:true}); });
  if(S.project.targetDate) ev.push({date:S.project.targetDate, kind:"Target", text:"Move-in", view:"overview"});
  return ev.sort((a,b)=>a.date.localeCompare(b.date));
}

function vOverview(){
  const active = S.phases.filter(p=>p.status==="active");
  const next = S.phases.find(p=>p.status==="todo");
  const coming = events().filter(e => { const d=daysTo(e.date); return d!==null && d>=0 && d<=14 && !e.done; });
  const attention = [];
  const nQ = S.questions.filter(q=>q.status!=="answered").length; if(nQ) attention.push([`${nQ} open question${nQ>1?"s":""} for the contractor`,"questions"]);
  const pCO = S.changes.filter(c=>c.status==="proposed"); if(pCO.length) attention.push([`${pCO.length} change order${pCO.length>1?"s":""} waiting for a decision (${money(pCO.reduce((a,c)=>a+(+c.cost||0),0))})`,"changes"]);
  const costIds = new Set(S.costs.map(c=>c.id));
  const aCO = S.changes.filter(c=>c.status==="approved" && +c.cost && !(c.costId && costIds.has(c.costId))); if(aCO.length) attention.push([`${aCO.length} approved change order${aCO.length>1?"s":""} not in the budget yet`,"changes"]);
  const soonSel = S.selections.filter(s=>orderSoon(s)!==null).length; if(soonSel) attention.push([`${soonSel} selection${soonSel>1?"s":""} to order in the next 2 weeks`,"selections"]);
  const waitDraw = S.draws.filter(d=>d.status==="requested"||d.status==="inspected").length; if(waitDraw) attention.push([`${waitDraw} loan draw${waitDraw>1?"s":""} requested, not funded yet`,"draws"]);
  const dsp = drawSpend();
  S.draws.forEach(d => { const over = dsp[d.id].spent - (+d.amount||0); if(over > 0.004) attention.push([`${drawLabel(d)}: ${money(over)} more paid than the draw amount`,"draws"]);
    else if(dsp[d.id].spent > 0 && d.status!=="funded") attention.push([`${drawLabel(d)}: payments recorded before the draw is funded`,"draws"]); });
  const pmA = phaseMoney(); S.phases.forEach(p => { const over = pmA[p.id].committed - (+p.budget||0); if(+p.budget && over > 0.004) attention.push([`${p.title} is ${money(over)} over its budget`,"phases"]); });
  const insN = S.vendors.filter(v => { const st = insState(v); return st && st[0]==="failed"; }).length; if(insN) attention.push([`${insN} vendor${insN>1?"s'":"'s"} insurance has expired`,"vendors"]);
  const wSoon = S.selections.filter(x=>x.purchase && x.warrantyExp && daysTo(x.warrantyExp)>=0 && daysTo(x.warrantyExp)<=30).length; if(wSoon) attention.push([`${wSoon} warrant${wSoon>1?"ies end":"y ends"} in the next 30 days`,"warranties"]);
  const fs = fundingSplit(); if(fs.nUnset && S.draws.length) attention.push([`${fs.nUnset} payment${fs.nUnset>1?"s don't":" doesn't"} say if it came from the loan or your own money`,"budget"]);
  const nP = S.punch.filter(p=>p.status==="open").length; if(nP) attention.push([`${nP} open punch list item${nP>1?"s":""}`,"punch"]);
  const failed = S.phases.filter(p=>p.inspectionStatus==="failed").length; if(failed) attention.push([`${failed} failed inspection${failed>1?"s":""} to re-schedule`,"phases"]);
  const t = totals();
  const p = S.project;
  const pct = x => t.budget ? Math.min(100, x/t.budget*100) : 0;
  return `
  <div class="grid2">
    <div class="panel">
      <div class="label">Happening now</div>
      ${active.length ? active.map(a=>`<div class="now">${esc(a.title)}</div>`).join("") : `<div class="now">${S.phases.length && S.phases.every(x=>x.status==="done") ? "All phases done" : "Nothing in progress"}</div>`}
      ${next ? `<div style="margin-top:8px;font-size:.93rem"><span class="label">Up next</span>&nbsp; ${esc(next.title)}</div>` : ""}
      <dl class="kv" style="margin-top:14px">
        <dt>Started</dt><dd>${p.startDate ? fmtDate(p.startDate) : "—"}</dd>
        <dt>Target move-in</dt><dd>${p.targetDate ? fmtDate(p.targetDate) : "—"}</dd>
        <dt>Permit no.</dt><dd class="mono">${esc(p.permit) || "—"}</dd>
      </dl>
    </div>
    <div class="panel">
      <h3>Coming up in the next 2 weeks</h3>
      ${coming.length ? `<ul class="plain">${coming.slice(0,6).map(e=>`<li><span class="date">${fmtDate(e.date).replace(/, \d{4}$/,"")}</span><span style="min-width:0"><span class="k label">${esc(e.kind)}</span> ${esc(e.text)}</span></li>`).join("")}</ul>
        ${coming.length>6?`<a class="ext" href="#timeline">See all ${coming.length} on the timeline</a>`:""}`
        : `<p class="empty">Nothing dated in the next two weeks. Inspections, order-by dates, payment due dates and draws show up here once they have dates.</p>`}
    </div>
    <div class="panel">
      <h3>Budget</h3>
      ${t.budget ? `<div class="meter"><div class="paid" style="width:${pct(t.paid)}%"></div><div class="est" style="width:${pct(t.est)}%"></div></div>
      <div class="legend"><span style="--c:var(--good)">Paid ${money(t.paid)}</span><span style="--c:var(--warn)">Owed or quoted ${money(t.est)}</span><span style="--c:var(--line)">Unallocated ${money(Math.max(0,t.left))}</span></div>
      ${t.left<0 ? `<p style="color:var(--bad);font-weight:600;margin:10px 0 0">Over budget by ${money(-t.left)} including quotes.</p>`:""}`
      : `<p class="empty">Paid so far: ${money(t.paid)}. Add a total budget in project details to track what's left.</p>`}
      ${(+p.loanAmount || S.draws.length) ? (()=>{ const f=S.draws.filter(d=>d.status==="funded").reduce((a,d)=>a+(+d.amount||0),0); return `<p style="margin:12px 0 0;font-size:.9rem">Loan draws funded: <b class="num">${money(f)}</b>${+p.loanAmount?` of <b class="num">${money(p.loanAmount)}</b>`:""}</p>`; })() : ""}
    </div>
    <div class="panel">
      <h3>Needs attention</h3>
      ${attention.length ? `<ul class="plain">${attention.map(([txt,v])=>`<li><a class="ext" href="#${v}" style="font-size:.93rem">${esc(txt)}</a></li>`).join("")}</ul>`
        : `<p class="empty">All clear. Open questions, pending change orders, punch items and orders due soon will show up here.</p>`}
    </div>
    <div class="panel full">
      <h3>Latest from the site</h3>
      ${S.log.length ? `<ul class="plain">${S.log.slice(0,4).map(l=>`<li><span class="date">${fmtDate(l.date)}</span><span style="min-width:0;overflow-wrap:anywhere">${esc(trunc(l.text,140))}</span></li>`).join("")}</ul>`
        : `<p class="empty">No site notes yet. Add one from the Site log tab after each visit.</p>`}
    </div>
  </div>`;
}
const trunc = (s,n) => { s=String(s||""); return s.length>n ? s.slice(0,n-1)+"…" : s; };

function selLink(p){ const n = S.selections.filter(x=>x.phaseId===p.id).length; return n ? ` · <a class="ext" href="#selections" data-act="phaseSels" data-id="${esc(p.id)}">${n} selection${n===1?"":"s"}</a>` : ""; }
function phaseMoneyLine(p, g){
  const bud = +p.budget || 0;
  if(!bud && !g.n) return "";
  const over = bud && g.committed > bud + 0.004;
  const scale = Math.max(bud, g.committed, 1);
  const w = x => (x/scale*100).toFixed(2);
  return `<div class="pmoney">
    <div class="meter"><div style="width:${w(g.paid)}%;background:var(--good)"></div><div style="width:${w(g.held)}%;background:var(--held)"></div><div style="width:${w(g.owed+g.quoted)}%;background:var(--warn);opacity:.55"></div>${bud?`<i class="bud" style="left:${w(bud)}%" title="Budget ${money(bud)}"></i>`:""}</div>
    <div class="hint num">${money(g.paid)} paid${g.owed+g.held+g.quoted>0.004?` · ${money(g.owed+g.held+g.quoted)} owed or quoted`:""}${bud?` · budget ${money(bud)}`:""}
      ${over ? ` <span class="pill failed">Over by ${money(g.committed-bud)}</span>` : bud ? ` · <span style="color:var(--good)">${money(bud-g.committed)} left</span>` : ""}
      ${g.n ? ` · <a class="ext" href="#budget" data-act="phaseCosts" data-id="${esc(p.id)}">${g.n} cost${g.n===1?"":"s"}</a>` : ""}${selLink(p)}</div>
  </div>`;
}
function vPhases(){
  const pm = phaseMoney();
  const phaseBud = S.phases.reduce((a,p)=>a+(+p.budget||0),0);
  const projBud = +S.project.budget || 0;
  const committed = S.phases.reduce((a,p)=>a+pm[p.id].committed,0) + pm[""].committed;
  const overN = S.phases.filter(p => +p.budget && pm[p.id].committed > +p.budget + 0.004).length;
  return `
  <div class="viewhead"><h2>Build phases</h2>
    <div style="display:flex;gap:8px">
      ${!S.phases.length ? `<button class="btn write" data-act="template">Load standard Hilo build phases</button>`:""}
      <button class="btn primary write" data-act="addPhase">Add phase</button>
    </div></div>
  ${S.phases.length && (phaseBud || committed) ? `<div class="tiles">
    <div class="tile"><div class="label">Phase budgets</div><div class="v num">${phaseBud?money(phaseBud):"—"}</div><div class="hint">${!phaseBud ? "Tap Edit on a phase to set one" : projBud ? (Math.abs(phaseBud-projBud)<0.5 ? "Matches the total budget" : phaseBud>projBud ? `${money(phaseBud-projBud)} more than the total budget` : `${money(projBud-phaseBud)} of the total budget not assigned`) : "Total budget not set"}</div></div>
    <div class="tile"><div class="label">Paid on phases</div><div class="v num">${money(S.phases.reduce((a,p)=>a+pm[p.id].paid,0))}</div><div class="hint">${pm[""].n?`Plus ${money(pm[""].paid)} on costs with no phase`:"All costs have a phase"}</div></div>
    <div class="tile"><div class="label">Phases over budget</div><div class="v num" style="color:${overN?"var(--bad)":"inherit"}">${overN}</div><div class="hint">${overN?"Counting contracts and quotes":"None so far"}</div></div>
  </div>` : ""}
  <div class="panel" style="padding-block:4px">
    ${S.phases.length ? S.phases.map((p,i)=>`
      <div class="phase">
        <div class="n">${String(i+1).padStart(2,"0")}</div>
        <div style="min-width:0">
          <div class="t">${esc(p.title)}</div>
          <div class="meta">
            ${p.start||p.end ? `<span class="mono">${fmtDate(p.start)||"?"} → ${fmtDate(p.end)||"?"}</span>`:""}
            ${p.inspection ? `<span>Inspection: ${esc(p.inspection)} <span class="pill ${esc(p.inspectionStatus||"none")}">${INSP[p.inspectionStatus||"none"]}${p.inspectionStatus==="scheduled"&&p.inspectionDate?" "+fmtDate(p.inspectionDate):""}</span></span>`:""}
          </div>
          ${phaseMoneyLine(p, pm[p.id]) || (S.selections.some(x=>x.phaseId===p.id) ? `<div class="pmoney"><div class="hint">${selLink(p).replace(/^ · /,"")}</div></div>` : "")}
          ${p.notes ? `<div class="notes">${esc(p.notes)}</div>`:""}
        </div>
        <div class="acts">
          <button class="pill ${esc(p.status)}" data-act="cycle" data-id="${esc(p.id)}" title="Tap to change status" ${readOnly?"disabled":""}>${STATUS[p.status]||"Not started"}</button>
          <button class="iconbtn write" data-act="editPhase" data-id="${esc(p.id)}">Edit</button>
        </div>
      </div>`).join("")
    : `<p class="empty" style="padding:14px 0">No phases yet. Load the standard list for a Hawaiʻi County house build, or add your own.</p>`}
  </div>
  ${pm[""].n ? `<p class="hint" style="margin-top:10px">${pm[""].n} cost${pm[""].n===1?" has":"s have"} no phase (${money(pm[""].committed)}). <a class="ext" href="#budget" data-act="phaseCosts" data-id="">Review them</a> and assign a phase so they count here.</p>` : ""}
  <p class="empty" style="margin-top:10px">Tap a status to move it along: Not started → In progress → Done. Set a budget on a phase with Edit.</p>`;
}

function vBudget(){
  const t = totals();
  const phaseName = id => id ? (S.phases.find(p=>p.id===id)?.title || "Removed phase") : "General";
  const keyOf = { phase: c => phaseName(c.phaseId), category: catOf, vendor: c => (c.vendor||"").trim() || "No vendor" }[ui.spendBy] || (c=>phaseName(c.phaseId));
  const groups = {};
  S.costs.forEach(c => { const m = costMath(c); const k = keyOf(c); const g = (groups[k] ||= {paid:0, held:0, rest:0, bud:0});
    g.paid += m.paid; g.held += m.held; g.rest += Math.max(0, m.balance - m.held); });
  if(ui.spendBy==="phase") S.phases.forEach(p => { if(+p.budget){ const g = (groups[p.title] ||= {paid:0, held:0, rest:0, bud:0}); g.bud = +p.budget; g.order = S.phases.indexOf(p); } else if(groups[p.title]) groups[p.title].order = S.phases.indexOf(p); });
  let rows = Object.entries(groups).map(([name,v])=>({name, ...v, tot:v.paid+v.held+v.rest}));
  rows = ui.spendBy==="phase" ? rows.sort((a,b)=>(a.order??999)-(b.order??999)) : rows.sort((a,b)=>b.tot-a.tot);
  const max = Math.max(1, ...rows.map(r=>Math.max(r.tot, r.bud||0)));
  const phaseOptsF = [["all","All phases"], ...S.phases.filter(p=>S.costs.some(c=>c.phaseId===p.id)).map(p=>[p.id,p.title]), ...(S.costs.some(c=>!c.phaseId || !S.phases.some(p=>p.id===c.phaseId)) ? [["none","No phase"]] : [])];
  if(!phaseOptsF.some(o=>o[0]===ui.costPhase)) ui.costPhase = "all";

  const cats = [...new Set(S.costs.map(catOf))].sort((a,b)=>{ const ia=COST_CATS.indexOf(a), ib=COST_CATS.indexOf(b); return (ia<0?99:ia)-(ib<0?99:ib); });
  if(ui.costCat!=="all" && !cats.includes(ui.costCat)) ui.costCat = "all";
  const list = S.costs.map(c=>({c, m:costMath(c)})).filter(({c,m}) =>
    (ui.costCat==="all" || catOf(c)===ui.costCat) &&
    (ui.costPhase==="all" || (ui.costPhase==="none" ? !(c.phaseId && S.phases.some(p=>p.id===c.phaseId)) : c.phaseId===ui.costPhase)) &&
    (ui.costShow==="all" || (ui.costShow==="owed" && m.state!=="quote" && m.balance>0) || (ui.costShow==="paid" && m.state==="paid") || (ui.costShow==="quotes" && m.state==="quote") || (ui.costShow==="held" && m.held>0)));
  const sum = (k) => list.reduce((a,x)=>a+x.m[k],0);
  const clip = `<svg class="clip" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/></svg>`;

  return `
  <div class="viewhead"><h2>Budget & costs</h2>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${S.costs.length ? `<button class="btn" data-act="exportCosts">Export costs</button><button class="btn" data-act="exportPayments">Export payments</button>` : ""}
      <button class="btn primary write" data-act="addCost">Add cost</button>
    </div></div>
  <div class="tiles">
    <div class="tile"><div class="label">Total budget</div><div class="v num">${t.budget?money(t.budget):"—"}</div><div class="hint">${t.budget?`${money(t.committed)} committed`:`<button class="btn-link write" data-act="project">Set a budget</button>`}</div></div>
    <div class="tile"><div class="label">Paid so far</div><div class="v num">${money(t.paid)}</div><div class="hint">${t.budget?Math.round(t.paid/t.budget*100)+"% of budget":""}</div></div>
    <div class="tile"><div class="label">Still owed</div><div class="v num">${money(t.owed)}</div><div class="hint">On contracts and orders</div></div>
    <div class="tile"><div class="label">Retainage held</div><div class="v num">${money(t.held)}</div><div class="hint">Release when work is accepted</div></div>
    <div class="tile"><div class="label">Quotes pending</div><div class="v num">${money(t.quoted)}</div><div class="hint">Not agreed yet</div></div>
    <div class="tile"><div class="label">Left in budget</div><div class="v num" style="color:${t.left<0?"var(--bad)":"inherit"}">${t.budget?money(t.left):"—"}</div><div class="hint">After everything above</div></div>
  </div>
  ${(()=>{ const f = fundingSplit(); const tot = f.loan+f.own+f.unset; if(!tot) return "";
    const w = x => (x/tot*100).toFixed(2);
    return `<div class="panel" style="margin-bottom:16px"><div class="toolbar" style="margin-bottom:10px"><h3 style="margin:0">Where the money came from</h3><a class="ext" href="#draws">Loan draws</a></div>
      <div class="meter fund"><div style="width:${w(f.loan)}%;background:var(--loan)"></div><div style="width:${w(f.own)}%;background:var(--good)"></div><div style="width:${w(f.unset)}%;background:var(--line)"></div></div>
      <div class="legend num"><span style="--c:var(--loan)">Construction loan ${money(f.loan)}</span><span style="--c:var(--good)">Own money ${money(f.own)}</span>${f.unset?`<span style="--c:var(--line)">Not specified ${money(f.unset)}</span>`:""}</div>
      ${f.nUnset ? `<p class="hint" style="margin:8px 0 0">${f.nUnset} payment${f.nUnset>1?"s don't":" doesn't"} say where the money came from. Open the cost and pick the source under Payments.</p>` : ""}</div>`; })()}
  ${rows.length ? `<div class="panel" style="margin-bottom:16px">
    <div class="toolbar" style="margin-bottom:12px"><h3 style="margin:0">Spending by ${ {phase:"phase",category:"category",vendor:"vendor"}[ui.spendBy] }</h3>${seg("spendBy",[["category","Category"],["vendor","Vendor"],["phase","Phase"]])}</div>
    <div class="bars ${ui.spendBy==="phase"?"phasebars":""}">${rows.map(r=>{ const over = r.bud && r.tot > r.bud + 0.004; return `<div class="bar"><span class="nm" title="${esc(r.name)}">${esc(r.name)}</span>
      <span class="track"><span style="width:${r.paid/max*100}%;background:var(--good)"></span><span style="width:${r.held/max*100}%;background:var(--held)"></span><span style="width:${r.rest/max*100}%;background:var(--warn);opacity:.55"></span>${r.bud?`<i class="bud" style="left:${(r.bud/max*100).toFixed(2)}%" title="Budget ${money(r.bud)}"></i>`:""}</span>
      <span class="amt" style="${over?"color:var(--bad)":""}">${money(r.tot)}${r.bud?`<small> / ${money(r.bud)}</small>`:""}</span></div>`; }).join("")}</div>
    <div class="legend" style="margin-top:10px"><span style="--c:var(--good)">Paid</span><span style="--c:var(--held)">Retainage held</span><span style="--c:var(--warn)">Owed or quoted</span>${ui.spendBy==="phase"&&rows.some(r=>r.bud)?`<span class="budkey">Phase budget</span>`:""}</div>
    ${ui.spendBy==="phase" && !S.phases.some(p=>+p.budget) ? `<p class="hint" style="margin:8px 0 0">Set a budget on each phase (Schedule → Phases → Edit) to compare planned and actual costs here.</p>` : ""}</div>`:""}
  ${S.costs.length ? `
  <div class="toolbar">${seg("costShow",[["all","All"],["owed","Owed"],["paid","Paid"],["held","Retainage"],["quotes","Quotes"]])}<span class="hint num">${list.length} cost${list.length===1?"":"s"} · ${money(sum("amt"))} total · ${money(sum("paid"))} paid</span></div>
  ${phaseOptsF.length>2 || ui.costPhase!=="all" ? `<div class="toolbar" style="margin:-4px 0 10px"><label class="srcpick" for="costPhaseSel" style="margin:0"><span>Phase</span><select id="costPhaseSel">${phaseOptsF.map(([v,l])=>`<option value="${esc(v)}" ${v===ui.costPhase?"selected":""}>${esc(l)}</option>`).join("")}</select></label></div>` : ""}
  ${cats.length>1 ? `<div class="chips" style="margin-bottom:12px" role="group" aria-label="Filter by category"><button class="chip" data-act="ui" data-k="costCat" data-v="all" aria-pressed="${ui.costCat==="all"}">All categories</button>${cats.map(c=>`<button class="chip" data-act="ui" data-k="costCat" data-v="${esc(c)}" aria-pressed="${ui.costCat===c}">${esc(c)}</button>`).join("")}</div>` : ""}` : ""}
  <div class="tablebox">
    ${S.costs.length ? (list.length ? `<table class="costs"><thead><tr><th>Date</th><th>Item</th><th>Vendor</th><th>Category</th><th>Status</th><th class="r">Amount</th><th class="r">Paid</th><th class="r">Balance</th></tr></thead><tbody>
      ${list.map(({c,m})=>{ const nR = (c.receipts||[]).length; return `<tr class="clickable" data-act="costDetail" data-id="${esc(c.id)}">
        <td class="mono c-date">${fmtDate(c.date)}</td>
        <td class="c-item">${esc(c.item)}${nR?` <span class="rc" title="${nR} receipt${nR>1?"s":""}">${clip}${nR}</span>`:""}<div class="hint ph">${esc(c.phaseId ? (S.phases.find(p=>p.id===c.phaseId)?.title || "Removed phase") : "No phase")}</div></td>
        <td class="c-vendor">${esc(c.vendor)}</td>
        <td class="c-cat">${esc(catOf(c))}</td>
        <td class="c-status"><span class="pill ${STATE[m.state][1]}">${STATE[m.state][0]}</span></td>
        <td class="r num mono c-amt">${money(m.amt)}</td>
        <td class="r num mono c-paid"><span class="m-lbl">Paid </span>${money(m.paid)}</td>
        <td class="r num mono c-bal"><span class="m-lbl">Owed </span>${m.balance?money(m.balance):"—"}${m.held?`<div class="hint">${money(m.held)} held</div>`:""}</td>
      </tr>`; }).join("")}
    </tbody></table>` : `<p class="empty" style="padding:14px 16px;margin:0">No costs match these filters.</p>`)
    : `<p class="empty" style="padding:14px 16px;margin:0">No costs yet. Add each contract, quote or purchase with its category and vendor. Then record payments against it as they're made, attach receipts, and track any retainage held back from the contractor.</p>`}
  </div>
  ${S.costs.length ? `<p class="hint" style="margin-top:10px">Tap a cost to record payments, attach receipts or release retainage.</p>` : ""}`;
}

/* ---------- cost detail: payments, retainage, receipts ---------- */
function openCostDetail(id){
  const c = S.costs.find(x=>x.id===id); if(!c){ closeSheet(); return; }
  const m = costMath(c);
  const receipts = (c.receipts||[]).filter(r=>r && isAsset(r.id));
  const phase = c.phaseId ? (S.phases.find(p=>p.id===c.phaseId)?.title||"") : "";
  const scrim = $("#scrim"); scrim.classList.remove("lbx");
  const fileTile = r => /^image\//.test(r.type||"")
    ? `<button type="button" class="thumb" data-act="receiptView" data-id="${esc(c.id)}" data-path="${esc(r.id)}" style="border:0;padding:0;cursor:zoom-in"><img src="${blob(r.id)}" data-path="${esc(r.id)}" alt="${esc(r.name||"Receipt")}"></button>`
    : `<a class="thumb pdf" href="${blob(r.id)}" data-fpath="${esc(r.id)}" target="_blank" rel="noopener" title="${esc(r.name||"PDF")}"><span>PDF</span></a>`;
  scrim.innerHTML = `<div class="sheet" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
    <div class="cd-head"><div style="min-width:0"><h3 id="sheetTitle" style="margin-bottom:2px">${esc(c.item)}</h3>
      <div class="hint">${esc([c.vendor, catOf(c), phase].filter(Boolean).join(" · "))}</div></div>
      <span class="pill ${STATE[m.state][1]}">${STATE[m.state][0]}</span></div>
    <div class="cd-sum">
      <div><span class="label">Amount</span><b class="num">${money(m.amt)}</b></div>
      <div><span class="label">Paid</span><b class="num" style="color:var(--good)">${money(m.paid)}</b></div>
      ${(m.pct||m.held) ? `<div><span class="label">Retainage held${m.pct?` (${m.pct}%)`:""}</span><b class="num" style="color:var(--held)">${money(m.held)}</b></div>` : ""}
      <div><span class="label">Still owed</span><b class="num">${money(m.balance)}</b></div>
    </div>
    ${m.amt ? `<div class="meter" style="margin:4px 0 2px"><div class="paid" style="width:${Math.min(100,m.paid/m.amt*100)}%"></div><div style="width:${Math.min(100,m.held/m.amt*100)}%;background:var(--held)"></div></div>` : ""}
    ${c.due && m.balance>m.held ? `<p class="hint" style="margin:6px 0 0">Next payment due ${fmtDate(c.due)}</p>` : ""}

    <h4 class="cd-h">Payments</h4>
    ${m.pays.length ? `<div class="pays">${m.pays.map(p=>`<div class="pay">
        <div style="min-width:0"><div><b class="num">${money(p.amount)}</b> ${p.kind==="release"?`<span class="pill held">Retainage release</span>`:""}</div>
          <div class="hint">${[fmtDate(p.date), p.method==="Loan draw"?"":p.method, p.ref?`#${p.ref}`:"", +p.retained?`${money(p.retained)} retainage held`:"", p.note].filter(Boolean).map(esc).join(" · ")}</div>
          ${readOnly ? `<div class="hint">From: ${esc(srcLabel(p))}</div>` : `<label class="srcpick"><span>From</span><select data-src-pid="${esc(p.id)}" data-id="${esc(c.id)}" aria-label="Where this payment's money came from">${sourceOptions(srcValue(p))}</select></label>`}</div>
        ${!p.legacy && !readOnly ? `<button type="button" class="iconbtn" data-act="payDel" data-id="${esc(c.id)}" data-pid="${esc(p.id)}">Remove</button>` : ""}
      </div>`).join("")}</div>` : `<p class="empty" style="margin:0">No payments yet.</p>`}

    ${!readOnly && (m.balance - m.held > 0.004 || !m.amt) ? `<form class="payform" id="payForm" novalidate>
      <div class="fields">
        <label class="field" for="payBilled"><span class="label">${m.pct?"Amount billed":"Amount paid"} ($)</span><input id="payBilled" type="number" inputmode="decimal" step="any" value="${m.amt ? (m.balance-m.held).toFixed(2).replace(/\.00$/,"") : ""}"></label>
        <label class="field" for="payDate"><span class="label">Date</span><input id="payDate" type="date" value="${today()}"></label>
        ${m.pct ? `<label class="field" for="payHeld"><span class="label">Retainage held back ($)</span><input id="payHeld" type="number" inputmode="decimal" step="any"></label>
          <div class="field"><span class="label">Paid now</span><div class="paynow num" id="payNow">—</div></div>` : ""}
        <label class="field" for="paySrc"><span class="label">Paid from</span><select id="paySrc">${sourceOptions(defaultSource())}</select></label>
        <label class="field" for="payMethod"><span class="label">Paid by</span><select id="payMethod">${PAY_METHODS.map(x=>`<option>${x}</option>`).join("")}</select></label>
        <label class="field" for="payRef"><span class="label">Check or reference no.</span><input id="payRef" placeholder="Optional"></label>
        <label class="field full" for="payNote"><span class="label">Note</span><input id="payNote" placeholder="e.g. Progress payment 2 of 4"></label>
      </div>
      <div class="err" id="payErr" hidden></div>
      <button class="btn primary" type="submit">Record payment</button>
    </form>` : ""}

    ${!readOnly && m.held > 0 ? `<form class="payform" id="relForm" novalidate>
      <div class="fields">
        <label class="field" for="relAmt"><span class="label">Release retainage ($)</span><input id="relAmt" type="number" inputmode="decimal" step="any" value="${m.held}"></label>
        <label class="field" for="relDate"><span class="label">Date</span><input id="relDate" type="date" value="${today()}"></label>
        <label class="field full" for="relSrc"><span class="label">Paid from</span><select id="relSrc">${sourceOptions(defaultSource())}</select></label>
      </div>
      <div class="err" id="relErr" hidden></div>
      <button class="btn" type="submit">Release and pay</button>
      <p class="hint" style="margin:8px 0 0">Release retainage once the work passes inspection and you have the contractor's lien releases.</p>
    </form>` : ""}

    <h4 class="cd-h">Receipts & invoices</h4>
    <div class="thumbs">${receipts.map(fileTile).join("")}
      ${!readOnly ? `<label class="thumb add" for="rcIn" title="Add receipt"><span>+</span><input type="file" id="rcIn" accept="image/jpeg,image/png,image/webp,application/pdf" multiple hidden></label>` : ""}</div>
    <div class="hint" id="rcMsg" aria-live="polite">${receipts.length ? "" : "Snap a photo of the receipt or upload the PDF invoice."}</div>
    ${c.notes ? `<h4 class="cd-h">Notes</h4><p style="margin:0;white-space:pre-wrap">${esc(c.notes)}</p>` : ""}

    <div class="foot">
      ${!readOnly ? `<button type="button" class="btn" data-act="editCost" data-id="${esc(c.id)}">Edit details</button>` : ""}
      <div class="right"><button type="button" class="btn primary" id="cdClose">Done</button></div>
    </div>
  </div>`;
  scrim.hidden = false;
  $("#cdClose").onclick = closeSheet;
  scrim.onclick = e => { if(e.target===scrim) closeSheet(); };
  $("#sheet").onkeydown = e => { if(e.key==="Escape") closeSheet(); };

  const base = () => { const cur = S.costs.find(x=>x.id===id) || c; const {id:_, ...body} = cur;
    const pays = (Array.isArray(body.payments) && body.payments.length) ? [...body.payments] : payList(cur).map(p=>{ const {legacy, ...q} = p; return {...q, id: newId()}; });
    return {...body, payments: pays}; };
  const commit = async (out, errEl) => { const err = await save(`costs/${id}`, out); if(err){ errEl.textContent = err; errEl.hidden = false; return false; } openCostDetail(id); return true; };

  const pf = $("#payForm");
  if(pf){
    const billed = $("#payBilled"), heldIn = $("#payHeld"), now = $("#payNow");
    let heldTouched = false;
    const recalc = () => { if(!heldIn) return; const b = +billed.value||0;
      if(!heldTouched) heldIn.value = b ? +(b*m.pct/100).toFixed(2) : "";
      now.textContent = money(Math.max(0, b - (+heldIn.value||0))); };
    if(heldIn){ heldIn.oninput = () => { heldTouched = true; recalc(); }; billed.oninput = recalc; recalc(); }
    pf.onsubmit = async e => { e.preventDefault();
      const err = $("#payErr"); const b = +billed.value; const h = heldIn ? (+heldIn.value||0) : 0;
      if(!(b>0)){ err.textContent = "Enter the amount."; err.hidden = false; billed.focus(); return; }
      if(h<0 || h>b){ err.textContent = "Retainage can't be more than the amount billed."; err.hidden = false; return; }
      const out = base();
      out.payments.push({ id:newId(), kind:"payment", date:$("#payDate").value||today(), amount:+(b-h).toFixed(2), retained:+h.toFixed(2),
        source:$("#paySrc").value, method:$("#payMethod").value, ref:$("#payRef").value.trim(), note:$("#payNote").value.trim(), by: me||"" });
      if(out.status==="estimate") out.status = "committed";
      if(!out.amount) out.amount = +(b).toFixed(2);
      pf.querySelector("[type=submit]").disabled = true;
      await commit(out, err);
    };
  }
  const rf = $("#relForm");
  if(rf) rf.onsubmit = async e => { e.preventDefault();
    const err = $("#relErr"); const a = +$("#relAmt").value;
    if(!(a>0) || a > m.held + 0.004){ err.textContent = `Enter an amount up to ${money(m.held)}.`; err.hidden = false; return; }
    const out = base();
    out.payments.push({ id:newId(), kind:"release", date:$("#relDate").value||today(), amount:+a.toFixed(2), retained:0, source:$("#relSrc").value, method:"", ref:"", note:"Retainage released", by: me||"" });
    rf.querySelector("[type=submit]").disabled = true;
    await commit(out, err);
  };
  document.querySelectorAll("#sheet [data-src-pid]").forEach(sel => sel.onchange = async () => {
    const out = base(); const pid = sel.dataset.srcPid;
    const p = pid==="legacy" ? out.payments[0] : out.payments.find(x=>x.id===pid); if(!p) return;
    p.source = sel.value; if(p.method==="Loan draw") p.method = "";
    sel.disabled = true; const err = await save(`costs/${id}`, out);
    if(err){ showNotice(err); sel.disabled = false; } else openCostDetail(id);
  });
  const rc = $("#rcIn");
  if(rc) rc.onchange = async () => {
    const files = [...rc.files]; rc.value = ""; const msg = $("#rcMsg"); const added = []; let failed = "";
    for(const [n,file] of files.entries()){
      msg.textContent = `Uploading ${n+1} of ${files.length}…`;
      try { const r = await assets.upload(file); added.push({id:r.id, type:r.contentType, name:String(file.name).slice(0,200), size:r.sizeBytes}); }
      catch(e){ failed = uploadErr(e, file); }
    }
    if(added.length){ const cur = S.costs.find(x=>x.id===id) || c; const {id:_, ...body} = cur;
      const err = await save(`costs/${id}`, {...body, receipts:[...(body.receipts||[]), ...added]});
      if(err) failed = err; else { openCostDetail(id); if(failed) $("#rcMsg").textContent = failed; return; } }
    msg.textContent = failed || "";
  };
}
function closeSheet(){ const sc = $("#scrim"); sc.hidden = true; sc.innerHTML = ""; sc.classList.remove("lbx"); }
const uploadErr = (e, file) => ({unsupported_type:`${file.name} isn't supported. Use a JPG, PNG, WebP or PDF.`, too_large:`${file.name} is over 20 MB.`})[e?.code] || `Couldn't upload ${file.name}. Try again.`;

/* ---------- CSV export ---------- */
function csvCell(v){
  if(v===null || v===undefined) return "";
  if(typeof v==="number") return String(Math.round(v*100)/100);
  let s = String(v);
  if(/^[=+\-@\t\r]/.test(s)) s = "'" + s;          // keep spreadsheets from treating text as a formula
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}
function downloadCsv(name, header, rows){
  const text = "﻿" + [header, ...rows].map(r=>r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const url = URL.createObjectURL(new Blob([text], {type:"text/csv;charset=utf-8"}));
  const a = Object.assign(document.createElement("a"), {href:url, download:name});
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
}
function exportCosts(){
  const phaseName = id => id ? (S.phases.find(p=>p.id===id)?.title || "") : "General";
  const rows = S.costs.map(c => { const m = costMath(c); return [c.date||"", c.item, c.vendor||"", catOf(c), phaseName(c.phaseId), STATE[m.state][0],
    m.amt, m.paid, m.pct||0, m.held, m.balance, c.due||"", (c.receipts||[]).length, c.notes||""]; });
  downloadCsv(`${slug(S.project.name||"house-build")}-costs-${today()}.csv`,
    ["Date","Item","Vendor","Category","Phase","Status","Amount","Paid","Retainage %","Retainage held","Still owed","Payment due","Receipts","Notes"], rows);
}
function exportPayments(){
  const rows = [];
  S.costs.forEach(c => payList(c).forEach(p => rows.push([p.date||"", c.item, c.vendor||"", catOf(c), p.kind==="release"?"Retainage release":"Payment",
    +p.amount||0, +p.retained||0, (+p.amount||0)+(+p.retained||0), srcLabel(p), p.method==="Loan draw"?"":(p.method||""), p.ref||"", p.note||"", memberName(p.by)||""])));
  rows.sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  downloadCsv(`${slug(S.project.name||"house-build")}-payments-${today()}.csv`,
    ["Date","Item","Vendor","Category","Type","Amount paid","Retainage held","Amount billed","Paid from","Paid by","Reference","Note","Recorded by"], rows);
}

function orderSoon(s){ if(!s.orderBy || ["ordered","delivered","installed"].includes(s.status)) return null; const d = daysTo(s.orderBy); return d!==null && d<=14 ? d : null; }
function vSelections(){
  const all = S.selections;
  const committed = all.filter(s=>COMMITTED.has(s.status));
  const deciding = all.filter(s=>s.status==="considering"||!s.status);
  const waiting = all.filter(s=>s.status==="ordered");
  const soon = all.filter(s=>orderSoon(s)!==null);
  const sum = arr => arr.reduce((a,s)=>a+selTotal(s),0);

  const allowCats = CATS.filter(c => +S.allowances[c] > 0);
  const byCat = {}; committed.forEach(s => { const c = s.category||"Other"; byCat[c] = (byCat[c]||0) + selTotal(s); });

  const rooms = [...new Set(all.map(s=>s.room||"Unassigned"))].sort();
  const usedPhases = S.phases.filter(p => all.some(s=>s.phaseId===p.id));
  const noPhase = all.filter(s=>!phaseOf(s));
  if(selFilter.phase!=="all" && selFilter.phase!=="none" && !usedPhases.some(p=>p.id===selFilter.phase)) selFilter.phase="all";
  const cats = [...new Set(all.map(s=>s.category||"Other"))].sort((a,b)=>CATS.indexOf(a)-CATS.indexOf(b));
  if(selFilter.room!=="all" && !rooms.includes(selFilter.room)) selFilter.room="all";
  if(selFilter.cat!=="all" && !cats.includes(selFilter.cat)) selFilter.cat="all";
  const shown = all.filter(s => (selFilter.room==="all" || (s.room||"Unassigned")===selFilter.room) && (selFilter.cat==="all" || (s.category||"Other")===selFilter.cat)
    && (selFilter.phase==="all" || (selFilter.phase==="none" ? !phaseOf(s) : s.phaseId===selFilter.phase)));
  const groups = {}; const gkey = s => selFilter.group==="phase" ? (phaseOf(s)?.title || "No phase yet") : (s.room||"Unassigned");
  shown.forEach(s => (groups[gkey(s)] ||= []).push(s));
  const gorder = selFilter.group==="phase" ? Object.keys(groups).sort((a,b)=>{ const ia=S.phases.findIndex(p=>p.title===a), ib=S.phases.findIndex(p=>p.title===b); return (ia<0?999:ia)-(ib<0?999:ib); }) : Object.keys(groups).sort();
  const costIds = new Set(S.costs.map(c=>c.id));

  const card = s => {
    const ph = (s.photos||[]).filter(isAsset);
    const link = safeUrl(s.link);
    const os = orderSoon(s);
    const qty = s.qty===null||s.qty===undefined||s.qty==="" ? 1 : +s.qty;
    const inBudget = s.costId && costIds.has(s.costId);
    return `<article class="sel">
      ${ph.length ? `<button class="ph" data-act="photo" data-coll="selections" data-id="${esc(s.id)}" aria-label="View photos of ${esc(s.item)}"><img src="${blob(ph[0])}" data-path="${esc(ph[0])}" alt="" loading="lazy">${ph.length>1?`<span class="count">${ph.length} photos</span>`:""}</button>`
        : `<div class="ph none"><span class="ct">${esc(s.category||"No photo")}</span></div>`}
      <div class="bd">
        <div class="hd"><span class="nm">${esc(s.item)}</span><span class="pill ${SEL_CLASS[s.status]??""}">${SEL_ST[s.status]||"Considering"}</span></div>
        <div class="sub selph">${phaseOf(s) ? esc(phaseOf(s).title) : `<span style="color:var(--bad)">No phase yet</span>`}${selFilter.group==="phase" && s.room ? ` · ${esc(s.room)}` : ""}</div>
        ${s.brand||s.finish ? `<div class="sub">${esc([s.brand,s.finish].filter(Boolean).join(" · "))}</div>`:""}
        ${s.vendor ? `<div class="sub">From ${esc(s.vendor)}</div>`:""}
        <div class="price num">${s.price!==null&&s.price!==undefined&&s.price!=="" ? (qty!==1 ? `${money(s.price)} × ${qty} = <b>${money(selTotal(s))}</b>` : `<b>${money(s.price)}</b>`) : `<span class="empty">No price yet</span>`}</div>
        ${os!==null ? `<div><span class="pill soon">${os<0 ? "Order date passed" : os===0 ? "Order today" : `Order within ${os} day${os===1?"":"s"}`}</span></div>` : s.orderBy && !["ordered","delivered","installed"].includes(s.status) ? `<div class="sub">Order by ${fmtDate(s.orderBy)}${s.leadWeeks?` · ${s.leadWeeks} wk lead time`:""}</div>` : s.leadWeeks ? `<div class="sub">${s.leadWeeks} wk lead time</div>`:""}
        ${s.purchase ? `<div class="bought"><b class="num">${money(s.purchase.total)}</b> paid ${fmtDate(s.purchase.date)}<br>${esc(srcLabel({source:s.purchase.source}))}${s.purchase.vendor?` · ${esc(s.purchase.vendor)}`:""}</div>
          ${s.status==="ordered" && s.deliveryDate ? `<div class="sub">Delivery expected ${fmtDate(s.deliveryDate)}</div>` : ""}
          ${warrantyState(s) ? `<div><span class="pill ${warrantyState(s)[0]}">${esc(warrantyState(s)[1])}</span></div>` : ""}` : ""}
        ${s.notes ? `<div class="sub" style="color:var(--ink)">${esc(trunc(s.notes,120))}</div>`:""}
        <div class="acts">
          ${link ? `<a class="ext" href="${esc(link)}" target="_blank" rel="noopener noreferrer">View product ↗</a>`:""}
          <button class="iconbtn write" data-act="editSel" data-id="${esc(s.id)}">Edit</button>
          ${s.purchase ? `<button class="iconbtn" data-act="costDetail" data-id="${esc(s.purchase.costId)}">View payment</button>`
            : `<button class="iconbtn write strong" data-act="purchase" data-id="${esc(s.id)}">Purchase item</button>${inBudget ? `<span class="intag">In budget</span>` : (s.price ? `<button class="iconbtn write" data-act="toBudget" data-id="${esc(s.id)}">Add to budget</button>`:"")}`}
        </div>
      </div>
    </article>`;
  };

  return `
  <div class="viewhead"><h2>Selections</h2>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn write" data-act="allowances">Set allowances</button>
      <button class="btn primary write" data-act="addSel">Add item</button>
    </div></div>
  <div class="tiles">
    <div class="tile"><div class="label">Chosen so far</div><div class="v num">${money(sum(committed))}</div><div class="hint">${committed.length} item${committed.length===1?"":"s"}</div></div>
    <div class="tile"><div class="label">Still deciding</div><div class="v num">${deciding.length}</div><div class="hint">${money(sum(deciding))} in options</div></div>
    <div class="tile"><div class="label">Ordered, not delivered</div><div class="v num">${waiting.length}</div><div class="hint">${money(sum(waiting))}</div></div>
    <div class="tile"><div class="label">Order in next 2 weeks</div><div class="v num" style="color:${soon.length?"var(--bad)":"inherit"}">${soon.length}</div><div class="hint">Plan for shipping time to Hilo</div></div>
  </div>
  ${allowCats.length ? `<div class="panel" style="margin-bottom:16px"><h3>Allowances</h3><div class="bars">
    ${allowCats.map(c => { const a=+S.allowances[c], u=byCat[c]||0, over=u>a; const scale=Math.max(a,u);
      return `<div class="bar"><span class="nm">${esc(c)}</span><span class="track"><span style="width:${Math.min(u,a)/scale*100}%;background:var(--accent)"></span>${over?`<span style="width:${(u-a)/scale*100}%;background:var(--bad)"></span>`:""}</span><span class="amt" style="color:${over?"var(--bad)":"inherit"}">${money(u)} / ${money(a)}</span></div>`; }).join("")}
    </div><div class="legend" style="margin-top:10px"><span style="--c:var(--accent)">Chosen, ordered or installed</span><span style="--c:var(--bad)">Over allowance</span></div></div>` : ""}
  ${all.length ? `
    ${noPhase.length ? `<div class="notice">${noPhase.length} item${noPhase.length>1?"s aren't":" isn't"} tied to a phase yet. <a class="ext" href="#selections" data-act="selNoPhase">Show ${noPhase.length>1?"them":"it"}</a>, then use Edit to pick one.</div>` : ""}
    <div class="toolbar" style="margin-bottom:10px">
      ${seg("selGroup",[["room","By room"],["phase","By phase"]])}
      <label class="srcpick" for="selPhaseSel" style="margin:0"><span>Phase</span><select id="selPhaseSel">${[["all","All phases"], ...usedPhases.map(p=>[p.id,p.title]), ...(noPhase.length?[["none","No phase yet"]]:[])].map(([v,l])=>`<option value="${esc(v)}" ${v===selFilter.phase?"selected":""}>${esc(l)}</option>`).join("")}</select></label>
    </div>
    <div class="chips" role="group" aria-label="Filter by room"><span class="label">Room</span>
      <button class="chip" data-act="fRoom" data-v="all" aria-pressed="${selFilter.room==="all"}">All</button>
      ${rooms.map(r=>`<button class="chip" data-act="fRoom" data-v="${esc(r)}" aria-pressed="${selFilter.room===r}">${esc(r)}</button>`).join("")}</div>
    <div class="chips" role="group" aria-label="Filter by category"><span class="label">Type</span>
      <button class="chip" data-act="fCat" data-v="all" aria-pressed="${selFilter.cat==="all"}">All</button>
      ${cats.map(c=>`<button class="chip" data-act="fCat" data-v="${esc(c)}" aria-pressed="${selFilter.cat===c}">${esc(c)}</button>`).join("")}</div>
    ${gorder.map(r => `<h3 class="room-h"><span>${esc(r)}</span><span class="sum">${money(sum(groups[r].filter(s=>COMMITTED.has(s.status))))} chosen</span></h3>
      <div class="sel-grid">${groups[r].map(card).join("")}</div>`).join("") || `<p class="empty" style="margin-top:16px">No items match these filters.</p>`}`
  : `<div class="panel"><p class="empty" style="margin:0">Nothing here yet. Add the fixtures and finishes you're looking at: light fixtures, cabinets, faucets, tile, flooring, appliances. Attach photos, note the price and where to buy it, and mark it Chosen once you decide.</p></div>`}`;
}

const selCostCat = s => s.category==="Appliances"||s.category==="Plumbing fixtures"||s.category==="Lighting" ? "Appliances & fixtures" : "Materials";
const WARRANTY_TERMS = [["","No warranty / not sure"],["3","90 days"],["12","1 year"],["24","2 years"],["36","3 years"],["60","5 years"],["120","10 years"],["life","Lifetime"]];
function addMonths(dateStr, m){ const d = new Date((dateStr||today())+"T12:00:00"); d.setMonth(d.getMonth()+m); return d.toISOString().slice(0,10); }
function warrantyState(s){
  if(s.warrantyTerm==="life") return ["done","Lifetime warranty"];
  if(!s.warrantyExp) return null; const d = daysTo(s.warrantyExp);
  if(d < 0) return ["", `Warranty ended ${fmtDate(s.warrantyExp)}`];
  if(d <= 30) return ["scheduled", `Warranty ends in ${d} day${d===1?"":"s"}`];
  return ["done", `Warranty until ${fmtDate(s.warrantyExp)}`];
}
function openPurchase(id){
  const s = S.selections.find(x=>x.id===id); if(!s || readOnly) return;
  const total0 = selTotal(s);
  const linked = s.costId && S.costs.find(c=>c.id===s.costId);
  const lines = S.costs.map(c=>({c, m:costMath(c)})).sort((a,b)=> (b.c.phaseId===s.phaseId) - (a.c.phaseId===s.phaseId) || a.c.item.localeCompare(b.c.item));
  const lineLabel = ({c,m}) => `${c.item}${c.phaseId===s.phaseId?"":" ("+(S.phases.find(p=>p.id===c.phaseId)?.title||"no phase")+")"} · ${money(m.paid)} of ${money(m.amt)} paid`;
  const scrim = $("#scrim"); scrim.classList.remove("lbx");
  scrim.innerHTML = `<form class="sheet" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle" novalidate>
    <div class="cd-head"><div style="min-width:0"><h3 id="sheetTitle" style="margin-bottom:2px">Purchase: ${esc(s.item)}</h3>
      <div class="hint">${esc([phaseOf(s)?.title, s.room, s.brand].filter(Boolean).join(" · "))}</div></div></div>
    <div class="fields">
      <label class="field" for="puAmt"><span class="label">Amount paid ($) *</span><input id="puAmt" type="number" inputmode="decimal" step="any" value="${total0||""}"></label>
      <label class="field" for="puExtra"><span class="label">Tax and shipping ($)</span><input id="puExtra" type="number" inputmode="decimal" step="any" placeholder="0"></label>
      <div class="field full"><span class="label">Total</span><div class="paynow num" id="puTotal">—</div></div>
      <label class="field" for="puDate"><span class="label">Date purchased</span><input id="puDate" type="date" value="${today()}"></label>
      <label class="field" for="puVendor"><span class="label">Bought from</span><input id="puVendor" value="${esc(s.vendor||"")}" list="puVendorL"><datalist id="puVendorL">${vendorNames().map(v=>`<option value="${esc(v)}">`).join("")}</datalist></label>
      <label class="field" for="puSrc"><span class="label">Paid from</span><select id="puSrc">${sourceOptions("own")}</select></label>
      <label class="field" for="puMethod"><span class="label">Paid by</span><select id="puMethod">${PAY_METHODS.map(x=>`<option ${x==="Credit card"?"selected":""}>${x}</option>`).join("")}</select></label>
      <label class="field full" for="puLine"><span class="label">Apply to budget line</span><select id="puLine">
        <option value="new" ${linked?"":"selected"}>New line: ${esc(s.item)}${phaseOf(s)?` (${esc(phaseOf(s).title)})`:""}</option>
        ${lines.length?`<optgroup label="Existing budget lines">${lines.map(x=>`<option value="${esc(x.c.id)}" ${linked&&x.c.id===s.costId?"selected":""}>${esc(lineLabel(x))}</option>`).join("")}</optgroup>`:""}
      </select><span class="hint" id="puLineHint"></span></label>
      <label class="field" for="puRef"><span class="label">Order or receipt no.</span><input id="puRef" placeholder="Optional"></label>
      <label class="field" for="puStatus"><span class="label">Delivery</span><select id="puStatus"><option value="ordered">Ordered, waiting for delivery</option><option value="delivered">Have it (picked up or delivered)</option><option value="installed">Installed</option></select></label>
      <label class="field" for="puDeliv"><span class="label">Expected delivery</span><input id="puDeliv" type="date"></label>
      <label class="field" for="puSerial"><span class="label">Serial or model no.</span><input id="puSerial" value="${esc(s.brand||"")}"></label>
      <label class="field" for="puWarr"><span class="label">Warranty</span><select id="puWarr">${WARRANTY_TERMS.map(([v,l])=>`<option value="${v}">${l}</option>`).join("")}</select></label>
      <label class="field" for="puWarrExp"><span class="label">Warranty expires</span><input id="puWarrExp" type="date"></label>
      <label class="field full" for="puWarrNote"><span class="label">Warranty details</span><input id="puWarrNote" placeholder="e.g. Parts 5 years, labor 1 year. Register within 30 days."></label>
      <div class="field full"><span class="label">Receipt</span><div class="thumbs" id="puFiles"></div>
        <label class="btn upl" for="puIn">Add receipt<input type="file" id="puIn" accept="image/jpeg,image/png,image/webp,application/pdf" multiple hidden></label>
        <div class="hint" id="puMsg" aria-live="polite">Photo or PDF of the receipt or order confirmation.</div></div>
    </div>
    <div class="err" id="puErr" hidden></div>
    <div class="foot"><div class="right"><button type="button" class="btn" id="cancelBtn">Cancel</button><button type="submit" class="btn primary">Record purchase</button></div></div>
  </form>`;
  scrim.hidden = false;
  const form = $("#sheet"); let files = [];
  const amt = $("#puAmt"), extra = $("#puExtra"), date = $("#puDate"), warr = $("#puWarr"), wexp = $("#puWarrExp"), line = $("#puLine"), st = $("#puStatus"), deliv = $("#puDeliv");
  let wexpTouched = false;
  const recalc = () => { $("#puTotal").textContent = money((+amt.value||0) + (+extra.value||0));
    if(!wexpTouched){ wexp.value = /^\d+$/.test(warr.value) ? addMonths(date.value, +warr.value) : ""; }
    deliv.closest(".field").hidden = st.value!=="ordered";
    const l = line.value!=="new" && lines.find(x=>x.c.id===line.value);
    $("#puLineHint").textContent = l ? `The purchase is added as a payment on this line. ${money(Math.max(0,l.m.amt-l.m.paid))} of it is unpaid now.` : "Creates a new cost in the item's phase, already paid.";
  };
  [amt, extra, date, warr, line, st].forEach(el => el.addEventListener("input", recalc)); [warr, line, st].forEach(el => el.addEventListener("change", recalc));
  wexp.addEventListener("input", () => { wexpTouched = true; });
  recalc();
  const drawFiles = () => { $("#puFiles").innerHTML = files.map((r,i)=>`<div class="thumb">${/^image\//.test(r.type||"") ? `<img src="${blob(r.id)}" data-path="${esc(r.id)}" alt="">` : `<span class="pdfmark">PDF</span>`}<button type="button" data-frm="${i}" aria-label="Remove">✕</button></div>`).join("");
    $("#puFiles").querySelectorAll("[data-frm]").forEach(x => x.onclick = () => { files.splice(+x.dataset.frm,1); drawFiles(); }); };
  $("#puIn").onchange = async () => { const inp = $("#puIn"); const list = [...inp.files]; inp.value = ""; let failed = "";
    for(const [n,file] of list.entries()){ $("#puMsg").textContent = `Uploading ${n+1} of ${list.length}…`;
      try { const r = await assets.upload(file); files.push({id:r.id, type:r.contentType, name:String(file.name).slice(0,200), size:r.sizeBytes}); drawFiles(); } catch(e){ failed = uploadErr(e, file); } }
    $("#puMsg").textContent = failed || "Added."; };
  const close = closeSheet;
  $("#cancelBtn").onclick = close; scrim.onclick = e => { if(e.target===scrim) close(); }; form.onkeydown = e => { if(e.key==="Escape") close(); };
  form.onsubmit = async e => { e.preventDefault();
    const err = t => { $("#puErr").textContent = t; $("#puErr").hidden = false; };
    const a = +amt.value, x = +extra.value||0;
    if(!(a>0)) return err("Enter the amount paid.");
    if(x<0) return err("Tax and shipping can't be negative.");
    const total = +(a + x).toFixed(2), when = date.value || today(), vendor = $("#puVendor").value.trim(), src = $("#puSrc").value;
    const btn = form.querySelector("[type=submit]"); btn.disabled = true; btn.textContent = "Saving…";
    const payment = { id:newId(), kind:"payment", date:when, amount:total, retained:0, source:src, method:$("#puMethod").value, ref:$("#puRef").value.trim(), note:`Purchased: ${s.item}`, by:me||"", selectionId:s.id };
    let costId, e1;
    if(line.value==="new"){
      costId = newId();
      e1 = await save(`costs/${costId}`, { item: s.item + (s.room?` (${s.room})`:""), vendor, category: selCostCat(s), phaseId: phaseOf(s) ? s.phaseId : "", amount: total, status:"committed", date: when,
        payments:[payment], receipts: files, notes:"Purchased from Selections", selectionId: s.id, createdAt: new Date().toISOString() });
    } else {
      costId = line.value; const cur = S.costs.find(c=>c.id===costId); const {id:_, ...body} = cur;
      const pays = (Array.isArray(body.payments) && body.payments.length) ? [...body.payments] : payList(cur).map(p=>{ const {legacy, ...q} = p; return {...q, id:newId()}; });
      e1 = await save(`costs/${costId}`, { ...body, status: body.status==="estimate" ? "committed" : body.status, vendor: body.vendor || vendor, payments:[...pays, payment], receipts:[...(body.receipts||[]), ...files] });
    }
    if(e1){ btn.disabled = false; btn.textContent = "Record purchase"; return err(e1); }
    const {id:_s, ...sb} = S.selections.find(z=>z.id===s.id) || s;
    const e2 = await save(`selections/${s.id}`, { ...sb, status: st.value, vendor: vendor || sb.vendor || "", costId: sb.costId || costId,
      purchase: { date:when, amount:a, extra:x, total, vendor, ref:payment.ref, source:src, method:payment.method, costId, paymentId:payment.id },
      deliveryDate: st.value==="ordered" ? deliv.value : (sb.deliveryDate||""), serial: $("#puSerial").value.trim(),
      warrantyTerm: warr.value, warrantyExp: warr.value==="life" ? "" : wexp.value, warrantyNote: $("#puWarrNote").value.trim(),
      receipts: [...(sb.receipts||[]), ...files] });
    if(e2){ btn.disabled = false; btn.textContent = "Record purchase"; return err(e2); }
    close();
  };
  setTimeout(()=>amt.focus(), 0);
}

function openLightbox(coll, id, start=0){
  const rec = (S[coll]||[]).find(x=>x.id===id); if(!rec) return;
  const ph = (coll==="documents" ? [rec.file?.id] : (rec.photos||[])).filter(isAsset); if(!ph.length) return;
  const s = {item: rec.item || rec.title || trunc(rec.text,40) || "Photo"};
  let i = Math.min(+start||0, ph.length-1);
  const scrim = $("#scrim"); scrim.classList.add("lbx");
  const draw = () => {
    scrim.innerHTML = `<div class="lb" role="dialog" aria-modal="true" aria-label="${esc(s.item)} photos">
      <img src="${blob(ph[i])}" data-path="${esc(ph[i])}" alt="${esc(s.item)}, photo ${i+1} of ${ph.length}">
      <div class="lbrow">${ph.length>1?`<button class="btn" id="lbPrev" type="button">Previous</button><span>${i+1} / ${ph.length}</span><button class="btn" id="lbNext" type="button">Next</button>`:""}<button class="btn" id="lbClose" type="button">Close</button></div></div>`;
    $("#lbClose").onclick = close; $("#lbClose").focus();
    if(ph.length>1){ $("#lbPrev").onclick = ()=>{ i=(i-1+ph.length)%ph.length; draw(); }; $("#lbNext").onclick = ()=>{ i=(i+1)%ph.length; draw(); }; }
  };
  const close = () => { scrim.hidden = true; scrim.innerHTML = ""; scrim.classList.remove("lbx"); document.removeEventListener("keydown", key); };
  const key = e => { if(e.key==="Escape") close(); else if(e.key==="ArrowRight"&&ph.length>1){ i=(i+1)%ph.length; draw(); } else if(e.key==="ArrowLeft"&&ph.length>1){ i=(i-1+ph.length)%ph.length; draw(); } };
  document.addEventListener("keydown", key);
  scrim.onclick = e => { if(e.target===scrim) close(); };
  scrim.hidden = false; draw();
}

function strip(coll, rec){
  const ids = (rec.photos||[]).filter(isAsset); if(!ids.length) return "";
  return `<div class="ministrip">${ids.map((p,i)=>`<button data-act="photo" data-coll="${coll}" data-id="${esc(rec.id)}" data-i="${i}" aria-label="Open photo ${i+1}"><img src="${blob(p)}" data-path="${esc(p)}" alt="" loading="lazy"></button>`).join("")}</div>`;
}
const pill = (cls, txt, act, id) => act && !readOnly ? `<button class="pill ${cls}" data-act="${act}" data-id="${esc(id)}" title="Tap to move to the next status">${txt}</button>` : `<span class="pill ${cls}">${txt}</span>`;
const seg = (k, opts) => { const cur = k==="selGroup" ? selFilter.group : ui[k]; return `<div class="seg" role="group">${opts.map(([v,l])=>`<button data-act="ui" data-k="${k}" data-v="${v}" aria-pressed="${cur===v}">${l}</button>`).join("")}</div>`; };
const phaseTitle = id => id ? (S.phases.find(p=>p.id===id)?.title || "") : "";
const signed = n => (n<0?"−":"+") + money(Math.abs(n));

function vWarranties(){
  const items = S.selections.filter(s=>s.purchase).sort((a,b)=> (a.warrantyExp||"9999").localeCompare(b.warrantyExp||"9999"));
  return `
  <div class="viewhead"><h2>Purchases and warranties</h2></div>
  <p class="hint" style="margin:-4px 0 14px;max-width:62ch">Everything bought through Selections, with where it came from, serial numbers, receipts and when the warranty ends. Keep this handy after move-in.</p>
  <div class="panel" style="padding-block:2px"><div class="rows">
    ${items.length ? items.map(s=>{ const w = warrantyState(s); const rc = (s.receipts||[]).filter(r=>r&&isAsset(r.id));
      return `<div class="row"><div style="min-width:0">
        <div class="t">${esc(s.item)}</div>
        <div class="meta">${[phaseOf(s)?.title, s.room].filter(Boolean).map(x=>`<span>${esc(x)}</span>`).join("")}</div>
        <div class="meta"><span>Bought ${fmtDate(s.purchase.date)}${s.purchase.vendor?` from ${esc(s.purchase.vendor)}`:""}</span>${s.purchase.ref?`<span>Order ${esc(s.purchase.ref)}</span>`:""}${s.serial?`<span class="copyable">Serial/model ${esc(s.serial)}</span>`:""}</div>
        ${s.warrantyNote?`<div class="txt">${esc(s.warrantyNote)}</div>`:""}
        ${rc.length?`<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:6px">${rc.map(r=>`<a class="ext" href="${blob(r.id)}" data-fpath="${esc(r.id)}" target="_blank" rel="noopener">${esc(trunc(r.name||"Receipt",32))}</a>`).join("")}</div>`:""}
      </div><div class="side">
        ${w?`<span class="pill ${w[0]}">${esc(w[1])}</span>`:`<span class="hint">No warranty recorded</span>`}
        <span class="amt">${money(s.purchase.total)}</span><span class="hint">${esc(srcLabel({source:s.purchase.source}))}</span>
        <button class="iconbtn write" data-act="editSel" data-id="${esc(s.id)}">Edit</button>
      </div></div>`; }).join("")
    : `<p class="empty" style="padding:14px 0">Nothing purchased yet. In Selections, tap <b>Purchase item</b> on a fixture or finish to record what was paid, where it came from and its warranty.</p>`}
  </div></div>`;
}

function vLog(){
  return `
  <div class="viewhead"><h2>Site log</h2><button class="btn primary write" data-act="add" data-kind="log">Add site note</button></div>
  <div class="panel" style="padding-block:2px">
    ${S.log.length ? S.log.map(l=>`
      <div class="entry">
        <div class="date">${fmtDate(l.date)}</div>
        <div style="min-width:0"><div class="body">${esc(l.text)}</div>${strip("log", l)}${l.author?`<div class="by" data-author="${esc(l.author)}"></div>`:""}</div>
        <button class="iconbtn write" data-act="edit" data-kind="log" data-id="${esc(l.id)}">Edit</button>
      </div>`).join("")
    : `<p class="empty" style="padding:14px 0">Nothing logged yet. After each site visit, note what got done, who was there and any delays, and add photos. Photos of wiring and plumbing before the drywall goes up are worth keeping forever.</p>`}
  </div>`;
}

function vTimeline(){
  const all = events();
  const list = ui.tlRange==="upcoming" ? all.filter(e=>daysTo(e.date)>=0) : all;
  const dated = S.phases.filter(p=>p.start && p.end && p.end>=p.start);
  let gantt = "";
  if(dated.length){
    const t0 = new Date(dated.reduce((m,p)=>p.start<m?p.start:m, dated[0].start)+"T12:00:00").getTime();
    let t1 = new Date(dated.reduce((m,p)=>p.end>m?p.end:m, dated[0].end)+"T12:00:00").getTime();
    if(t1-t0 < 14*864e5) t1 = t0 + 14*864e5;
    const x = d => (new Date(d+"T12:00:00").getTime()-t0)/(t1-t0)*100;
    const ticks = []; const m = new Date(t0); m.setDate(1); m.setMonth(m.getMonth()+1);
    while(m.getTime() < t1){ ticks.push(new Date(m)); m.setMonth(m.getMonth()+1); }
    const step = Math.ceil(ticks.length/8)||1;
    const nowX = x(today());
    gantt = `<div class="panel" style="margin-bottom:16px"><h3>Phase schedule</h3><div class="gantt"><div class="gantt-in">
      <div class="g-scale"><span></span><div class="ticks">${ticks.filter((_,i)=>i%step===0).map(d=>`<span style="left:${(d.getTime()-t0)/(t1-t0)*100}%">${d.toLocaleDateString("en-US",{month:"short",year:"2-digit"})}</span>`).join("")}</div></div>
      ${dated.map(p=>`<div class="g-row"><span class="nm" title="${esc(p.title)}">${esc(p.title)}</span><div class="g-track">${nowX>=0&&nowX<=100?`<span class="g-today" style="left:${nowX}%"></span>`:""}<span class="g-bar ${esc(p.status)}" style="left:${x(p.start)}%;width:${Math.max(.8,x(p.end)-x(p.start))}%" title="${fmtDate(p.start)} to ${fmtDate(p.end)}"></span></div></div>`).join("")}
    </div></div><div class="legend" style="margin-top:10px"><span style="--c:var(--ink)">Done</span><span style="--c:var(--muted)">In progress</span><span style="--c:var(--accent-soft)">Not started</span><span style="--c:var(--bad)">Today</span></div></div>`;
  }
  let lastM = "";
  const items = list.map(e=>{
    const d = new Date(e.date+"T12:00:00"); const mk = d.toLocaleDateString("en-US",{month:"long",year:"numeric"});
    const head = mk!==lastM ? `<div class="tl-month">${mk}</div>` : ""; lastM = mk;
    const dd = daysTo(e.date);
    return `${head}<div class="tl ${dd<0?"past":""} ${dd===0?"today":""}"><div class="d"><b>${d.getDate()}</b>${d.toLocaleDateString("en-US",{weekday:"short"})}</div>
      <div class="what"><span class="k">${esc(e.kind)}</span><a class="ext" style="color:var(--ink);font-weight:500" href="#${e.view}">${esc(e.text)}</a>${dd===0?` <span class="pill soon">Today</span>`:""}</div></div>`;
  }).join("");
  return `
  <div class="viewhead"><h2>Timeline</h2>${seg("tlRange",[["upcoming","Upcoming"],["all","All dates"]])}</div>
  ${gantt}
  <div class="panel">${items || `<p class="empty" style="margin:0">${all.length?"Nothing coming up. Switch to All dates to see past items.":"No dates yet. Add start and finish dates to phases, inspection dates, order-by dates on selections, payment due dates and draw dates, and they'll line up here."}</p>`}</div>`;
}

function vChanges(){
  const costIds = new Set(S.costs.map(c=>c.id));
  const appr = S.changes.filter(c=>c.status==="approved"), pend = S.changes.filter(c=>c.status==="proposed");
  const sumC = a => a.reduce((s,c)=>s+(+c.cost||0),0), sumD = a => a.reduce((s,c)=>s+(+c.days||0),0);
  return `
  <div class="viewhead"><h2>Change orders</h2><button class="btn primary write" data-act="add" data-kind="changes">Add change order</button></div>
  <div class="tiles">
    <div class="tile"><div class="label">Approved changes</div><div class="v num">${signed(sumC(appr))}</div><div class="hint">${appr.length} approved</div></div>
    <div class="tile"><div class="label">Days added</div><div class="v num">${sumD(appr)}</div><div class="hint">From approved changes</div></div>
    <div class="tile"><div class="label">Waiting for decision</div><div class="v num">${pend.length}</div><div class="hint">${signed(sumC(pend))} if all approved</div></div>
  </div>
  <div class="panel" style="padding-block:2px"><div class="rows">
    ${S.changes.length ? S.changes.map(c=>{
      const inB = c.costId && costIds.has(c.costId);
      return `<div class="row"><div style="min-width:0">
        <div class="t">${c.number?`#${esc(c.number)} · `:""}${esc(c.title)}</div>
        <div class="meta">${c.date?`<span>${fmtDate(c.date)}</span>`:""}${c.requestedBy?`<span>Requested by ${esc(c.requestedBy)}</span>`:""}${phaseTitle(c.phaseId)?`<span>${esc(phaseTitle(c.phaseId))}</span>`:""}</div>
        ${c.description?`<div class="txt">${esc(c.description)}</div>`:""}
      </div><div class="side">
        ${pill(CO_CLASS[c.status]||"", CO_ST[c.status]||"Proposed")}
        ${c.cost!==null&&c.cost!==undefined&&c.cost!==""?`<span class="amt ${+c.cost<0?"neg":""}">${signed(+c.cost)}</span>`:""}
        ${+c.days?`<span class="hint">${+c.days>0?"+":""}${c.days} day${Math.abs(c.days)===1?"":"s"}</span>`:""}
        <span style="display:flex;gap:10px"><button class="iconbtn write" data-act="edit" data-kind="changes" data-id="${esc(c.id)}">Edit</button>
        ${c.status==="approved" && +c.cost ? (inB?`<span class="intag" style="padding-top:4px">In budget</span>`:`<button class="iconbtn write" data-act="coToBudget" data-id="${esc(c.id)}">Add to budget</button>`):""}</span>
      </div></div>`; }).join("")
    : `<p class="empty" style="padding:14px 0">No change orders yet. Log every change to the plans here, whether it's an upgrade, a moved wall or a contractor-found problem, with its cost and schedule impact. Get each one in writing before work starts.</p>`}
  </div></div>`;
}

function vDraws(){
  const loan = +S.project.loanAmount || 0;
  const sp = drawSpend(), f = fundingSplit();
  const funded = S.draws.filter(d=>d.status==="funded").reduce((a,d)=>a+(+d.amount||0),0);
  const spentFunded = S.draws.filter(d=>d.status==="funded").reduce((a,d)=>a+sp[d.id].spent,0);
  const waiting = S.draws.filter(d=>d.status==="requested"||d.status==="inspected");
  const scheduled = S.draws.reduce((a,d)=>a+(+d.amount||0),0);
  const onHand = funded - spentFunded;
  return `
  <div class="viewhead"><h2>Loan draws</h2><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn write" data-act="project">${loan?"Edit loan details":"Set loan amount"}</button><button class="btn primary write" data-act="add" data-kind="draws">Add draw</button></div></div>
  <div class="tiles">
    <div class="tile"><div class="label">Construction loan</div><div class="v num">${loan?money(loan):"—"}</div><div class="hint">${esc(S.project.lender||"Lender not set")}</div></div>
    <div class="tile"><div class="label">Funded</div><div class="v num">${money(funded)}</div><div class="hint">${loan?Math.round(funded/loan*100)+"% of loan":""}</div></div>
    <div class="tile"><div class="label">Spent from draws</div><div class="v num">${money(f.loan)}</div><div class="hint">Payments made with loan money</div></div>
    <div class="tile"><div class="label">Loan money on hand</div><div class="v num" style="color:${onHand<0?"var(--bad)":"inherit"}">${money(onHand)}</div><div class="hint">${onHand<0?"More paid than funded":"Funded but not spent yet"}</div></div>
    <div class="tile"><div class="label">Requested, waiting</div><div class="v num">${money(waiting.reduce((a,d)=>a+(+d.amount||0),0))}</div><div class="hint">${waiting.length} draw${waiting.length===1?"":"s"}</div></div>
    <div class="tile"><div class="label">Left to draw</div><div class="v num">${loan?money(loan-funded):"—"}</div><div class="hint">${loan && scheduled && Math.abs(scheduled-loan)>0.5 ? `Draws listed total ${money(scheduled)}` : ""}</div></div>
  </div>
  ${loan?`<div class="meter" style="margin:0 0 6px"><div style="width:${Math.min(100,f.loan/loan*100)}%;background:var(--loan)"></div><div class="paid" style="width:${Math.max(0,Math.min(100,(funded-f.loan)/loan*100))}%"></div><div class="est" style="width:${Math.min(100,waiting.reduce((a,d)=>a+(+d.amount||0),0)/loan*100)}%"></div></div>
    <div class="legend" style="margin-bottom:16px"><span style="--c:var(--loan)">Spent</span><span style="--c:var(--good)">Funded, on hand</span><span style="--c:var(--warn)">Requested</span></div>`:""}
  ${f.own ? `<p class="hint" style="margin:-4px 0 14px">Your own money paid so far: <b class="num" style="color:var(--ink)">${money(f.own)}</b>.</p>` : ""}
  <div class="panel" style="padding-block:2px"><div class="rows">
    ${S.draws.length ? S.draws.map(d=>{ const amt = +d.amount||0, spent = sp[d.id].spent, left = amt - spent;
      const warn = spent > amt + 0.004 ? `<span class="pill failed">Over by ${money(spent-amt)}</span>` : spent>0 && d.status!=="funded" ? `<span class="pill scheduled">Paying before it's funded</span>` : "";
      const ph = d.phaseId ? S.phases.find(p=>p.id===d.phaseId) : null;
      return `<div class="row"><div style="min-width:0">
        <div class="t">${esc(drawLabel(d))}</div>
        <div class="meta">${ph?`<span>Covers ${esc(ph.title)}</span>`:""}${d.targetDate?`<span>Expected ${fmtDate(d.targetDate)}</span>`:""}${d.requestedDate?`<span>Requested ${fmtDate(d.requestedDate)}</span>`:""}${d.fundedDate?`<span>Funded ${fmtDate(d.fundedDate)}</span>`:""}</div>
        ${amt||spent ? `<div class="drawuse"><div class="meter"><div style="width:${amt?Math.min(100,spent/amt*100):100}%;background:${spent>amt+0.004?"var(--bad)":"var(--loan)"}"></div></div>
          <div class="hint num">${money(spent)} spent of ${money(amt)} · ${left>=0?`${money(left)} left`:`${money(-left)} over`} · ${sp[d.id].items.length} payment${sp[d.id].items.length===1?"":"s"}</div></div>` : ""}
        ${warn ? `<div style="margin-top:6px">${warn}</div>` : ""}
        ${d.notes?`<div class="txt">${esc(d.notes)}</div>`:""}
      </div><div class="side">
        ${pill(DRAW_CLASS[d.status]||"", DRAW_ST[d.status]||"Upcoming", "drawNext", d.id)}
        <span class="amt">${money(amt)}</span>${loan&&amt?`<span class="hint">${(amt/loan*100).toFixed(0)}% of loan</span>`:""}
        <span style="display:flex;gap:12px"><button class="iconbtn" data-act="drawPacket" data-id="${esc(d.id)}">Packet</button><button class="iconbtn write" data-act="edit" data-kind="draws" data-id="${esc(d.id)}">Edit</button></span>
      </div></div>`; }).join("")
    : `<p class="empty" style="padding:14px 0">No draws yet. Copy the draw schedule from the construction loan agreement, usually tied to milestones like foundation, framing, dried-in and final. Then, when you record a payment on the Budget tab, choose which draw paid for it.</p>`}
  </div></div>
  ${S.draws.length ? `<p class="hint" style="margin-top:10px">Open a draw's packet when you request it: it lists what the money paid for, receipts and lien releases, ready to send to the lender.</p>` : ""}`;
}

/* ---------- draw packet for the lender ---------- */
function packetData(d){
  const sp = drawSpend()[d.id] || {spent:0, items:[]};
  const ph = d.phaseId ? S.phases.find(p=>p.id===d.phaseId) : null;
  const items = [...sp.items].sort((a,b)=>String(a.p.date).localeCompare(String(b.p.date)));
  const phaseCosts = ph ? S.costs.filter(c=>c.phaseId===ph.id).map(c=>({c, m:costMath(c)})) : [];
  const vend = {}; items.forEach(({c})=>{ const n=(c.vendor||"").trim(); if(n) vend[vendorKey(n)] = n; });
  const liens = Object.entries(vend).map(([k,n]) => ({name:n, ok: !!S.vendors.find(v=>v.id===k)?.lienRelease, date: S.vendors.find(v=>v.id===k)?.lienDate||""}));
  const receipts = []; const seen = new Set();
  items.forEach(({c}) => (c.receipts||[]).forEach(r => { if(r && isAsset(r.id) && !seen.has(r.id)){ seen.add(r.id); receipts.push({...r, item:c.item, vendor:c.vendor||""}); } }));
  return {sp, ph, items, phaseCosts, liens, receipts};
}
function openDrawPacket(id){
  const d = S.draws.find(x=>x.id===id); if(!d) return;
  const {sp, ph, items, phaseCosts, liens, receipts} = packetData(d);
  const amt = +d.amount||0;
  const scrim = $("#scrim"); scrim.classList.remove("lbx");
  scrim.innerHTML = `<div class="sheet wide" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
    <div class="cd-head"><div style="min-width:0"><h3 id="sheetTitle" style="margin-bottom:2px">${esc(drawLabel(d))}</h3>
      <div class="hint">${esc([S.project.lender, d.requestedDate?`Requested ${fmtDate(d.requestedDate)}`:"", d.fundedDate?`Funded ${fmtDate(d.fundedDate)}`:""].filter(Boolean).join(" · "))}</div></div>
      <span class="pill ${DRAW_CLASS[d.status]||""}">${DRAW_ST[d.status]||"Upcoming"}</span></div>
    <div class="cd-sum">
      <div><span class="label">Draw amount</span><b class="num">${money(amt)}</b></div>
      <div><span class="label">Spent from it</span><b class="num" style="color:var(--loan)">${money(sp.spent)}</b></div>
      <div><span class="label">${amt-sp.spent>=0?"Left":"Over"}</span><b class="num" style="color:${amt-sp.spent<0?"var(--bad)":"inherit"}">${money(Math.abs(amt-sp.spent))}</b></div>
    </div>
    ${ph ? `<h4 class="cd-h">Milestone: ${esc(ph.title)}</h4><p class="hint" style="margin:0">${esc(STATUS[ph.status]||"Not started")}${ph.inspection?` · ${esc(ph.inspection)} inspection: ${esc(INSP[ph.inspectionStatus||"none"])}${ph.inspectionDate?` ${fmtDate(ph.inspectionDate)}`:""}`:""}</p>` : ""}

    <h4 class="cd-h">Paid from this draw</h4>
    ${items.length ? `<div class="tablebox flat"><table class="mini"><thead><tr><th>Date</th><th>Vendor</th><th>For</th><th class="r">Amount</th></tr></thead><tbody>
      ${items.map(({c,p})=>`<tr class="clickable" data-act="costDetail" data-id="${esc(c.id)}"><td class="mono">${fmtDate(p.date)}</td><td>${esc(c.vendor||"—")}</td><td>${esc(c.item)}${p.kind==="release"?" (retainage)":""}${(c.receipts||[]).length?` <span class="rc">${(c.receipts||[]).length} receipt${(c.receipts||[]).length>1?"s":""}</span>`:""}</td><td class="r mono">${money(p.amount)}</td></tr>`).join("")}
    </tbody></table></div>` : `<p class="empty" style="margin:0">No payments assigned to this draw yet. On the Budget tab, open a cost and choose this draw under "Paid from".</p>`}

    ${phaseCosts.length ? `<h4 class="cd-h">All costs for ${esc(ph.title)}</h4><div class="tablebox flat"><table class="mini"><thead><tr><th>Item</th><th>Vendor</th><th class="r">Amount</th><th class="r">Paid</th></tr></thead><tbody>
      ${phaseCosts.map(({c,m})=>`<tr><td>${esc(c.item)}</td><td>${esc(c.vendor||"—")}</td><td class="r mono">${money(m.amt)}</td><td class="r mono">${money(m.paid)}</td></tr>`).join("")}</tbody></table></div>` : ""}

    <h4 class="cd-h">Lien releases</h4>
    ${liens.length ? `<div class="pays">${liens.map(l=>`<div class="pay"><span>${esc(l.name)}</span>${l.ok?`<span class="pill done">Received${l.date?` ${fmtDate(l.date)}`:""}</span>`:`<span class="pill failed">Missing</span>`}</div>`).join("")}</div>
      ${liens.some(l=>!l.ok) ? `<p class="hint" style="margin:6px 0 0">Lenders usually want a lien release from everyone paid. Check them off on the Vendors page once received.</p>` : ""}`
      : `<p class="empty" style="margin:0">Vendors paid from this draw will appear here.</p>`}

    <div class="foot">
      <button type="button" class="btn" id="pkCsv">Download CSV</button>
      <div class="right"><button type="button" class="btn" id="pkPrint">Print or save PDF</button><button type="button" class="btn primary" id="cdClose">Done</button></div>
    </div>
  </div>`;
  scrim.hidden = false;
  $("#cdClose").onclick = closeSheet;
  scrim.onclick = e => { if(e.target===scrim) closeSheet(); };
  $("#sheet").onkeydown = e => { if(e.key==="Escape") closeSheet(); };
  $("#pkCsv").onclick = () => exportPacketCsv(d);
  $("#pkPrint").onclick = () => printPacket(d);
}
function exportPacketCsv(d){
  const {sp, ph, items, liens} = packetData(d);
  const rows = [
    ["Draw", d.number??""], ["Milestone", d.milestone||""], ["Phase", ph?.title||""], ["Draw amount", +d.amount||0], ["Status", DRAW_ST[d.status]||""],
    ["Requested", d.requestedDate||""], ["Funded", d.fundedDate||""], ["Spent from draw", sp.spent], ["Left", (+d.amount||0)-sp.spent], [],
    ["Date","Vendor","Item","Category","Type","Amount paid","Retainage held","Paid by","Reference","Receipts"],
    ...items.map(({c,p}) => [p.date||"", c.vendor||"", c.item, catOf(c), p.kind==="release"?"Retainage release":"Payment", +p.amount||0, +p.retained||0, p.method==="Loan draw"?"":(p.method||""), p.ref||"", (c.receipts||[]).map(r=>r.name||"file").join("; ")]),
    [], ["Vendor","Lien release"], ...liens.map(l => [l.name, l.ok ? `Received ${l.date}` : "Missing"]),
  ];
  downloadCsv(`${slug(S.project.name||"house-build")}-draw-${d.number??"x"}-${today()}.csv`, rows[0], rows.slice(1));
}
async function printPacket(d){
  const w = window.open("", "_blank");
  if(!w){ showNotice("Your browser blocked the print window. Allow pop-ups for this site and try again."); return; }
  w.document.write("<p style='font-family:system-ui;padding:24px'>Preparing the draw packet…</p>");
  const {sp, ph, items, phaseCosts, liens, receipts} = packetData(d);
  let urls = {};
  if(receipts.length){ const { data } = await supabase.storage.from("files").createSignedUrls(receipts.map(r=>r.id), 7*24*3600); (data||[]).forEach(r => { if(r.signedUrl) urls[r.path] = r.signedUrl; }); }
  const e = esc, amt = +d.amount||0;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${e(S.project.name||"House build")} - ${e(drawLabel(d))}</title>
  <style>body{font:13px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0F1E2E;margin:32px;max-width:900px}
  h1{font-size:20px;margin:0 0 2px}h2{font-size:14px;margin:22px 0 6px;border-bottom:1px solid #DCE4EC;padding-bottom:4px}
  .muted{color:#5D7083}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:5px 6px;border-bottom:1px solid #EEF3F7;vertical-align:top}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#5D7083}.r{text-align:right}.num{font-variant-numeric:tabular-nums}
  .sum{display:flex;gap:28px;margin:14px 0}.sum b{display:block;font-size:17px}.bad{color:#C4433A}.ok{color:#1A8A5A}
  .rc{page-break-inside:avoid;margin:12px 0}.rc img{max-width:100%;max-height:640px;border:1px solid #DCE4EC}
  @media print{body{margin:12mm}a{color:inherit}}</style></head><body>
  <h1>${e(S.project.name||"House build")}: ${e(drawLabel(d))}</h1>
  <div class="muted">${e([S.project.address, S.project.lender?`Lender: ${S.project.lender}`:"", S.project.loanAmount?`Loan ${money(S.project.loanAmount)}`:"", `Prepared ${fmtDate(today())}`].filter(Boolean).join(" · "))}</div>
  <div class="sum num"><div><span class="muted">Draw amount</span><b>${money(amt)}</b></div><div><span class="muted">Status</span><b>${e(DRAW_ST[d.status]||"")}</b></div>
    <div><span class="muted">Spent from draw</span><b>${money(sp.spent)}</b></div><div><span class="muted">${amt-sp.spent>=0?"Left":"Over"}</span><b class="${amt-sp.spent<0?"bad":""}">${money(Math.abs(amt-sp.spent))}</b></div></div>
  ${ph?`<h2>Milestone</h2><p>${e(ph.title)}: ${e(STATUS[ph.status]||"")}${ph.inspection?`. ${e(ph.inspection)} inspection: ${e(INSP[ph.inspectionStatus||"none"])}${ph.inspectionDate?` (${fmtDate(ph.inspectionDate)})`:""}`:""}</p>`:""}
  <h2>Payments from this draw</h2>
  ${items.length?`<table class="num"><tr><th>Date</th><th>Vendor</th><th>Item</th><th>Category</th><th>Paid by</th><th>Ref.</th><th class="r">Amount</th></tr>
    ${items.map(({c,p})=>`<tr><td>${fmtDate(p.date)}</td><td>${e(c.vendor||"")}</td><td>${e(c.item)}${p.kind==="release"?" (retainage release)":""}</td><td>${e(catOf(c))}</td><td>${e(p.method==="Loan draw"?"":(p.method||""))}</td><td>${e(p.ref||"")}</td><td class="r">${money(p.amount)}</td></tr>`).join("")}
    <tr><th colspan="6">Total</th><th class="r">${money(sp.spent)}</th></tr></table>`:`<p class="muted">No payments assigned to this draw.</p>`}
  ${phaseCosts.length?`<h2>All costs for ${e(ph.title)}</h2><table class="num"><tr><th>Item</th><th>Vendor</th><th class="r">Amount</th><th class="r">Paid</th><th class="r">Still owed</th></tr>
    ${phaseCosts.map(({c,m})=>`<tr><td>${e(c.item)}</td><td>${e(c.vendor||"")}</td><td class="r">${money(m.amt)}</td><td class="r">${money(m.paid)}</td><td class="r">${money(m.balance)}</td></tr>`).join("")}</table>`:""}
  <h2>Lien releases</h2>
  ${liens.length?`<table><tr><th>Vendor</th><th>Status</th></tr>${liens.map(l=>`<tr><td>${e(l.name)}</td><td class="${l.ok?"ok":"bad"}">${l.ok?`Received${l.date?` ${fmtDate(l.date)}`:""}`:"Missing"}</td></tr>`).join("")}</table>`:`<p class="muted">None yet.</p>`}
  ${receipts.length?`<h2>Receipts and invoices</h2>${receipts.map(r=>`<div class="rc"><div><b>${e(r.vendor||"")}</b> ${e(r.item)} <span class="muted">${e(r.name||"")}</span></div>
    ${urls[r.id] ? (/^image\//.test(r.type||"") ? `<img src="${e(urls[r.id])}" alt="">` : `<a href="${e(urls[r.id])}">Open ${e(r.name||"PDF")}</a> <span class="muted">(link works for 7 days)</span>`) : `<span class="muted">File unavailable</span>`}</div>`).join("")}`:""}
  </body></html>`;
  w.document.open(); w.document.write(html); w.document.close();
  const go = () => { try { w.focus(); w.print(); } catch {} };
  const imgs = [...w.document.images]; let left = imgs.length;
  if(!left) setTimeout(go, 300); else imgs.forEach(im => { const done = () => { if(--left===0) setTimeout(go, 200); }; if(im.complete) done(); else { im.onload = done; im.onerror = done; } });
}

function vVendors(){
  const map = {};
  S.vendors.forEach(v => { map[v.id] = {name:v.name||v.id, paid:0, owed:0, held:0, n:0, due:null, doc:v}; });
  S.costs.forEach(c => { const n=(c.vendor||"").trim(); if(!n) return; const k = vendorKey(n); const m = costMath(c); const v = (map[k] ||= {name:n, paid:0, owed:0, held:0, n:0, due:null});
    v.paid += m.paid; v.held += m.held; v.owed += m.balance - m.held; v.n++; if(m.state!=="quote" && m.balance - m.held > 0 && c.due && (!v.due || c.due<v.due)) v.due = c.due; });
  let list = Object.entries(map);
  const trades = [...new Set(list.map(([,v])=>v.doc?.trade).filter(Boolean))].sort();
  if(ui.vendTrade!=="all" && !trades.includes(ui.vendTrade)) ui.vendTrade = "all";
  if(ui.vendTrade!=="all") list = list.filter(([,v])=>v.doc?.trade===ui.vendTrade);
  list.sort((a,b)=>(b[1].paid+b[1].owed)-(a[1].paid+a[1].owed) || a[1].name.localeCompare(b[1].name));
  const missing = Object.values(map).filter(v=>v.paid>0 && !v.doc?.lienRelease).length;
  const insBad = Object.values(map).filter(v=>{ const st = insState(v.doc); return st && st[0]!=="done"; }).length;
  const contactFor = n => S.contacts.find(c => slug(c.company)===slug(n) || slug(c.name)===slug(n));
  return `
  <div class="viewhead"><h2>Vendors & subs</h2><button class="btn primary write" data-act="add" data-kind="vendors">Add vendor</button></div>
  <p class="hint" style="margin:-4px 0 14px;max-width:66ch">Add the contractors, subs and suppliers you're working with, or they'll appear automatically from the vendor names on your costs. When someone is paid, ask for a signed lien release: it protects your friends if the contractor doesn't pay a sub.</p>
  ${missing?`<div class="notice">${missing} paid vendor${missing>1?"s":""} without a lien release on file.</div>`:""}
  ${insBad?`<div class="notice" style="margin-top:${missing?"8px":"0"}">${insBad} vendor${insBad>1?"s have":" has"} insurance that's expired or expiring within 30 days. Ask for a new certificate.</div>`:""}
  ${trades.length>1 ? `<div class="chips" style="margin:${missing||insBad?"14px":"0"} 0 12px" role="group" aria-label="Filter by trade"><button class="chip" data-act="ui" data-k="vendTrade" data-v="all" aria-pressed="${ui.vendTrade==="all"}">All trades</button>${trades.map(t=>`<button class="chip" data-act="ui" data-k="vendTrade" data-v="${esc(t)}" aria-pressed="${ui.vendTrade===t}">${esc(t)}</button>`).join("")}</div>` : ""}
  <div class="panel" style="padding-block:2px;${missing||insBad?"margin-top:14px":""}"><div class="rows">
    ${list.length ? list.map(([k,v])=>{ const d = v.doc||{}; const ct = contactFor(v.name); const phone = d.phone || ct?.phone; const email = d.email || ct?.email; const ins = insState(d); const nf = (d.files||[]).length;
      return `<div class="row"><div style="min-width:0">
        <div class="t">${esc(v.name)}${d.trade?` <span class="trade">${esc(d.trade)}</span>`:""}</div>
        <div class="meta">${d.contactName?`<span>${esc(d.contactName)}</span>`:""}${phone?`<span class="mono copyable">${esc(phone)}</span>`:""}${email?`<span class="copyable">${esc(email)}</span>`:""}${d.license?`<span>License ${esc(d.license)}</span>`:""}</div>
        <div class="meta">${v.n?`<span>${v.n} cost${v.n===1?"":"s"}</span>`:""}${v.due?`<span style="color:${daysTo(v.due)<=7?"var(--bad)":"inherit"}">Next payment due ${fmtDate(v.due)}</span>`:""}${d.w9==="yes"?`<span>W-9 on file</span>`:""}${nf?`<span>${nf} document${nf===1?"":"s"}</span>`:""}</div>
        ${ins?`<div style="margin-top:6px"><span class="pill ${ins[0]}">${esc(ins[1])}</span></div>`:""}
        ${d.notes?`<div class="txt">${esc(trunc(d.notes,160))}</div>`:""}
        <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;margin-top:8px">
          <label class="check"><input type="checkbox" data-act="lien" data-k="${esc(k)}" data-name="${esc(v.name)}" ${d.lienRelease?"checked":""} ${readOnly?"disabled":""}> Lien release received${d.lienDate?` · ${fmtDate(d.lienDate)}`:""}</label>
          <button class="iconbtn write" style="padding-left:0" data-act="editVendor" data-k="${esc(k)}" data-name="${esc(v.name)}">${v.doc?"Edit":"Add details"}</button>
        </div>
      </div><div class="side">
        ${v.n ? `<span class="amt">${money(v.paid)}</span><span class="hint">paid</span>
        ${v.held?`<span class="amt" style="color:var(--held)">${money(v.held)}</span><span class="hint">retainage held</span>`:""}
        ${v.owed>0.004?`<span class="amt" style="color:var(--warn)">${money(v.owed)}</span><span class="hint">owed or quoted</span>`:""}` : `<span class="hint">No costs yet</span>`}
      </div></div>`; }).join("")
    : `<p class="empty" style="padding:14px 0">${ui.vendTrade!=="all" ? "No vendors in this trade." : "No vendors yet. Tap Add vendor to save a contractor's contact details, license and insurance, or add costs with a vendor name and they'll show up here."}</p>`}
  </div></div>`;
}

function vPunch(){
  const items = S.punch.filter(p => (p.list||"punch")===ui.punchList);
  const order = {open:0, fixed:1, verified:2};
  items.sort((a,b)=>(order[a.status]??0)-(order[b.status]??0));
  const open = items.filter(p=>p.status==="open").length;
  return `
  <div class="viewhead"><h2>Punch list</h2><button class="btn primary write" data-act="add" data-kind="punch">Add item</button></div>
  <div class="toolbar">${seg("punchList",[["punch","Before move-in"],["warranty","Warranty"]])}<span class="hint">${open} open · ${items.length-open} fixed or verified</span></div>
  <div class="panel" style="padding-block:2px"><div class="rows">
    ${items.length ? items.map(p=>`<div class="row"><div style="min-width:0">
        <div class="t" style="${p.status==="verified"?"text-decoration:line-through;color:var(--muted)":""}">${esc(p.item)}</div>
        <div class="meta">${p.room?`<span>${esc(p.room)}</span>`:""}${p.assignedTo?`<span>For ${esc(p.assignedTo)}</span>`:""}${p.found?`<span>Found ${fmtDate(p.found)}</span>`:""}${p.due&&p.status==="open"?`<span style="color:${daysTo(p.due)<=3?"var(--bad)":"inherit"}">Due ${fmtDate(p.due)}</span>`:""}</div>
        ${p.notes?`<div class="txt">${esc(p.notes)}</div>`:""}${strip("punch", p)}
      </div><div class="side">
        ${pill(PUNCH_CLASS[p.status]||"", PUNCH_ST[p.status]||"Open", "punchNext", p.id)}
        <button class="iconbtn write" data-act="edit" data-kind="punch" data-id="${esc(p.id)}">Edit</button>
      </div></div>`).join("")
    : `<p class="empty" style="padding:14px 0">${ui.punchList==="punch" ? "Near the end, walk each room and list everything that needs fixing: paint touch-ups, sticky doors, missing trim. Add a photo so there's no question what you mean. Tap the status to mark it fixed, then verified once you've checked it." : "After move-in, log anything that goes wrong while the builder's warranty is active, usually the first year. Note the date you reported it."}</p>`}
  </div></div>`;
}

function vQuestions(){
  const list = S.questions.filter(q => ui.qFilter==="all" ? true : ui.qFilter==="open" ? q.status!=="answered" : q.status==="answered");
  return `
  <div class="viewhead"><h2>Questions for the contractor</h2><button class="btn primary write" data-act="add" data-kind="questions">Add question</button></div>
  <div class="toolbar">${seg("qFilter",[["open","Open"],["answered","Answered"],["all","All"]])}</div>
  <div class="panel" style="padding-block:2px"><div class="rows">
    ${list.length ? list.map(q=>`<div class="row"><div style="min-width:0">
        <div class="t" style="white-space:pre-wrap">${esc(q.question)}</div>
        <div class="meta">${q.date?`<span>Asked ${fmtDate(q.date)}</span>`:""}${q.askedBy?`<span>by ${esc(q.askedBy)}</span>`:""}${phaseTitle(q.phaseId)?`<span>${esc(phaseTitle(q.phaseId))}</span>`:""}</div>
        ${q.status==="answered"&&q.answer?`<div class="answer"><span class="label">Answer${q.answeredDate?` · ${fmtDate(q.answeredDate)}`:""}</span>${esc(q.answer)}</div>`:""}
      </div><div class="side">
        <span class="pill ${q.status==="answered"?"done":"active"}">${q.status==="answered"?"Answered":"Open"}</span>
        <button class="iconbtn write" data-act="edit" data-kind="questions" data-id="${esc(q.id)}">${q.status==="answered"?"Edit":"Add answer"}</button>
      </div></div>`).join("")
    : `<p class="empty" style="padding:14px 0">${S.questions.length?"Nothing here.":"Jot down questions between site visits, then go through them with the contractor and record the answer. It keeps a written record of what was agreed."}</p>`}
  </div></div>`;
}

function vDocuments(){
  const cats = [...new Set(S.documents.map(d=>d.category||"Other"))].sort((a,b)=>DOC_CATS.indexOf(a)-DOC_CATS.indexOf(b));
  if(ui.docCat!=="all" && !cats.includes(ui.docCat)) ui.docCat="all";
  const list = S.documents.filter(d => ui.docCat==="all" || (d.category||"Other")===ui.docCat);
  return `
  <div class="viewhead"><h2>Documents</h2><button class="btn primary write" data-act="add" data-kind="documents">Add document</button></div>
  ${cats.length>1?`<div class="chips" style="margin-bottom:14px"><button class="chip" data-act="ui" data-k="docCat" data-v="all" aria-pressed="${ui.docCat==="all"}">All</button>${cats.map(c=>`<button class="chip" data-act="ui" data-k="docCat" data-v="${esc(c)}" aria-pressed="${ui.docCat===c}">${esc(c)} · ${S.documents.filter(d=>(d.category||"Other")===c).length}</button>`).join("")}</div>`:""}
  <div class="panel" style="padding-block:4px">
    ${list.length ? list.map(d=>{
      const f = d.file && isAsset(d.file.id) ? d.file : null;
      const isImg = f && /^image\//.test(f.type||"");
      const ext = f ? ((f.type||"").includes("pdf") ? "PDF" : isImg ? "" : "FILE") : "LINK";
      const link = safeUrl(d.link);
      return `<div class="docrow">
        ${isImg ? `<button class="filetile" style="border:0;padding:0;cursor:zoom-in" data-act="photo" data-coll="documents" data-id="${esc(d.id)}" aria-label="View ${esc(d.title)}"><img src="${blob(f.id)}" data-path="${esc(f.id)}" alt="" loading="lazy"></button>` : `<div class="filetile">${ext}</div>`}
        <div class="info">
          <div class="t" style="font-weight:700">${esc(d.title)}</div>
          <div class="meta" style="font-size:.84rem;color:var(--muted);display:flex;flex-wrap:wrap;gap:2px 12px"><span>${esc(d.category||"Other")}</span>${d.date?`<span>${fmtDate(d.date)}</span>`:""}${d.vendor?`<span>${esc(d.vendor)}</span>`:""}</div>
          ${d.notes?`<div class="txt" style="font-size:.9rem;margin-top:4px;white-space:pre-wrap">${esc(d.notes)}</div>`:""}
          <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;align-items:center">
            ${f && !isImg ? `<a class="ext" href="${blob(f.id)}" data-fpath="${esc(f.id)}" target="_blank" rel="noopener">Open ${esc(trunc(f.name||"file",40))}</a>`:""}
            ${link ? `<a class="ext" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open link ↗</a>`:""}
            <button class="iconbtn write" data-act="edit" data-kind="documents" data-id="${esc(d.id)}" style="padding-left:0">Edit</button>
          </div>
        </div></div>`; }).join("")
    : `<p class="empty" style="padding:14px 0">Keep the paperwork in one place: building permit, stamped plans, the contract, signed change orders, lien releases, inspection reports, appliance manuals and warranties. Upload a PDF or photo, or paste a link to a shared file.</p>`}
  </div>`;
}
function fillAuthors(){
  document.querySelectorAll("[data-author]").forEach(e => { const n = memberName(e.dataset.author); if(n) e.textContent = "Added by " + n; });
}

function vContacts(){
  return `
  <div class="viewhead"><h2>Contacts</h2><button class="btn primary write" data-act="addContact">Add contact</button></div>
  ${S.contacts.length ? `<div class="cards">${S.contacts.map(c=>`
    <div class="card">
      <div class="role">${esc(c.role)||"Contact"}</div>
      <div class="nm">${esc(c.name)}</div>
      ${c.company?`<div style="font-size:.9rem">${esc(c.company)}</div>`:""}
      ${c.phone?`<div class="line">${esc(c.phone)}</div>`:""}
      ${c.email?`<div class="line">${esc(c.email)}</div>`:""}
      ${c.notes?`<div class="nt">${esc(c.notes)}</div>`:""}
      <button class="iconbtn write" data-act="editContact" data-id="${esc(c.id)}">Edit</button>
    </div>`).join("")}</div>`
  : `<div class="panel"><p class="empty" style="margin:0">Keep everyone in one place: general contractor, architect, County building inspector, plumber, electrician, lender, Hawaiian Electric service planner.</p></div>`}`;
}

/* ---------- forms ---------- */
const phaseOpts = () => [["","General"], ...S.phases.map(p=>[p.id,p.title])];
const vendorNames = () => [...new Set([...S.costs.map(c=>c.vendor), ...S.contacts.map(c=>c.company), ...S.vendors.map(v=>v.name)].filter(Boolean))].sort();
const FORMS = {
  selections: { title:"Selection", coll:"selections",
    post:o=>{ const p = S.phases.find(x=>x.id===o.phaseId);   // suggest an order-by date from the phase start and lead time
      if(!o.orderBy && p?.start && +o.leadWeeks){ const d = new Date(p.start+"T12:00:00"); d.setDate(d.getDate() - Math.round(+o.leadWeeks*7)); o.orderBy = d.toISOString().slice(0,10); } },
    fields:[
    {k:"item",l:"Item",full:1,req:1,ph:"e.g. Pendant lights over island"},
    {k:"room",l:"Room",list:ROOMS,ph:"e.g. Kitchen"},
    {k:"category",l:"Type",t:"select",o:CATS.map(c=>[c,c])},
    {k:"phaseId",l:"Phase",t:"select",req:1,o:()=>[["","Choose the phase it's for"], ...S.phases.map(p=>[p.id,p.title])]},
    {k:"status",l:"Status",t:"select",o:Object.entries(SEL_ST)},
    {k:"brand",l:"Brand / model",ph:"e.g. Kichler 43863"},
    {k:"finish",l:"Finish, color or size",ph:"e.g. Brushed brass, 12\""},
    {k:"vendor",l:"Where to buy",ph:"e.g. Home Depot Hilo, HPM, online"},
    {k:"price",l:"Price each ($)",t:"number"},
    {k:"qty",l:"Quantity",t:"number"},
    {k:"link",l:"Product link",t:"url",full:1,ph:"https://"},
    {k:"orderBy",l:"Order by",t:"date"},
    {k:"leadWeeks",l:"Lead time (weeks)",t:"number",ph:"Include shipping to Hilo"},
    {k:"photos",l:"Photos",t:"photos",full:1},
    {k:"deliveryDate",l:"Delivery date",t:"date",when:d=>!!d.purchase},
    {k:"serial",l:"Serial or model no.",when:d=>!!d.purchase},
    {k:"warrantyExp",l:"Warranty expires",t:"date",when:d=>!!d.purchase},
    {k:"warrantyNote",l:"Warranty details",when:d=>!!d.purchase,ph:"e.g. Register online within 30 days"},
    {k:"notes",l:"Notes",t:"textarea",full:1,ph:"Dimensions, why you like it, other options you compared…"}]},
  allowances: { title:"Allowances", single:1, path:()=>"meta/allowances", intro:"Enter the allowance for each type from the builder's contract, or your own spending target. Leave blank to skip.",
    fields: CATS.map(c=>({k:c,l:c+" ($)",t:"number"})) },
  project: { title:"Project details", single:1, path:()=>"meta/project", fields:[
    {k:"name",l:"Project name",full:1,ph:"e.g. The Kealoha house"},
    {k:"address",l:"Address or area",full:1,ph:"e.g. Kaūmana, Hilo"},
    {k:"budget",l:"Total budget ($)",t:"number"},
    {k:"sqft",l:"Living area (sq ft)",t:"number"},
    {k:"startDate",l:"Start date",t:"date"},
    {k:"targetDate",l:"Target move-in",t:"date"},
    {k:"permit",l:"County building permit no.",full:1},
    {k:"loanAmount",l:"Construction loan ($)",t:"number"},
    {k:"lender",l:"Lender"}]},
  phases: { title:"Phase", coll:"phases", fields:[
    {k:"title",l:"Phase",full:1,req:1},
    {k:"status",l:"Status",t:"select",o:Object.entries(STATUS)},
    {k:"budget",l:"Phase budget ($)",t:"number",ph:"Planned cost for this phase"},
    {k:"order",l:"Order",t:"number"},
    {k:"start",l:"Start",t:"date"},{k:"end",l:"Finish",t:"date"},
    {k:"inspection",l:"County inspection",full:1,ph:"e.g. Framing"},
    {k:"inspectionStatus",l:"Inspection status",t:"select",o:Object.entries(INSP)},
    {k:"inspectionDate",l:"Inspection date",t:"date"},
    {k:"notes",l:"Notes",t:"textarea",full:1}]},
  costs: { title:"Cost", coll:"costs", post:o=>{
      const m = costMath(o);
      if(o.status==="paid" && Array.isArray(o.payments) && o.payments.length && m.balance - m.held > 0.004)
        o.payments = [...o.payments, {id:newId(), kind:"payment", date:today(), amount:+(m.balance-m.held).toFixed(2), retained:0, ...(o.paidFrom?{source:o.paidFrom}:{}), method:"", ref:"", note:"Marked paid in full", by:me||""}];
    }, fields:[
    {k:"item",l:"What it's for",full:1,req:1,ph:"e.g. Framing labor, concrete for slab"},
    {k:"category",l:"Category",t:"select",o:()=>[["","Choose a category"], ...COST_CATS.map(c=>[c,c])]},
    {k:"vendor",l:"Vendor or sub",ph:"e.g. HPM Building Supply",list:vendorNames},
    {k:"amount",l:"Amount ($)",t:"number",req:1,ph:"Contract, quote or purchase total"},
    {k:"status",l:"Status",t:"select",o:Object.entries(COST_ST)},
    {k:"paidFrom",l:"If paid in full, paid from",t:"select",o:()=>[["","Choose when marking paid"], ["own","Own money"], ...S.draws.map(d=>["draw:"+d.id, drawLabel(d)])]},
    {k:"retainagePct",l:"Retainage held (%)",t:"number",ph:"e.g. 10, if any"},
    {k:"date",l:"Date",t:"date"},
    {k:"due",l:"Next payment due",t:"date"},
    {k:"phaseId",l:"Phase",t:"select",o:phaseOpts},
    {k:"receipts",l:"Receipts & invoices",t:"files",full:1},
    {k:"notes",l:"Notes",t:"textarea",full:1}]},
  log: { title:"Site note", coll:"log", fields:[
    {k:"date",l:"Date",t:"date",req:1},
    {k:"text",l:"What happened",t:"textarea",full:1,req:1,ph:"Framers finished the second-floor walls. Rain held up roofing two days."},
    {k:"photos",l:"Photos",t:"photos",full:1}]},
  changes: { title:"Change order", coll:"changes", fields:[
    {k:"title",l:"Change",full:1,req:1,ph:"e.g. Upgrade kitchen counters to quartz"},
    {k:"number",l:"Change order no.",t:"number"},
    {k:"status",l:"Status",t:"select",o:Object.entries(CO_ST)},
    {k:"cost",l:"Cost change ($)",t:"number",ph:"Use a minus sign for a credit"},
    {k:"days",l:"Schedule impact (days)",t:"number",ph:"0"},
    {k:"requestedBy",l:"Requested by",list:["Owner","Contractor","Architect","County inspector","Engineer"]},
    {k:"date",l:"Date",t:"date"},
    {k:"phaseId",l:"Phase",t:"select",o:phaseOpts,full:1},
    {k:"description",l:"Details",t:"textarea",full:1,ph:"What's changing, why, and what the contractor quoted."}]},
  draws: { title:"Loan draw", coll:"draws", post:o=>{ if(o.status!=="upcoming" && !o.requestedDate) o.requestedDate=today(); if(o.status==="funded" && !o.fundedDate) o.fundedDate=today(); }, fields:[
    {k:"milestone",l:"Milestone",full:1,req:1,ph:"e.g. Foundation complete"},
    {k:"phaseId",l:"Covers phase",t:"select",o:()=>[["","Not linked"], ...S.phases.map(p=>[p.id,p.title])],full:1},
    {k:"number",l:"Draw no.",t:"number"},
    {k:"amount",l:"Amount ($)",t:"number"},
    {k:"status",l:"Status",t:"select",o:Object.entries(DRAW_ST)},
    {k:"targetDate",l:"Expected",t:"date"},
    {k:"requestedDate",l:"Requested on",t:"date"},
    {k:"fundedDate",l:"Funded on",t:"date"},
    {k:"notes",l:"Notes",t:"textarea",full:1,ph:"What the lender needs: inspection, lien releases, invoices…"}]},
  punch: { title:"Punch item", coll:"punch", fields:[
    {k:"item",l:"What needs fixing",full:1,req:1,ph:"e.g. Paint scuff on hallway wall"},
    {k:"room",l:"Room",list:ROOMS},
    {k:"list",l:"List",t:"select",o:[["punch","Before move-in"],["warranty","Warranty (after move-in)"]]},
    {k:"status",l:"Status",t:"select",o:Object.entries(PUNCH_ST)},
    {k:"assignedTo",l:"Who fixes it",list:()=>S.contacts.map(c=>c.company||c.name).filter(Boolean)},
    {k:"found",l:"Found on",t:"date"},
    {k:"due",l:"Fix by",t:"date"},
    {k:"photos",l:"Photos",t:"photos",full:1},
    {k:"notes",l:"Notes",t:"textarea",full:1}]},
  questions: { title:"Question", coll:"questions", post:o=>{ if(o.status==="answered" && !o.answeredDate) o.answeredDate=today(); if(o.answer && o.status!=="answered") o.status="answered", o.answeredDate ||= today(); }, fields:[
    {k:"question",l:"Question",t:"textarea",full:1,req:1,ph:"e.g. Can the kitchen outlet move 12\" to the left before drywall?"},
    {k:"askedBy",l:"Asked by"},
    {k:"date",l:"Date",t:"date"},
    {k:"phaseId",l:"Phase",t:"select",o:phaseOpts},
    {k:"status",l:"Status",t:"select",o:[["open","Open"],["answered","Answered"]]},
    {k:"answer",l:"Answer",t:"textarea",full:1,ph:"What the contractor said. Adding an answer marks it answered."},
    {k:"answeredDate",l:"Answered on",t:"date"}]},
  vendors: { title:"Vendor", coll:"vendors",
    after: async (o, before) => {   // renaming a vendor renames it on its costs too
      const oldK = slug(before?.name), newName = o.name;
      if(!before?.name || slug(newName)===oldK) return;
      for(const c of S.costs.filter(c => slug(c.vendor)===oldK)){ const {id:cid, ...body} = c; await save(`costs/${cid}`, {...body, vendor:newName}); }
    },
    check:(o, isNew, id) => { const k = slug(o.name); const dup = S.vendors.find(v => v.id!==id && (slug(v.name)===k || v.id===k)); return dup ? `${dup.name} is already on the vendor list.` : null; },
    fields:[
    {k:"name",l:"Company or name",full:1,req:1,ph:"e.g. Big Island Framers"},
    {k:"trade",l:"Trade",list:VENDOR_TRADES,ph:"e.g. Framing"},
    {k:"contactName",l:"Contact person"},
    {k:"phone",l:"Phone",t:"tel",ph:"808-"},
    {k:"email",l:"Email",t:"email"},
    {k:"license",l:"Contractor license no.",ph:"e.g. C-12345 (Hawaiʻi DCCA)"},
    {k:"insuranceExp",l:"Insurance expires",t:"date"},
    {k:"w9",l:"W-9 on file",t:"select",o:[["","Not yet"],["yes","Yes"]]},
    {k:"files",l:"Contract, insurance certificate, W-9",t:"files",full:1,btn:"Add document"},
    {k:"notes",l:"Notes",t:"textarea",full:1,ph:"Scope of work, payment terms, how they prefer to be contacted…"}]},
  documents: { title:"Document", coll:"documents", fields:[
    {k:"title",l:"Title",full:1,req:1,ph:"e.g. Building permit"},
    {k:"category",l:"Type",t:"select",o:DOC_CATS.map(c=>[c,c])},
    {k:"date",l:"Date",t:"date"},
    {k:"vendor",l:"From",list:vendorNames,ph:"Company or person"},
    {k:"file",l:"File",t:"file",full:1},
    {k:"link",l:"Or a link",t:"url",ph:"https://"},
    {k:"notes",l:"Notes",t:"textarea",full:1}]},
  contacts: { title:"Contact", coll:"contacts", fields:[
    {k:"name",l:"Name",req:1},{k:"role",l:"Role",ph:"e.g. General contractor"},
    {k:"company",l:"Company",full:1},
    {k:"phone",l:"Phone",ph:"808-"},{k:"email",l:"Email",t:"email"},
    {k:"notes",l:"Notes",t:"textarea",full:1}]},
};

function openForm(kind, id, preset){
  if(readOnly) return;
  const F = FORMS[kind];
  const rec = F.single ? S[kind==="project"?"project":"allowances"] : (id ? S[kind].find(x=>x.id===id) : null) || preset || {};
  const isNew = !F.single && !id;
  const defaults = {phases:{status:"todo",inspectionStatus:"none",order:(S.phases.at(-1)?.order||0)+1}, costs:{status:"committed",date:today(),category:ui.costCat!=="all"&&COST_CATS.includes(ui.costCat)?ui.costCat:""}, log:{date:today()},
    selections:(()=>{ const cat = selFilter.cat!=="all"?selFilter.cat:"Lighting"; return {status:"considering",qty:1,category:cat,room:selFilter.room!=="all"&&selFilter.room!=="Unassigned"?selFilter.room:"",
      phaseId: selFilter.phase!=="all"&&selFilter.phase!=="none" ? selFilter.phase : guessPhase(cat)}; })(),
    changes:{status:"proposed",number:Math.max(0,...S.changes.map(c=>+c.number||0))+1,date:today(),requestedBy:"Owner"},
    draws:{status:"upcoming",number:Math.max(0,...S.draws.map(d=>+d.number||0))+1},
    punch:{status:"open",list:ui.punchList,found:today()},
    questions:{status:"open",date:today()},
    documents:{date:today(),category:ui.docCat!=="all"?ui.docCat:"Other"}}[kind]||{};
  const data = isNew ? defaults : rec;
  const fields = F.fields.filter(f => !f.when || f.when(data));
  let photos = [...(data.photos||[])].filter(isAsset);
  let fileObj = data.file && isAsset(data.file.id) ? {...data.file} : null;
  let files = (F.fields.find(f=>f.t==="files") ? [...(data[F.fields.find(f=>f.t==="files").k]||[])] : []).filter(r=>r && isAsset(r.id));
  const scrim = $("#scrim"); scrim.classList.remove("lbx");
  scrim.innerHTML = `<form class="sheet" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle" novalidate>
    <h3 id="sheetTitle">${F.single ? F.title : (isNew?"Add ":"Edit ")+F.title.toLowerCase()}</h3>
    ${F.intro ? `<p class="hint" style="margin:-4px 0 14px">${esc(F.intro)}</p>`:""}
    <div class="fields">${fields.map(f=>{
      const v = data[f.k] ?? ""; const idA = `f_${kind}_${f.k.replace(/[^a-z0-9]/gi,"_")}`;
      if(f.t==="photos"){
        return `<div class="field full"><span class="label">${esc(f.l)}</span><div class="thumbs" id="thumbs"></div>
          ${assets ? `<label class="btn upl" for="photoIn">Add photos<input type="file" id="photoIn" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden></label><div class="hint" id="upMsg" aria-live="polite">JPG, PNG or WebP, up to 20 MB each.</div>`
            : `<div class="hint">Photo uploads need Editor access to this page. Ask the page owner to change your access.</div>`}</div>`;
      }
      if(f.t==="files"){
        return `<div class="field full"><span class="label">${esc(f.l)}</span><div class="thumbs" id="filesBox"></div>
          <label class="btn upl" for="filesIn">${esc(f.btn||"Add receipt or invoice")}<input type="file" id="filesIn" accept="image/jpeg,image/png,image/webp,application/pdf" multiple hidden></label>
          <div class="hint" id="filesMsg" aria-live="polite">Photo or PDF, up to 20 MB each.</div></div>`;
      }
      if(f.t==="file"){
        return `<div class="field full"><span class="label">${esc(f.l)}</span><div id="fileBox"></div>
          ${assets ? `<label class="btn upl" for="fileIn"><span id="fileBtn">Upload a file</span><input type="file" id="fileIn" accept="application/pdf,image/jpeg,image/png,image/webp" hidden></label><div class="hint" id="fileMsg" aria-live="polite">PDF or photo, up to 20 MB.</div>`
            : `<div class="hint">File uploads need Editor access to this page. You can paste a link to a shared file instead.</div>`}</div>`;
      }
      const lst = typeof f.list==="function" ? f.list() : f.list;
      let ctl;
      if(f.t==="select"){ const opts = typeof f.o==="function"?f.o():f.o; ctl = `<select id="${idA}" name="${esc(f.k)}">${opts.map(([ov,ol])=>`<option value="${esc(ov)}" ${String(ov)===String(v)?"selected":""}>${esc(ol)}</option>`).join("")}</select>`; }
      else if(f.t==="textarea") ctl = `<textarea id="${idA}" name="${esc(f.k)}" placeholder="${esc(f.ph||"")}">${esc(v)}</textarea>`;
      else ctl = `<input id="${idA}" name="${esc(f.k)}" type="${f.t||"text"}" value="${esc(v)}" placeholder="${esc(f.ph||"")}" ${f.t==="number"?'inputmode="decimal" step="any"':""} ${lst?`list="${idA}_l"`:""}>${lst?`<datalist id="${idA}_l">${lst.map(o=>`<option value="${esc(o)}">`).join("")}</datalist>`:""}`;
      return `<label class="field ${f.full?"full":""}" for="${idA}"><span class="label">${esc(f.l)}${f.req?" *":""}</span>${ctl}</label>`;
    }).join("")}</div>
    <div class="err" id="formErr" hidden></div>
    <div class="foot">
      ${!isNew && !F.single ? `<button type="button" class="btn danger" id="delBtn">Delete</button>`:""}
      <div class="right"><button type="button" class="btn" id="cancelBtn">Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </div></form>`;
  scrim.hidden = false;
  const form = $("#sheet");
  const drawThumbs = () => { const t = $("#thumbs"); if(!t) return;
    t.innerHTML = photos.map((p,i)=>`<div class="thumb"><img src="${blob(p)}" data-path="${esc(p)}" alt="Photo ${i+1}"><button type="button" data-rm="${i}" aria-label="Remove photo ${i+1}">✕</button></div>`).join("");
    t.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { photos.splice(+b.dataset.rm,1); drawThumbs(); });
  };
  drawThumbs();
  const pin = $("#photoIn");
  if(pin) pin.onchange = async () => {
    const files = [...pin.files]; pin.value = ""; const msg = $("#upMsg"); let failed = "";
    for(const [n,file] of files.entries()){
      msg.textContent = `Uploading ${n+1} of ${files.length}…`;
      if(file.size > 20*1024*1024){ failed = `${file.name} is over 20 MB.`; continue; }
      try { const r = await assets.upload(file); if(isAsset(r.id)){ photos.push(r.id); drawThumbs(); } }
      catch(e){ failed = ({unsupported_type:`${file.name} isn't a supported image. Use JPG, PNG or WebP.`, too_large:`${file.name} is over 20 MB.`, quota_or_state:"Photo storage is full. Remove some old photos first.", rate_limited:"Too many uploads at once. Wait a moment and try again.", not_granted:"Photo uploads need Editor access to this page."})[e?.code] || `Couldn't upload ${file.name}. Try again.`; }
    }
    msg.textContent = failed || "Photos added. Save to keep them.";
  };
  const drawFile = () => { const b = $("#fileBox"); if(!b) return;
    if(!fileObj){ b.innerHTML = ""; if($("#fileBtn")) $("#fileBtn").textContent = "Upload a file"; return; }
    const img = /^image\//.test(fileObj.type||"");
    b.innerHTML = `<div style="display:flex;gap:12px;align-items:center"><div class="filetile">${img?`<img src="${blob(fileObj.id)}" data-path="${esc(fileObj.id)}" alt="">`:((fileObj.type||"").includes("pdf")?"PDF":"FILE")}</div><div style="min-width:0;flex:1"><div style="font-weight:600;overflow-wrap:anywhere">${esc(fileObj.name||"File")}</div>${fileObj.size?`<div class="hint">${(fileObj.size/1048576).toFixed(1)} MB</div>`:""}</div><button type="button" class="iconbtn" id="fileRm">Remove</button></div>`;
    $("#fileRm").onclick = () => { fileObj = null; drawFile(); };
    if($("#fileBtn")) $("#fileBtn").textContent = "Replace file";
  };
  drawFile();
  const drawFiles = () => { const b = $("#filesBox"); if(!b) return;
    b.innerHTML = files.map((r,i)=>`<div class="thumb">${/^image\//.test(r.type||"") ? `<img src="${blob(r.id)}" data-path="${esc(r.id)}" alt="${esc(r.name||"Receipt")}">` : `<span class="pdfmark">PDF</span>`}<button type="button" data-frm="${i}" aria-label="Remove ${esc(r.name||"file")}">✕</button></div>`).join("");
    b.querySelectorAll("[data-frm]").forEach(x => x.onclick = () => { files.splice(+x.dataset.frm,1); drawFiles(); });
  };
  drawFiles();
  const fsIn = $("#filesIn");
  if(fsIn) fsIn.onchange = async () => {
    const list = [...fsIn.files]; fsIn.value = ""; const msg = $("#filesMsg"); let failed = "";
    for(const [n,file] of list.entries()){
      msg.textContent = `Uploading ${n+1} of ${list.length}…`;
      try { const r = await assets.upload(file); files.push({id:r.id, type:r.contentType, name:String(file.name).slice(0,200), size:r.sizeBytes}); drawFiles(); }
      catch(e){ failed = uploadErr(e, file); }
    }
    msg.textContent = failed || "Added. Save to keep them.";
  };
  const fin = $("#fileIn");
  if(fin) fin.onchange = async () => {
    const file = fin.files[0]; fin.value = ""; if(!file) return; const msg = $("#fileMsg");
    if(file.size > 20*1024*1024){ msg.textContent = `${file.name} is over 20 MB.`; return; }
    msg.textContent = "Uploading…";
    try { const r = await assets.upload(file); if(isAsset(r.id)){ fileObj = {id:r.id, type:r.contentType, name:String(file.name).slice(0,200), size:r.sizeBytes}; drawFile(); msg.textContent = "Uploaded. Save to keep it."; } }
    catch(e){ msg.textContent = ({unsupported_type:"That file type isn't supported. Use a PDF, JPG, PNG or WebP.", too_large:"That file is over 20 MB.", quota_or_state:"File storage is full. Remove some old files first.", rate_limited:"Too many uploads at once. Wait a moment and try again.", not_granted:"File uploads need Editor access to this page."})[e?.code] || "Couldn't upload that file. Try again."; }
  };
  if(kind==="selections"){
    const catSel = form.elements.namedItem("category"), phSel = form.elements.namedItem("phaseId"); let phTouched = !!phSel.value && !isNew;
    phSel.addEventListener("change", () => { phTouched = true; });
    catSel.addEventListener("change", () => { if(!phTouched){ const g = guessPhase(catSel.value); if(g) phSel.value = g; } });
  }
  setTimeout(()=>form.querySelector("input:not([type=file]),textarea,select")?.focus(),0);
  const close = () => { scrim.hidden = true; scrim.innerHTML = ""; };
  $("#cancelBtn").onclick = close;
  scrim.onclick = e => { if(e.target===scrim) close(); };
  form.onkeydown = e => { if(e.key==="Escape") close(); };
  const del = $("#delBtn");
  if(del) del.onclick = async () => {
    if(!del.classList.contains("armed")){ del.classList.add("armed"); del.textContent="Tap again to delete"; return; }
    const err = await remove(`${F.coll}/${id}`); if(err){ showErr(err); } else close();
  };
  const showErr = t => { const e=$("#formErr"); e.textContent=t; e.hidden=false; };
  form.onsubmit = async e => {
    e.preventDefault();
    const out = F.single ? {...rec} : (isNew ? {} : {...rec});
    delete out.id;
    for(const f of fields){
      if(f.t==="photos"){ out[f.k] = photos; continue; }
      if(f.t==="file"){ out[f.k] = fileObj; continue; }
      if(f.t==="files"){ out[f.k] = files; continue; }
      const raw = form.elements.namedItem(f.k).value.trim();
      if(f.req && !raw){ showErr(`${f.l} is required.`); form.elements.namedItem(f.k).focus(); return; }
      if(f.t==="url" && raw && !safeUrl(raw)){ showErr("Links should be a full web address starting with https://"); form.elements.namedItem(f.k).focus(); return; }
      if(f.t==="number" && raw!=="" && isNaN(Number(raw))){ showErr(`${f.l} should be a number.`); form.elements.namedItem(f.k).focus(); return; }
      out[f.k] = f.t==="number" ? (raw==="" ? null : Number(raw)) : raw;
    }
    if(F.check){ const msg = F.check(out, isNew, id); if(msg){ showErr(msg); return; } }
    if(F.post) F.post(out);
    if(kind==="log" && isNew && me) out.author = me;
    if(isNew) out.createdAt = new Date().toISOString();
    const btn = form.querySelector('[type=submit]'); btn.disabled = true; btn.textContent = "Saving…";
    const path = F.single ? F.path() : `${F.coll}/${isNew ? newId(F.coll) : id}`;
    const err = await save(path, out);
    if(!err && kind==="project") await syncProjectName(out.name);
    if(!err && F.after) await F.after(out, rec);
    if(err){ showErr(err); btn.disabled=false; btn.textContent="Save"; } else close();
  };
}

const TEMPLATE = [
  ["Design, plans & engineering",""],
  ["County building permit (DPW Building Division)",""],
  ["Site clearing, grading & driveway",""],
  ["Wastewater system (DOH septic / IWS approval)","Septic inspection"],
  ["Water: County meter or catchment system",""],
  ["Termite soil treatment & footings","Footing"],
  ["Foundation: slab or post-and-pier","Foundation / slab"],
  ["Framing, hurricane ties & sheathing","Framing"],
  ["Roofing",""],
  ["Rough plumbing & electrical","Plumbing & electrical rough-in"],
  ["Windows, doors & siding",""],
  ["Insulation & drywall",""],
  ["Interior finishes: cabinets, flooring, paint",""],
  ["Fixtures & appliances",""],
  ["Electric service hookup (Hawaiian Electric)","Electrical final"],
  ["Final building inspection","Building final"],
  ["Move-in",""]
];
async function loadTemplate(btn){
  btn.disabled = true; btn.textContent = "Adding phases…";
  for(let i=0;i<TEMPLATE.length;i++){
    const [title, insp] = TEMPLATE[i];
    const err = await save(`phases/p${String(i+1).padStart(2,"0")}`, {title, order:i+1, status:"todo", inspection:insp, inspectionStatus:"none", createdAt:new Date().toISOString()});
    if(err){ showNotice(err); break; }
  }
}

document.addEventListener("click", async e => {
  const t = e.target.closest("[data-act]"); if(!t) return;
  const {act, id} = t.dataset;
  if(act==="fRoom"){ selFilter.room = t.dataset.v; render(); return; }
  if(act==="fCat"){ selFilter.cat = t.dataset.v; render(); return; }
  if(act==="photo"){ openLightbox(t.dataset.coll||"selections", id, t.dataset.i); return; }
  if(act==="ui"){ if(t.dataset.k==="selGroup") selFilter.group = t.dataset.v; else ui[t.dataset.k] = t.dataset.v; render(); return; }
  if(act==="selNoPhase"){ e.preventDefault(); selFilter.phase = "none"; selFilter.room = "all"; selFilter.cat = "all"; render(); return; }
  if(act==="phaseSels"){ e.preventDefault(); selFilter.phase = id; selFilter.room = "all"; selFilter.cat = "all"; selFilter.group = "room"; if(location.hash!=="#selections") location.hash = "#selections"; else render(); return; }
  if(act==="costDetail"){ openCostDetail(id); return; }
  if(act==="drawPacket"){ openDrawPacket(id); return; }
  if(act==="phaseCosts"){ e.preventDefault(); ui.costPhase = id ? id : "none"; ui.costCat = "all"; ui.costShow = "all"; ui.spendBy = "phase"; if(location.hash!=="#budget") location.hash = "#budget"; else render(); return; }
  if(act==="receiptView"){ const u = urlCache.get(t.dataset.path)?.url; if(u) window.open(u, "_blank", "noopener"); return; }
  if(act==="exportCosts"){ exportCosts(); return; }
  if(act==="exportPayments"){ exportPayments(); return; }
  if(readOnly) return;
  const advance = async (coll, map, extra) => {
    const r = S[coll].find(x=>x.id===id); if(!r) return;
    const keys = Object.keys(map); const next = keys[(keys.indexOf(r.status)+1) % keys.length];
    t.disabled = true; const {id:_, ...body} = r;
    const out = {...body, status:next}; if(extra) extra(out);
    const err = await save(`${coll}/${id}`, out); if(err){ showNotice(err); t.disabled=false; }
  };
  if(act==="add") openForm(t.dataset.kind);
  else if(act==="edit") openForm(t.dataset.kind, id);
  else if(act==="project") openForm("project");
  else if(act==="drawNext") advance("draws", DRAW_ST, o => { if(o.status==="upcoming"){ o.requestedDate=""; o.fundedDate=""; } if(o.status==="requested" && !o.requestedDate) o.requestedDate=today(); if(o.status==="funded" && !o.fundedDate) o.fundedDate=today(); });
  else if(act==="punchNext") advance("punch", PUNCH_ST);
  else if(act==="editVendor") openForm("vendors", t.dataset.k, {name: t.dataset.name});
  else if(act==="lien"){
    const k = t.dataset.k; const cur = S.vendors.find(v=>v.id===k) || {}; const {id:_, ...body} = cur;
    const err = await save(`vendors/${k}`, {...body, name: body.name || t.dataset.name, lienRelease: t.checked, lienDate: t.checked ? today() : ""});
    if(err){ showNotice(err); t.checked = !t.checked; }
  }
  else if(act==="coToBudget"){
    const c = S.changes.find(x=>x.id===id); if(!c) return;
    t.disabled = true; t.textContent = "Adding…";
    const cid = newId("costs");
    let err = await save(`costs/${cid}`, {item:`Change order${c.number?` #${c.number}`:""}: ${c.title}`, vendor:"", amount:+c.cost||0, category:"", status:"committed", date:today(), phaseId:c.phaseId||"", notes:"Added from Change orders", changeId:c.id, createdAt:new Date().toISOString()});
    if(!err){ const {id:_, ...body} = c; err = await save(`changes/${id}`, {...body, costId:cid}); }
    if(err){ showNotice(err); t.disabled=false; t.textContent="Add to budget"; }
  }
  else if(act==="addSel") openForm("selections");
  else if(act==="purchase") openPurchase(id);
  else if(act==="editSel") openForm("selections", id);
  else if(act==="allowances") openForm("allowances");
  else if(act==="toBudget"){
    const s = S.selections.find(x=>x.id===id); if(!s) return;
    t.disabled = true; t.textContent = "Adding…";
    const cid = newId("costs");
    let err = await save(`costs/${cid}`, {item: s.item + (s.room?` (${s.room})`:""), vendor: s.vendor||"", amount: selTotal(s), category: s.category==="Appliances"||s.category==="Plumbing fixtures"||s.category==="Lighting" ? "Appliances & fixtures" : "Materials", status: ["chosen","ordered","delivered","installed"].includes(s.status) ? "committed" : "estimate", date: today(), phaseId: phaseOf(s) ? s.phaseId : "", notes:"Added from Selections", selectionId: s.id, createdAt: new Date().toISOString()});
    if(!err){ const {id:_, ...body} = s; err = await save(`selections/${id}`, {...body, costId: cid}); }
    if(err){ showNotice(err); t.disabled=false; t.textContent="Add to budget"; }
  }
  else if(act==="addPhase") openForm("phases");
  else if(act==="editPhase") openForm("phases", id);
  else if(act==="addCost") openForm("costs");
  else if(act==="editCost") openForm("costs", id);
  else if(act==="payDel"){
    if(!t.classList.contains("armed")){ t.classList.add("armed"); t.textContent = "Tap again to remove"; t.style.color = "var(--bad)"; return; }
    const cur = S.costs.find(x=>x.id===id); if(!cur) return; const {id:_, ...body} = cur;
    const gone = (body.payments||[]).find(p=>p.id===t.dataset.pid);
    const err = await save(`costs/${id}`, {...body, payments:(body.payments||[]).filter(p=>p.id!==t.dataset.pid)});
    if(!err && gone?.selectionId){ const sel = S.selections.find(x=>x.id===gone.selectionId);
      if(sel?.purchase?.paymentId===gone.id){ const {id:_x, purchase, ...rest} = sel; await save(`selections/${sel.id}`, {...rest, status:"chosen"}); } }
    if(err) showNotice(err); else openCostDetail(id);
  }
  else if(act==="addLog") openForm("log");
  else if(act==="editLog") openForm("log", id);
  else if(act==="addContact") openForm("contacts");
  else if(act==="editContact") openForm("contacts", id);
  else if(act==="template") loadTemplate(t);
  else if(act==="cycle"){
    const p = S.phases.find(x=>x.id===id); if(!p) return;
    const next = {todo:"active", active:"done", done:"todo"}[p.status] || "active";
    t.disabled = true;
    const {id:_, ...body} = p;
    const err = await save(`phases/${id}`, {...body, status:next});
    if(err) showNotice(err);
  }
});
$("#editProject").addEventListener("click", ()=>openForm("project"));
document.addEventListener("change", e => { if(e.target.id==="costPhaseSel"){ ui.costPhase = e.target.value; render(); }
  if(e.target.id==="selPhaseSel"){ selFilter.phase = e.target.value; render(); } });
document.addEventListener("error", e => {
  const img = e.target; if(!(img instanceof HTMLImageElement) || img.dataset.failed) return;
  img.dataset.failed = "1"; img.removeAttribute("src"); img.alt = "Photo unavailable";
  img.style.cssText = "background:var(--sunk)";
}, true);



/* =====================================================================
   Supabase: records, files, sign-in, builds and sharing
   ===================================================================== */
let projectId = null, myRole = null, session = null, channel = null;
let me = null;
S.members = []; S.invites = []; S.projectRow = null;
const urlCache = new Map();           // storage path -> {url, exp}
const store = {};                     // collection -> Map(id -> data)
const ORDER = {phases:["order",1], costs:["date",-1], log:["date",-1], contacts:["name",1], selections:["createdAt",1],
  changes:["number",1], draws:["number",1], punch:["createdAt",1], documents:["date",-1], questions:["createdAt",-1], vendors:["name",1]};
const LAST_KEY = "hale:lastProject";
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k,v) => { try { v==null ? localStorage.removeItem(k) : localStorage.setItem(k,v); } catch {} };

const newId = () => crypto.randomUUID();
const memberName = uid => { const m = S.members.find(x=>x.user_id===uid); return m ? (m.display_name || (m.email||"").split("@")[0]) : ""; };

/* ---- local store ---- */
const cmp = (a,b) => { const ea = a===undefined||a===null||a==="", eb = b===undefined||b===null||b==="";
  if(ea||eb) return ea&&eb ? 0 : ea ? 1 : -1;
  if(typeof a==="number" && typeof b==="number") return a-b;
  return String(a).localeCompare(String(b), undefined, {numeric:true}); };
function rebuild(coll){
  if(!ORDER[coll]) return;
  const [f,dir] = ORDER[coll];
  S[coll] = [...(store[coll]||new Map()).entries()].map(([id,d])=>({...d, id}))
    .sort((a,b)=>{ const c = cmp(a[f],b[f]); return (a[f]==null||b[f]==null||a[f]===""||b[f]==="") ? c : c*dir; });
}
function applyRow(row){
  if(row.collection==="meta"){ if(row.id==="project") S.project = {...row.data}; else if(row.id==="allowances") S.allowances = {...row.data}; return; }
  (store[row.collection] ||= new Map()).set(row.id, row.data||{}); rebuild(row.collection);
}
function dropRow(coll, id){
  if(coll==="meta"){ if(id==="project") S.project = {}; if(id==="allowances") S.allowances = {}; return; }
  store[coll]?.delete(id); rebuild(coll);
}
let renderQueued = false;
function scheduleRender(){ if(renderQueued) return; renderQueued = true; requestAnimationFrame(()=>{ renderQueued = false; if(projectId) render(); }); }

/* ---- writes (same shape the views already use: "collection/id") ---- */
async function save(path, data){
  const [collection, id] = path.split("/");
  const clean = JSON.parse(JSON.stringify(data, (k,v)=> k==="id" && typeof v==="string" && v===id ? undefined : v));
  const { error } = await supabase.from("records").upsert({ project_id: projectId, collection, id, data: clean }, { onConflict: "project_id,collection,id" });
  if(error){ console.error(error); return error.code==="42501" ? "You don't have access to change this build. Ask the owner to check your invite." : "Couldn't save. Check your connection and try again."; }
  applyRow({collection, id, data: clean}); scheduleRender(); return null;
}
async function remove(path){
  const [collection, id] = path.split("/");
  const { error } = await supabase.from("records").delete().match({ project_id: projectId, collection, id });
  if(error){ console.error(error); return "Couldn't delete. Try again."; }
  dropRow(collection, id); scheduleRender(); return null;
}

/* ---- files ---- */
const EXT = {"image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif","application/pdf":"pdf"};
const assets = {
  async upload(file){
    const type = file.type || "";
    if(!EXT[type]) throw {code:"unsupported_type"};
    if(file.size > 20*1024*1024) throw {code:"too_large"};
    const path = `${projectId}/${crypto.randomUUID()}.${EXT[type]}`;
    const { error } = await supabase.storage.from("files").upload(path, file, { contentType: type, cacheControl: "31536000", upsert: false });
    if(error){ console.error(error); throw {code: /size|large/i.test(error.message) ? "too_large" : /mime|type/i.test(error.message) ? "unsupported_type" : "upstream_error"}; }
    return { id: path, contentType: type, sizeBytes: file.size };
  }
};
let hydrating = false;
async function hydrate(){
  if(hydrating || !projectId) return; hydrating = true;
  try{
    const els = [...document.querySelectorAll("[data-path],[data-fpath]")];
    const now = Date.now();
    const need = [...new Set(els.map(e=>e.dataset.path||e.dataset.fpath).filter(p => isAsset(p) && !(urlCache.get(p)?.exp > now+60000)))];
    for(let i=0;i<need.length;i+=100){
      const { data } = await supabase.storage.from("files").createSignedUrls(need.slice(i,i+100), 3600);
      (data||[]).forEach(r => { if(r.signedUrl && r.path) urlCache.set(r.path, {url:r.signedUrl, exp: now + 3600*1000}); });
    }
    document.querySelectorAll("[data-path]").forEach(e => { const u = urlCache.get(e.dataset.path)?.url; if(u && e.getAttribute("src")!==u) e.setAttribute("src", u); });
    document.querySelectorAll("[data-fpath]").forEach(e => { const u = urlCache.get(e.dataset.fpath)?.url; if(u && e.getAttribute("href")!==u) e.setAttribute("href", u); });
  } finally { hydrating = false; }
}
let hydrateTimer = null;
new MutationObserver(() => { clearTimeout(hydrateTimer); hydrateTimer = setTimeout(hydrate, 30); })
  .observe(document.body, { childList:true, subtree:true });
document.addEventListener("click", e => { const a = e.target.closest("a[data-fpath]"); if(a && a.getAttribute("href")===PIXEL){ e.preventDefault(); showNotice("The file is still loading. Try again in a moment."); } }, true);

/* ---- loading a build ---- */
async function loadAll(){
  Object.keys(store).forEach(k=>delete store[k]); S.project = {}; S.allowances = {};
  Object.keys(ORDER).forEach(k=>S[k]=[]);
  let from = 0; const page = 1000;
  for(;;){
    const { data, error } = await supabase.from("records").select("collection,id,data").eq("project_id", projectId).range(from, from+page-1);
    if(error) throw error;
    data.forEach(r => { if(r.collection==="meta") applyRow(r); else (store[r.collection] ||= new Map()).set(r.id, r.data||{}); });
    if(data.length < page) break; from += page;
  }
  Object.keys(ORDER).forEach(rebuild);
}
async function loadPeople(){
  const { data: m } = await supabase.from("project_members").select("user_id,role,email,display_name,created_at").eq("project_id", projectId).order("created_at");
  S.members = m || [];
  myRole = S.members.find(x=>x.user_id===me)?.role || null;
  const { data: inv } = await supabase.from("invites").select("email,role,created_at").eq("project_id", projectId).order("created_at");
  S.invites = inv || [];
  const { data: pr } = await supabase.from("projects").select("id,name").eq("id", projectId).maybeSingle();
  S.projectRow = pr;
}
function subscribe(){
  if(channel) supabase.removeChannel(channel);
  let wasDown = false;
  channel = supabase.channel(`records-${projectId}`)
    .on("postgres_changes", { event:"INSERT", schema:"public", table:"records", filter:`project_id=eq.${projectId}` }, p => { applyRow(p.new); scheduleRender(); })
    .on("postgres_changes", { event:"UPDATE", schema:"public", table:"records", filter:`project_id=eq.${projectId}` }, p => { applyRow(p.new); scheduleRender(); })
    .on("postgres_changes", { event:"DELETE", schema:"public", table:"records" }, p => { if(p.old?.project_id===projectId){ dropRow(p.old.collection, p.old.id); scheduleRender(); } })
    .subscribe(status => {
      if(status==="SUBSCRIBED"){ if(wasDown){ wasDown = false; refresh(); } hideNotice(); }
      else if(status==="CHANNEL_ERROR" || status==="TIMED_OUT" || status==="CLOSED"){ wasDown = true; }
    });
}
async function refresh(){ try { await loadAll(); await loadPeople(); scheduleRender(); } catch(e){ console.error(e); } }
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if(document.hidden) hiddenAt = Date.now();
  else if(projectId && Date.now()-hiddenAt > 60000) refresh();
});

async function openProject(pid){
  projectId = pid; lsSet(LAST_KEY, pid);
  showScreen("splash");
  try { await Promise.all([loadAll(), loadPeople()]); }
  catch(e){ console.error(e); projectId = null; lsSet(LAST_KEY, null); return showPicker("Couldn't open that build. It may have been removed, or your access changed."); }
  if(!myRole){ projectId = null; lsSet(LAST_KEY, null); return showPicker(); }
  subscribe();
  setRO(false);
  if(!location.hash) location.hash = "#overview";
  showScreen("app");
  render();
}

/* ---- screens ---- */
function showScreen(which){
  $("#splash").hidden = which!=="splash";
  $("#auth").hidden = which!=="auth";
  $("#picker").hidden = which!=="picker";
  $("#app").hidden = which!=="app";
  if(which!=="app"){ $("#scrim").hidden = true; $("#scrim").innerHTML = ""; }
}
const myName = () => session?.user?.user_metadata?.display_name || session?.user?.email || "";

/* sign in / sign up / forgot / reset */
let authMode = "signin";
function setAuthMode(mode, msg){
  authMode = mode;
  const t = {signin:["Sign in","Sign in"], signup:["Create your account","Create account"], forgot:["Reset your password","Send reset link"], reset:["Choose a new password","Save password"]}[mode];
  $("#authTitle").textContent = t[0]; $("#authBtn").textContent = t[1];
  $("#nameRow").hidden = mode!=="signup";
  $("#passRow").hidden = mode==="forgot";
  $("#authEmail").closest(".field").hidden = mode==="reset";
  $("#authPass").autocomplete = mode==="signin" ? "current-password" : "new-password";
  $("#authSub").textContent = mode==="signup" ? "Use the same email address your invite was sent to." : mode==="reset" ? "Pick a password with at least 8 characters." : mode==="forgot" ? "We'll email you a link to set a new password." : "Track your house build together: schedule, budget, selections and paperwork.";
  $("#toSignup").hidden = mode!=="signin"; $("#toForgot").hidden = mode!=="signin"; $("#toSignin").hidden = mode==="signin" || mode==="reset";
  $("#authErr").hidden = true; $("#authOk").hidden = !msg; if(msg) $("#authOk").textContent = msg;
}
$("#toSignup").onclick = () => setAuthMode("signup");
$("#toForgot").onclick = () => setAuthMode("forgot");
$("#toSignin").onclick = () => setAuthMode("signin");
$("#authForm").onsubmit = async e => {
  e.preventDefault();
  const email = $("#authEmail").value.trim().toLowerCase(), pass = $("#authPass").value, name = $("#authName").value.trim();
  const err = t => { $("#authErr").textContent = t; $("#authErr").hidden = false; $("#authOk").hidden = true; };
  if(authMode!=="reset" && !/^\S+@\S+\.\S+$/.test(email)) return err("Enter a valid email address.");
  if(authMode!=="forgot" && pass.length < 8) return err("Passwords need at least 8 characters.");
  if(authMode==="signup" && !name) return err("Add your name so others know who made each change.");
  const btn = $("#authBtn"); const label = btn.textContent; btn.disabled = true; btn.textContent = "One moment…";
  try{
    if(authMode==="signin"){
      const { error } = await supabase.auth.signInWithPassword({ email, password: pass });
      if(error) return err(/confirm/i.test(error.message) ? "Confirm your email first. Check your inbox for the link." : "That email and password don't match.");
    } else if(authMode==="signup"){
      const { data, error } = await supabase.auth.signUp({ email, password: pass, options: { data: { display_name: name }, emailRedirectTo: location.origin } });
      if(error) return err(error.message);
      if(!data.session) setAuthMode("signin", `Check ${email} for a confirmation link, then sign in here.`);
    } else if(authMode==="forgot"){
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
      if(error) return err(error.message);
      setAuthMode("signin", `If ${email} has an account, a reset link is on its way.`);
    } else if(authMode==="reset"){
      const { error } = await supabase.auth.updateUser({ password: pass });
      if(error) return err(error.message);
      $("#authPass").value = ""; startSignedIn();
    }
  } finally { btn.disabled = false; if(btn.textContent==="One moment…") btn.textContent = label; }
};

/* build picker */
async function showPicker(msg){
  if(channel){ supabase.removeChannel(channel); channel = null; }
  projectId = null;
  showScreen("picker");
  $("#pickErr").hidden = !msg; if(msg) $("#pickErr").textContent = msg;
  $("#pickWho").textContent = `Signed in as ${session?.user?.email||""}`;
  const { data, error } = await supabase.from("project_members").select("project_id,role,projects(name,created_at)").eq("user_id", me);
  const list = (data||[]).filter(r=>r.projects).sort((a,b)=>a.projects.name.localeCompare(b.projects.name));
  $("#pickList").innerHTML = list.map(r=>`<button class="pick" type="button" data-pid="${esc(r.project_id)}"><b>${esc(r.projects.name)}</b><span>${r.role==="owner"?"Owner":"Member"}</span></button>`).join("");
  $("#pickList").querySelectorAll("[data-pid]").forEach(b => b.onclick = () => openProject(b.dataset.pid));
  $("#pickHint").textContent = error ? "Couldn't load your builds. Check your connection." :
    list.length ? "Pick a build to open, or start a new one." :
    `No builds yet. If a friend invited you, ask them to double-check they used ${session?.user?.email}. Otherwise, start a new build below.`;
}
$("#newProject").onsubmit = async e => {
  e.preventDefault();
  const name = $("#npName").value.trim() || "House build";
  const btn = e.target.querySelector("button"); btn.disabled = true;
  const { data: pid, error } = await supabase.rpc("create_project", { p_name: name });
  btn.disabled = false;
  if(error){ $("#pickErr").textContent = "Couldn't create the build. Try again."; $("#pickErr").hidden = false; return; }
  projectId = pid;
  const now = new Date().toISOString();
  const rows = [{project_id:pid, collection:"meta", id:"project", data:{name}}].concat(
    TEMPLATE.map(([title, insp], i) => ({ project_id:pid, collection:"phases", id:`p${String(i+1).padStart(2,"0")}`, data:{title, order:i+1, status:"todo", inspection:insp, inspectionStatus:"none", createdAt:now} })));
  await supabase.from("records").upsert(rows, { onConflict:"project_id,collection,id" });
  $("#npName").value = "";
  openProject(pid);
};
$("#switchProject").onclick = () => showPicker();
document.querySelectorAll("[data-signout]").forEach(b => b.onclick = async () => { lsSet(LAST_KEY, null); await supabase.auth.signOut(); });

async function syncProjectName(name){
  if(myRole!=="owner" || !name || name===S.projectRow?.name) return;
  const { error } = await supabase.from("projects").update({ name }).eq("id", projectId);
  if(!error) S.projectRow = {...S.projectRow, name};
}

/* sharing */
function vSharing(){
  const owner = myRole==="owner";
  const initials = m => ((m.display_name||m.email||"?").trim().split(/\s+/).map(w=>w[0]).join("").slice(0,2) || "?").toUpperCase();
  return `
  <div class="viewhead"><h2>Sharing</h2></div>
  <div class="grid2">
    <div class="panel">
      <h3>People on this build</h3>
      ${S.members.map(m=>`<div class="member"><span class="avatar">${esc(initials(m))}</span>
        <div class="who"><div style="font-weight:700">${esc(m.display_name||m.email)}${m.user_id===me?` <span class="hint">(you)</span>`:""}</div><div class="hint">${esc(m.email||"")}</div></div>
        <span class="pill ${m.role==="owner"?"done":""}">${m.role==="owner"?"Owner":"Member"}</span>
        ${owner && m.user_id!==me ? `<button class="iconbtn" data-act="rmMember" data-uid="${esc(m.user_id)}">Remove</button>` : ""}
        ${!owner && m.user_id===me ? `<button class="iconbtn" data-act="rmMember" data-uid="${esc(m.user_id)}">Leave</button>` : ""}
      </div>`).join("")}
    </div>
    <div class="panel">
      <h3>Invite someone</h3>
      ${owner ? `<form class="invite-form" id="inviteForm" novalidate>
          <label class="field" for="invEmail"><span class="label">Email address</span><input id="invEmail" type="email" inputmode="email" placeholder="friend@example.com"></label>
          <button class="btn primary" type="submit">Invite</button>
        </form>
        <div class="err" id="invErr" hidden></div>
        <p class="hint" style="margin:12px 0 0">Send them the app's web address. They create an account with this same email, confirm it from their inbox, and this build appears when they sign in. Members can see and edit everything; only owners can invite or remove people.</p>
        ${S.invites.length ? `<div style="margin-top:14px"><div class="label" style="margin-bottom:4px">Waiting to join</div>${S.invites.map(i=>`<div class="member"><span class="avatar" style="background:var(--warn-soft);color:var(--warn)">@</span><div class="who"><div>${esc(i.email)}</div><div class="hint">Invited ${fmtDate(i.created_at.slice(0,10))}</div></div><button class="iconbtn" data-act="rmInvite" data-email="${esc(i.email)}">Cancel</button></div>`).join("")}</div>` : ""}`
      : `<p class="empty" style="margin:0">Only the build's owner can invite people. Ask ${esc(S.members.find(m=>m.role==="owner")?.display_name || "the owner")} to add them.</p>`}
    </div>
  </div>`;
}
document.addEventListener("submit", async e => {
  if(e.target.id!=="inviteForm") return;
  e.preventDefault();
  const email = $("#invEmail").value.trim().toLowerCase(); const errEl = $("#invErr");
  if(!/^\S+@\S+\.\S+$/.test(email)){ errEl.textContent = "Enter a valid email address."; errEl.hidden = false; return; }
  if(S.members.some(m=>(m.email||"").toLowerCase()===email)){ errEl.textContent = "That person is already on this build."; errEl.hidden = false; return; }
  const { error } = await supabase.from("invites").insert({ project_id: projectId, email });
  if(error){ errEl.textContent = error.code==="23505" ? "That email is already invited." : "Couldn't send the invite. Try again."; errEl.hidden = false; return; }
  await loadPeople(); render();
});
document.addEventListener("click", async e => {
  const t = e.target.closest("[data-act='rmMember'],[data-act='rmInvite']"); if(!t) return;
  if(!t.classList.contains("armed")){ t.classList.add("armed"); t.textContent = "Tap again to confirm"; t.style.color = "var(--bad)"; return; }
  if(t.dataset.act==="rmInvite") await supabase.from("invites").delete().match({ project_id: projectId, email: t.dataset.email });
  else {
    const { error } = await supabase.from("project_members").delete().match({ project_id: projectId, user_id: t.dataset.uid });
    if(!error && t.dataset.uid===me) return showPicker();
  }
  await loadPeople(); render();
});

/* ---- start ---- */
async function startSignedIn(){
  try {
    me = session.user.id;
    $("#whoami").textContent = myName();
    $("#menuName").textContent = session.user.user_metadata?.display_name || "Signed in";
    $("#menuEmail").textContent = session.user.email || "";
    $("#myInitials").textContent = (myName().trim().split(/[\s@.]+/).filter(Boolean).map(w=>w[0]).join("").slice(0,2) || "?").toUpperCase();
    // Supabase query builders are thenables without .catch, so errors come back in { error } instead
    const { error: invErr } = await supabase.rpc("accept_invites");
    if(invErr) console.warn("accept_invites:", invErr.message);
    if(/^#(access_token|refresh_token|type)=/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
    const last = lsGet(LAST_KEY);
    const { data, error } = await supabase.from("project_members").select("project_id").eq("user_id", me);
    if(error) throw error;
    const ids = (data||[]).map(r=>r.project_id);
    if(last && ids.includes(last)) return openProject(last);
    if(ids.length===1) return openProject(ids[0]);
    showPicker();
  } catch(e){
    console.error(e);
    showPicker("Couldn't finish signing in. Check your connection and reload the page.");
  }
}

// Expired or already-used email links come back as #error=...&error_description=...
const linkError = (() => {
  const h = new URLSearchParams(location.hash.slice(1));
  if(!h.get("error")) return null;
  history.replaceState(null, "", location.pathname + location.search);
  return /expired|invalid/i.test(h.get("error_description")||"") || h.get("error_code")==="otp_expired"
    ? "That email link has expired or was already used. If you already confirmed, just sign in. Otherwise sign up again to get a fresh link."
    : (h.get("error_description") || "That link didn't work. Try signing in.");
})();
let started = false;
supabase.auth.onAuthStateChange((event, s) => {
  session = s;
  if(event==="PASSWORD_RECOVERY"){ started = true; showScreen("auth"); setAuthMode("reset"); return; }
  if(event==="SIGNED_OUT" || !s){ started = false; projectId = null; me = null; if(channel){ supabase.removeChannel(channel); channel = null; } showScreen("auth"); setAuthMode("signin"); if(linkError && event==="INITIAL_SESSION"){ $("#authErr").textContent = linkError; $("#authErr").hidden = false; } return; }
  if((event==="SIGNED_IN" || event==="INITIAL_SESSION") && !started && authMode!=="reset"){ started = true; setTimeout(startSignedIn, 0); }
});

/* account menu */
(() => {
  const btn = $("#acctBtn"), menu = $("#acctMenu");
  const set = open => { menu.hidden = !open; btn.setAttribute("aria-expanded", String(open)); if(open) menu.querySelector("[role=menuitem]")?.focus(); };
  btn.addEventListener("click", e => { e.stopPropagation(); set(menu.hidden); });
  document.addEventListener("click", e => { if(!menu.hidden && !menu.contains(e.target)) set(false); });
  document.addEventListener("keydown", e => { if(e.key==="Escape" && !menu.hidden){ set(false); btn.focus(); } });
  menu.addEventListener("click", e => { if(e.target.closest("[data-close-menu],[data-signout]")) set(false); });
  $("#menuSwitch").addEventListener("click", () => { set(false); showPicker(); });
})();
