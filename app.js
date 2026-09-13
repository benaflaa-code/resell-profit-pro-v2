"use strict";

const DEFAULT_FEES = {
  "eBay": { rate: 13.25, fixed: 0.30, fulfillment: 0, note: "Seller fulfilled" },
  "Amazon FBM": { rate: 15, fixed: 0, fulfillment: 0, note: "Seller fulfilled" },
  "Amazon FBA": { rate: 15, fixed: 0, fulfillment: 6.20, note: "Illustrative FBA fee" },
  "TikTok Shop": { rate: 8, fixed: 0, fulfillment: 0, note: "Seller fulfilled" },
  "Mercari": { rate: 10, fixed: 0, fulfillment: 0, note: "Editable estimate" },
  "StockX": { rate: 12, fixed: 0, fulfillment: 0, note: "Level-dependent" }
};
const STATUSES = ["Researching","Watchlist","Ready to Buy","Purchased","Listed","Sold","Rejected"];
const $ = id => document.getElementById(id);
const num = id => Math.max(0, Number($(id).value) || 0);
const money = value => new Intl.NumberFormat("en-US", { style:"currency", currency:"USD" }).format(Number.isFinite(value) ? value : 0);
const pct = value => `${(Number.isFinite(value) ? value : 0).toFixed(1)}%`;
const clamp = (v,min,max) => Math.min(max,Math.max(min,v));
const safeJSON = (key,fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };

let fees = safeJSON("rpp2_fees", DEFAULT_FEES);
let ideas = safeJSON("rpp2_ideas", []);
let comps = [];
let lastAnalysis = null;
let currentFilter = "All";

function shippingEstimate() {
  const weight = num("weight");
  const size = $("boxSize").value;
  const base = 6.45 + Math.max(0, weight - 1) * 1.35;
  const sizeAdd = size === "double" ? 4.2 : size === "shoe" ? 1.7 : 0;
  return Math.round((base + sizeAdd) * 100) / 100;
}

function snapshotInputs() {
  const ids = ["productName","productId","source","buyPrice","purchaseTax","inboundCost","salePrice","weight","boxSize","prepCost","adRate","returnRate","shippingCost","targetProfit","targetRoi","targetMargin","budget","soldCount","activeCount"];
  return Object.fromEntries(ids.map(id => [id, $(id).value]));
}

function restoreInputs(data) {
  Object.entries(data || {}).forEach(([id,value]) => { if ($(id)) $(id).value = value; });
  analyze();
}

function platformResult(name, config, overrides={}) {
  const sale = overrides.sale ?? num("salePrice");
  const buy = num("buyPrice");
  const taxRate = num("purchaseTax") / 100;
  const inbound = num("inboundCost");
  const prep = num("prepCost");
  const ship = overrides.ship ?? num("shippingCost");
  const ad = sale * num("adRate") / 100;
  const returns = sale * num("returnRate") / 100;
  const platformFee = sale * config.rate / 100 + config.fixed;
  const acquisition = buy * (1 + taxRate) + inbound + prep;
  const other = ship + ad + returns + platformFee + config.fulfillment;
  const profit = sale - acquisition - other;
  const margin = sale ? profit / sale * 100 : 0;
  const roi = acquisition ? profit / acquisition * 100 : 0;
  const targetProfit = num("targetProfit");
  const targetMargin = num("targetMargin") / 100;
  const targetRoi = num("targetRoi") / 100;
  const beforeBuy = sale - other - inbound - prep;
  const byProfit = beforeBuy - targetProfit;
  const byMargin = beforeBuy - sale * targetMargin;
  const byRoi = (sale - other - (1 + targetRoi) * (inbound + prep)) / (1 + targetRoi);
  const maxBuy = Math.max(0, Math.min(byProfit, byMargin, byRoi) / (1 + taxRate));
  return { name, sale, buy, acquisition, ship, platformFee, other, profit, margin, roi, maxBuy, config };
}

function analyze() {
  const results = Object.entries(fees).map(([name,config]) => platformResult(name,config)).sort((a,b)=>b.profit-a.profit);
  const best = results[0];
  const buy = num("buyPrice");
  const sold = num("soldCount");
  const active = num("activeCount");
  const sellThrough = sold + active ? sold / (sold + active) * 100 : 0;
  const sampleConfidence = clamp((sold + active) * 1.25, 0, 35);
  const idConfidence = $("productId").value.trim() ? 20 : 7;
  const marginConfidence = clamp(best.margin,0,25);
  const confidence = Math.round(clamp(25 + sampleConfidence + idConfidence + marginConfidence,20,96));
  const cushion = best.maxBuy - buy;
  const cushionPct = best.maxBuy ? cushion / best.maxBuy * 100 : -100;
  const targets = { profit: best.profit >= num("targetProfit"), roi: best.roi >= num("targetRoi"), margin: best.margin >= num("targetMargin") };
  let decision, reason;
  if (!num("salePrice") || !buy) { decision="BLOCKED"; reason="Add a valid buy price and expected selling price."; }
  else if (best.profit <= 0 || cushion < 0) { decision="PASS"; reason="The deal is above the safe buy price or loses money after costs."; }
  else if (targets.profit && targets.roi && targets.margin && confidence >= 70 && cushionPct >= 10) { decision="BUY"; reason="Meets all profit guardrails with room for normal price movement."; }
  else if (best.profit > 0 && (targets.profit || targets.roi) && confidence >= 52) { decision="SMALL TEST"; reason="Promising economics, but demand or price cushion warrants a limited test."; }
  else { decision="WATCH"; reason="Still profitable, but one or more guardrails are not met."; }
  const landed = Math.max(1,best.acquisition);
  const affordable = Math.max(1,Math.floor(num("budget") / landed));
  const demandUnits = sellThrough >= 45 ? 4 : sellThrough >= 25 ? 2 : 1;
  const quantity = decision === "BUY" ? Math.min(affordable,demandUnits) : decision === "SMALL TEST" ? Math.min(2,affordable) : 1;
  const score = Math.round(clamp(best.margin * .9 + best.roi * .35 + sellThrough * .25 + cushionPct * .25,0,100));
  lastAnalysis = { results,best,decision,reason,confidence,cushion,cushionPct,sellThrough,quantity,score,inputs:snapshotInputs(),comps:[...comps] };
  renderAnalysis(lastAnalysis);
  updateResearchLinks();
  return lastAnalysis;
}

function renderAnalysis(a) {
  const card = $("decisionCard");
  card.className = `decision-card ${a.decision.toLowerCase().replaceAll(" ","-")}`;
  $("decisionLabel").textContent = a.decision;
  $("confidenceLabel").textContent = `${a.confidence}% confidence`;
  $("scoreValue").textContent = a.score;
  $("decisionReason").textContent = a.reason;
  $("maxBuyValue").textContent = money(a.best.maxBuy);
  $("cushionValue").textContent = a.cushion >= 0 ? `${money(a.cushion)} cushion above this deal` : `${money(Math.abs(a.cushion))} over the safe limit`;
  $("cushionValue").className = a.cushion >= 0 ? "positive" : "negative";
  $("profitValue").textContent = money(a.best.profit);
  $("profitValue").className = a.best.profit >= 0 ? "positive" : "negative";
  $("marginValue").textContent = pct(a.best.margin);
  $("roiValue").textContent = pct(a.best.roi);
  $("quantityValue").textContent = `${a.quantity} unit${a.quantity === 1 ? "" : "s"}`;
  $("bestPlatformBadge").textContent = `Best: ${a.best.name}`;
  const risk = a.confidence >= 75 && a.cushionPct >= 10 ? "LOW RISK" : a.confidence >= 50 ? "MEDIUM RISK" : "HIGH RISK";
  $("riskBadge").textContent = risk;
  $("riskBadge").style.color = risk === "LOW RISK" ? "var(--lime)" : risk === "MEDIUM RISK" ? "var(--yellow)" : "var(--red)";
  const reasons = [
    `${a.best.name} produces the strongest projected net profit.`,
    `${pct(a.sellThrough)} 90-day sell-through from the entered comps.`,
    a.cushion >= 0 ? `${money(a.cushion)} below the maximum safe buy price.` : `${money(Math.abs(a.cushion))} above the maximum safe buy price.`,
    comps.length ? `${comps.length} manually verified comparable sale${comps.length===1?"":"s"} recorded.` : "No sold comparables recorded yet—verify demand before buying."
  ];
  $("reasonList").innerHTML = reasons.map(x=>`<li>${escapeHTML(x)}</li>`).join("");
  $("platformRows").innerHTML = a.results.map((r,i)=>`<tr class="${i===0?"best":""}"><td><span class="platform-name">${escapeHTML(r.name)}<small>${escapeHTML(r.config.note)}</small></span></td><td>${money(r.platformFee + r.config.fulfillment)}</td><td>${money(r.ship + r.config.fulfillment)}</td><td class="${r.profit>=0?"positive":"negative"}">${money(r.profit)}</td><td>${pct(r.margin)}</td><td>${pct(r.roi)}</td><td><span class="verdict">${r.profit>=num("targetProfit")?"TARGET":"CHECK"}</span></td></tr>`).join("");
  const scenarios = [
    {label:"Conservative", result:platformResult(a.best.name,a.best.config,{sale:num("salePrice")*.9,ship:num("shippingCost")*1.15})},
    {label:"Expected", result:a.best},
    {label:"Optimistic", result:platformResult(a.best.name,a.best.config,{sale:num("salePrice")*1.1,ship:num("shippingCost")*.9})}
  ];
  const scale = Math.max(...scenarios.map(s=>Math.abs(s.result.profit)),1);
  $("scenarioBars").innerHTML = scenarios.map(s=>`<div class="scenario-row"><span>${s.label}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(3,Math.abs(s.result.profit)/scale*100)}%;background:${s.result.profit>=0?"var(--orange)":"var(--red)"}"></div></div><strong class="${s.result.profit>=0?"positive":"negative"}">${money(s.result.profit)}</strong></div>`).join("");
}

function updateResearchLinks() {
  const query = $("productId").value.trim() || $("productName").value.trim();
  $("researchQuery").textContent = query || "Enter a product name or identifier.";
  const q = encodeURIComponent(query);
  $("ebaySoldLink").href = `https://www.ebay.com/sch/i.html?_nkw=${q}&LH_Sold=1&LH_Complete=1`;
  $("amazonLink").href = `https://www.amazon.com/s?k=${q}`;
  $("googleLink").href = `https://www.google.com/search?tbm=shop&q=${q}`;
  $("tiktokLink").href = `https://www.tiktok.com/search?q=${q}`;
  $("stockxLink").href = `https://stockx.com/search?s=${q}`;
}

function renderComps() {
  $("compChips").innerHTML = comps.map((v,i)=>`<button class="comp-chip" data-comp="${i}" title="Remove comparable">${money(v)} ×</button>`).join("");
  const sorted=[...comps].sort((a,b)=>a-b);
  const median=sorted.length ? (sorted[Math.floor((sorted.length-1)/2)]+sorted[Math.ceil((sorted.length-1)/2)])/2 : null;
  $("compLow").textContent=sorted.length?money(sorted[0]):"—";
  $("compMedian").textContent=median!==null?money(median):"—";
  $("compHigh").textContent=sorted.length?money(sorted.at(-1)):"—";
  analyze();
}

function persistIdeas(){ localStorage.setItem("rpp2_ideas",JSON.stringify(ideas)); $("ideaCount").textContent=ideas.length; renderIdeas(); updateActualIdeas(); }
function saveIdea(name,status,notes){
  const a=analyze();
  const idea={id:crypto.randomUUID?.() || String(Date.now()),name,status,notes,favorite:false,createdAt:new Date().toISOString(),inputs:a.inputs,comps:a.comps,analysis:{decision:a.decision,score:a.score,profit:a.best.profit,roi:a.best.roi,margin:a.best.margin,maxBuy:a.best.maxBuy,platform:a.best.name,confidence:a.confidence}};
  ideas.unshift(idea); persistIdeas(); toast("Idea saved"); return idea;
}
function renderIdeas(){
  let list=ideas.filter(x=>currentFilter==="All"||x.status===currentFilter);
  const sort=$("ideaSort")?.value||"score";
  list.sort((a,b)=>sort==="profit"?b.analysis.profit-a.analysis.profit:sort==="roi"?b.analysis.roi-a.analysis.roi:sort==="recent"?new Date(b.createdAt)-new Date(a.createdAt):b.analysis.score-a.analysis.score);
  $("ideaGrid").innerHTML=list.map(x=>`<article class="idea-card" data-id="${x.id}"><div class="card-head"><div><h3>${escapeHTML(x.name)}</h3><span class="id">${escapeHTML(x.inputs.productId||x.inputs.source||"No identifier")}</span></div><button class="favorite ${x.favorite?"on":""}" data-action="favorite" aria-label="Favorite">★</button></div><select class="status-select" data-action="status" aria-label="Idea status">${STATUSES.map(s=>`<option ${s===x.status?"selected":""}>${s}</option>`).join("")}</select><div class="idea-metrics"><div><span>SCORE</span><strong>${x.analysis.score}</strong></div><div><span>PROFIT</span><strong class="${x.analysis.profit>=0?"positive":"negative"}">${money(x.analysis.profit)}</strong></div><div><span>ROI</span><strong>${pct(x.analysis.roi)}</strong></div></div>${x.notes?`<p class="card-notes">${escapeHTML(x.notes)}</p>`:""}<div class="card-actions"><button data-action="open">Open</button><button data-action="duplicate">Duplicate</button><button data-action="delete">Delete</button></div></article>`).join("");
  $("emptyIdeas").style.display=list.length?"none":"block";
}
function updateActualIdeas(){ $("actualIdea").innerHTML=`<option value="">Manual entry</option>${ideas.map(x=>`<option value="${x.id}">${escapeHTML(x.name)}</option>`).join("")}`; }
function showView(id){ document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active",v.id===id)); document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.view===id)); window.scrollTo({top:0,behavior:"smooth"}); }
function escapeHTML(value){ return String(value).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c])); }
function toast(message){ const el=$("toast");el.textContent=message;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),2200); }

function renderFeeSettings(){ $("feeSettings").innerHTML=Object.entries(fees).map(([name,f])=>`<div class="fee-row" data-platform="${escapeHTML(name)}"><label>${escapeHTML(name)}</label><label><input class="rate" type="number" min="0" step="0.1" value="${f.rate}"> %</label><label><input class="fixed" type="number" min="0" step="0.01" value="${f.fixed}"> fixed</label></div>`).join(""); }

$("analysisForm").addEventListener("submit",e=>{e.preventDefault();analyze();toast("Analysis updated")});
$("analysisForm").addEventListener("input",()=>analyze());
$("weight").addEventListener("change",()=>{$("shippingCost").value=shippingEstimate();analyze()});
$("boxSize").addEventListener("change",()=>{$("shippingCost").value=shippingEstimate();analyze()});
document.querySelectorAll(".tab").forEach(t=>t.addEventListener("click",()=>showView(t.dataset.view)));
document.querySelectorAll("[data-go]").forEach(t=>t.addEventListener("click",()=>showView(t.dataset.go)));
$("newAnalysisButton").addEventListener("click",()=>showView("analyze"));
$("resetButton").addEventListener("click",()=>{ $("analysisForm").reset(); $("shippingCost").value=shippingEstimate(); comps=[]; renderComps(); toast("Quote reset") });
$("saveIdeaButton").addEventListener("click",()=>{ $("ideaName").value=$("productName").value.trim()||"Untitled product idea"; $("saveDialog").showModal() });
document.querySelectorAll(".close-save").forEach(b=>b.addEventListener("click",()=>$("saveDialog").close()));
$("saveForm").addEventListener("submit",e=>{e.preventDefault();saveIdea($("ideaName").value.trim(),$("ideaStatus").value,$("ideaNotes").value.trim());$("saveDialog").close()});
$("addComp").addEventListener("click",()=>{const value=num("compInput");if(value){comps.push(value);$("compInput").value="";renderComps()}});
$("compInput").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();$("addComp").click()}});
$("compChips").addEventListener("click",e=>{const b=e.target.closest("[data-comp]");if(b){comps.splice(Number(b.dataset.comp),1);renderComps()}});
$("clearComps").addEventListener("click",()=>{comps=[];renderComps()});
$("settingsButton").addEventListener("click",()=>{renderFeeSettings();$("settingsDialog").showModal()});
$("resetFees").addEventListener("click",()=>{fees=structuredClone(DEFAULT_FEES);renderFeeSettings()});
$("saveFees").addEventListener("click",()=>{document.querySelectorAll(".fee-row").forEach(row=>{fees[row.dataset.platform].rate=Number(row.querySelector(".rate").value)||0;fees[row.dataset.platform].fixed=Number(row.querySelector(".fixed").value)||0});localStorage.setItem("rpp2_fees",JSON.stringify(fees));analyze();toast("Fee assumptions saved")});
document.querySelectorAll(".filter").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll(".filter").forEach(x=>x.classList.remove("active"));b.classList.add("active");currentFilter=b.dataset.status;renderIdeas()}));
$("ideaSort").addEventListener("change",renderIdeas);
$("ideaGrid").addEventListener("click",e=>{
  const card=e.target.closest(".idea-card"); if(!card)return; const idx=ideas.findIndex(x=>x.id===card.dataset.id); if(idx<0)return; const action=e.target.dataset.action;
  if(action==="favorite"){ideas[idx].favorite=!ideas[idx].favorite;persistIdeas()}
  if(action==="open"){restoreInputs(ideas[idx].inputs);comps=[...(ideas[idx].comps||[])];renderComps();showView("analyze");toast("Idea loaded")}
  if(action==="duplicate"){const copy={...ideas[idx],id:crypto.randomUUID?.()||String(Date.now()),name:`${ideas[idx].name} copy`,createdAt:new Date().toISOString()};ideas.unshift(copy);persistIdeas();toast("Idea duplicated")}
  if(action==="delete"&&confirm(`Delete “${ideas[idx].name}”?`)){ideas.splice(idx,1);persistIdeas();toast("Idea deleted")}
});
$("ideaGrid").addEventListener("change",e=>{if(e.target.dataset.action!=="status")return;const card=e.target.closest(".idea-card");const idea=ideas.find(x=>x.id===card.dataset.id);if(idea){idea.status=e.target.value;persistIdeas();toast("Status updated")}});
$("actualIdea").addEventListener("change",()=>{const idea=ideas.find(x=>x.id===$("actualIdea").value);if(!idea)return;$("actualSale").value=idea.inputs.salePrice;$("actualBuy").value=(Number(idea.inputs.buyPrice)*(1+Number(idea.inputs.purchaseTax)/100)+Number(idea.inputs.inboundCost)+Number(idea.inputs.prepCost)).toFixed(2);const result=idea.analysis;const selected=Object.values(fees).find((_,i)=>Object.keys(fees)[i]===result.platform);const rate=selected?.rate||0;$("actualFees").value=(Number(idea.inputs.salePrice)*rate/100+(selected?.fixed||0)+(selected?.fulfillment||0)).toFixed(2);$("actualShipping").value=idea.inputs.shippingCost;$("forecastProfit").value=result.profit.toFixed(2);$("actualForm").requestSubmit()});
$("actualForm").addEventListener("submit",e=>{e.preventDefault();const profit=num("actualSale")-num("actualBuy")-num("actualFees")-num("actualShipping")-num("actualOther");const forecast=Number($("forecastProfit").value)||0;const variance=profit-forecast;$("actualProfit").textContent=money(profit);$("actualProfit").className=profit>=0?"positive":"negative";$("varianceValue").textContent=`${variance>=0?"+":""}${money(variance)}`;$("varianceValue").className=variance>=0?"positive":"negative";$("varianceText").textContent=variance>=0?"The sale beat the forecast.":"The sale missed the forecast—review the largest cost difference."});

function registerWebMCP(){
  const ctx=document.modelContext;if(!ctx?.registerTool)return;
  const register=tool=>{try{void Promise.resolve(ctx.registerTool(tool)).catch(()=>{})}catch{}}
  register({name:"analyze_resale_quote",title:"Analyze resale quote",description:"Fill the visible calculator with a resale quote and return its current best marketplace and profit decision.",inputSchema:{type:"object",properties:{productName:{type:"string"},buyPrice:{type:"number",minimum:0},salePrice:{type:"number",minimum:0},weight:{type:"number",minimum:.1}},required:["productName","buyPrice","salePrice"],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute(input){if(!input||typeof input.productName!=="string"||!Number.isFinite(input.buyPrice)||!Number.isFinite(input.salePrice))throw new Error("Valid productName, buyPrice, and salePrice are required");$("productName").value=input.productName;$("buyPrice").value=input.buyPrice;$("salePrice").value=input.salePrice;if(Number.isFinite(input.weight))$("weight").value=input.weight;const a=analyze();return{decision:a.decision,bestPlatform:a.best.name,netProfit:Number(a.best.profit.toFixed(2)),roi:Number(a.best.roi.toFixed(1)),maximumBuyPrice:Number(a.best.maxBuy.toFixed(2))}}});
  register({name:"save_product_idea",title:"Save product idea",description:"Save the calculator's current quote to the visible Product Idea Book.",inputSchema:{type:"object",properties:{name:{type:"string",minLength:1},status:{type:"string",enum:STATUSES},notes:{type:"string"}},required:["name"],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute(input){if(!input?.name?.trim())throw new Error("A name is required");const idea=saveIdea(input.name.trim(),STATUSES.includes(input.status)?input.status:"Researching",input.notes||"");return{id:idea.id,name:idea.name,status:idea.status,decision:idea.analysis.decision}}});
  register({name:"list_product_ideas",title:"List product ideas",description:"List saved Product Idea Book entries with their decision metrics.",inputSchema:{type:"object",properties:{status:{type:"string",enum:STATUSES}},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:false},execute(input){return ideas.filter(x=>!input?.status||x.status===input.status).map(x=>({id:x.id,name:x.name,status:x.status,decision:x.analysis.decision,profit:Number(x.analysis.profit.toFixed(2)),roi:Number(x.analysis.roi.toFixed(1))}))}});
}

$("shippingCost").value=shippingEstimate();
$("ideaCount").textContent=ideas.length;
renderIdeas(); updateActualIdeas(); renderComps(); analyze(); registerWebMCP();
