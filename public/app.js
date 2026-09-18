let token=null, state=null, es=null, selected=[];
const $=s=>document.querySelector(s);
function setConn(x){$("#conn").textContent=x;$("#conn").style.color=x==="Live"?"#e6edf3":"#8b949e"}
async function api(path,body){const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(d.error||"Request failed");return d}
function me(){return state?.players.find(p=>p.id===myId())}
function myId(){return state?.players.find(p=>p.name===localStorage.rfName)?.id}
function connect(s){token=s.token;state=s.state;localStorage.rfToken=token;localStorage.rfCode=state.roomCode;localStorage.rfName=localStorage.rfName||"Player 1";showApp();startStream()}
function startStream(){if(es)es.close();es=new EventSource(`/api/room/${state.roomCode}/stream?token=${encodeURIComponent(token)}`);es.onopen=()=>setConn("Live");es.onerror=()=>setConn("Reconnecting");es.onmessage=e=>{state=JSON.parse(e.data);render()}}
function showApp(){$("#landing").hidden=true;$("#app").hidden=false}
function render(){
 $("#roomCode").textContent=state.roomCode;$("#phase").textContent=state.phase;$("#modeLabel").textContent=state.mode+" / "+state.draftType;
 renderPlayers();renderRulings();renderDraft();renderLog();renderChat();
 $("#lobby").hidden=state.phase!=="lobby";$("#draftPanel").hidden=state.phase!=="draft";$("#finish").hidden=state.phase!=="finished";$("#chatPanel").hidden=state.mode!=="2v2";
}
function renderPlayers(){
 $("#players").innerHTML=state.players.map(p=>`<div class="player ${p.confirmed?"winner":""}">
 <strong>${esc(p.name)} <span class="teamtag">${p.id}${p.team?" · "+p.team:""}</span></strong>
 <span class="muted">${p.confirmed?"Configuration confirmed":"Waiting for confirmation"} · ${p.rulingsLocked?"Rulings locked":"Rulings open"}</span>
 </div>`).join("");
 const mep=me(); const coinWinner=state.coinflip;
 $("#teamChoice").hidden=!(state.mode==="2v2"&&coinWinner===mep?.id&&!state.firstTeam);
}
function renderRulings(){
 const mep=me(); if(!mep)return;
 if(!selected.length && mep.rulings?.length) selected=[...mep.rulings];
 $("#rulings").innerHTML=Object.entries(state.rulings).map(([n,r])=>`<label class="ruling"><input type="checkbox" data-ruling="${n}" ${selected.includes(n)?"checked":""}> <span><b>${n}</b> · ${r.tier} · ${r.difficulty} · ${r.cost}pt<small>${r.type} — ${esc(r.effect)}</small></span></label>`).join("");
 document.querySelectorAll("[data-ruling]").forEach(x=>x.onchange=()=>{if(x.checked){if(selected.length>=3){x.checked=false;return}selected.push(x.dataset.ruling)}else selected=selected.filter(n=>n!==x.dataset.ruling);updatePortfolio()});
 updatePortfolio();
}
function updatePortfolio(){let cost=selected.reduce((s,n)=>s+(state.rulings[n]?.cost||0),0);$("#selectedRulings").textContent=selected.join(", ")||"None";$("#cost").textContent=cost}
function renderDraft(){
 const mep=me(); if(!mep)return;
 const active=state.activePlayer===mep.id;
 $("#myTurn").textContent=active?"YOUR TURN":"Waiting";
 $("#myTurn").className="badge "+(active?"winner":"");
 $("#turnText").textContent=state.mode==="1v1"?`Round ${Math.min(state.round,5)} · ${active?"You pick now":"Opponent picks now"}`:`Pick ${Math.min(state.pickNumber,20)} / 20 · ${active?"Your turn":"Waiting for "+(state.activePlayer||"next player")}`;
 $("#towerGrid").innerHTML=state.towers.filter(t=>t!=="Farm").map(t=>`<button data-tower="${esc(t)}" ${!active||mep.towers.some(x=>x===t)||mep.towers.length>=4?"disabled":""}>${esc(t)}</button>`).join("");
 document.querySelectorAll("[data-tower]").forEach(b=>b.onclick=()=>pick(b.dataset.tower));
 $("#loadouts").innerHTML=state.players.map(p=>`<div class="loadout"><b>${esc(p.name)} <span class="teamtag">${p.id}</span></b><div>${p.towers.map(t=>`<span class="tower">${esc(t)}</span>`).join("")}</div></div>`).join("");
 if(state.phase==="finished")$("#finalLoadouts").innerHTML=$("#loadouts").innerHTML;
}
async function pick(tower){try{const d=await api(`/api/room/${state.roomCode}/action`,{token,action:state.draftType==="Close"?"commit":"pick",tower,nonce:crypto.randomUUID()});state=d}catch(e){alert(e.message)}}
function renderLog(){if(!state)return;$("#log").innerHTML=state.log.map(x=>`<div>[${String(Math.floor(x.time/60)).padStart(2,"0")}:${String(x.time%60).padStart(2,"0")}] ${esc(x.actor)} ${esc(x.action)}${x.target?" → "+esc(x.target):""}${x.result&&x.result!=="SUCCESS"?" ("+esc(x.result)+")":""}</div>`).join("");$("#log").scrollTop=$("#log").scrollHeight}
function renderChat(){if(state?.mode!=="2v2")return;const m=me();$("#chat").innerHTML=state.log.filter(x=>x.action==="CHAT" && x.result==="TEAM_ONLY").filter(x=>{const p=state.players.find(y=>y.id===x.actor);return p?.team===m?.team}).map(x=>`<div><b>${esc(x.actor)}</b>: ${esc(x.target)}</div>`).join("")}
function esc(x){return String(x).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]))}

$("#create").onclick=async()=>{try{localStorage.rfName=$("#name").value.trim()||"Player 1";const d=await api("/api/create",{name:localStorage.rfName,mode:$("#mode").value,draftType:$("#draft").value});connect(d)}catch(e){alert(e.message)}};
$("#join").onclick=async()=>{try{localStorage.rfName=$("#name").value.trim()||"Player";const d=await api("/api/join",{name:localStorage.rfName,code:$("#code").value.trim().toUpperCase()});connect(d)}catch(e){alert(e.message)}};
$("#coinflip").onclick=async()=>{try{await api(`/api/room/${state.roomCode}/action`,{token,action:"coinflip"})}catch(e){alert(e.message)}};
$("#confirm").onclick=async()=>{try{await api(`/api/room/${state.roomCode}/action`,{token,action:"confirm",value:true})}catch(e){alert(e.message)}};
$("#lockRulings").onclick=async()=>{try{if(selected.length!==3)throw Error("Choose exactly 3 rulings.");const cost=selected.reduce((s,n)=>s+state.rulings[n].cost,0);if(cost>15)throw Error("Over 15 points.");await api(`/api/room/${state.roomCode}/action`,{token,action:"rulings",rulings:selected,locked:true})}catch(e){alert(e.message)}};
document.querySelectorAll("[data-team]").forEach(b=>b.onclick=async()=>{try{await api(`/api/room/${state.roomCode}/action`,{token,action:"team",team:b.dataset.team})}catch(e){alert(e.message)}});
$("#sendChat").onclick=async()=>{const x=$("#chatInput");if(!x.value.trim())return;try{await api(`/api/room/${state.roomCode}/action`,{token,action:"chat",message:x.value.trim()});x.value=""}catch(e){alert(e.message)}};
$("#copy").onclick=()=>navigator.clipboard?.writeText(state.roomCode);
const saved=localStorage.rfCode, savedToken=localStorage.rfToken;
if(saved&&savedToken){fetch(`/api/room/${saved}/state?token=${savedToken}`).then(r=>r.ok?r.json():null).then(s=>{if(s?.ok){token=savedToken;state=s;showApp();startStream()}}).catch(()=>{})}
