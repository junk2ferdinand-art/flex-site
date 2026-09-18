const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const rooms = new Map();

const TOWERS = [
  "Scout","Fragger","Sniper","Shotgunner","Cryo-Gunner","Farm","Soldier","Tuber",
  "Mortar","Patrol","Enforcer","Barracks","Aviator","Flamethrower","Mercenary",
  "Marksman","Commando","Commander","Anarchist","DJ","Railgunner","Plasma Trooper",
  "Phaser","Zed","Scarecrow","Elf","Hallowboomer","Red Scout","Archer","Stunner",
  "Sleeter","Huntsman","Tweeter","Red Sniper","Resting Soldier","Graveyard","Monkey",
  "Snowballer","Harpoon Hunter","Patrioteer","Poopi","Knifer","Ice Cream",
  "Golden Scout","Golden Commando"
];

const RULINGS = {
  Pass:{tier:"Core",difficulty:"Easy",cost:1,type:"Normal",effect:"Decline priority; store 1 action (max 1)."},
  Change:{tier:"Core",difficulty:"Easy",cost:1,type:"Normal",effect:"Replace one of your selected towers with another legal tower."},
  Bounty:{tier:"Core",difficulty:"Easy",cost:1,type:"Conditional",effect:"Mark a tower; if the opponent picks it, trigger the configured reward."},
  Probe:{tier:"Core",difficulty:"Moderate",cost:2,type:"Situational",effect:"Reveal one hidden opponent selection."},
  Hide:{tier:"Core",difficulty:"Moderate",cost:2,type:"Normal",effect:"Conceal one of your selections. Hidden is not protected."},
  Turn:{tier:"Core",difficulty:"Moderate",cost:2,type:"Rotational",effect:"Transfer priority for the next pick to you."},
  Veto:{tier:"Core",difficulty:"Curse",cost:7,type:"Conditional",effect:"Cancel an opponent's currently resolving ruling. Cannot itself be Veto'd."},
  Cloak:{tier:"Advance",difficulty:"Hard",cost:3,type:"Normal",effect:"Conceal broader information such as category/cost tier; does not protect."},
  Rebel:{tier:"Advance",difficulty:"Hard",cost:3,type:"Conditional",effect:"Reverse a Force or Steal that just resolved."},
  Anchor:{tier:"Advance",difficulty:"Hard",cost:3,type:"Situational",effect:"Make one tower immune to removal/transfer for one round."},
  Graft:{tier:"Advance",difficulty:"Insane",cost:4,type:"Rotational",effect:"Copy the opponent's last ruling; cannot recursively copy Graft."},
  Trade:{tier:"Advance",difficulty:"Insane",cost:4,type:"Optional",effect:"Exchange one of your towers for one opponent tower; both must be known."},
  Sacrifice:{tier:"Advance",difficulty:"Insane",cost:4,type:"Conditional",effect:"Give up one of your towers to prevent the current ruling."},
  Recall:{tier:"Advance",difficulty:"Extreme",cost:5,type:"Additional",effect:"Recover a previously removed, stolen, or evicted tower."},
  Redirect:{tier:"Rogue",difficulty:"Extreme",cost:5,type:"Situational",effect:"Change the target of an opponent's ruling to another legal target."},
  Freeze:{tier:"Rogue",difficulty:"Extreme",cost:5,type:"Divisional",effect:"Prevent one ruling type for one round."},
  Secure:{tier:"Rogue",difficulty:"Severe",cost:6,type:"Normal",effect:"Protect one tower from Ban, Evict, Force, and Steal."},
  Force:{tier:"Rogue",difficulty:"Severe",cost:6,type:"Divisional",effect:"Opponent's next legal selection becomes the tower you choose."},
  Evict:{tier:"Rogue",difficulty:"Severe",cost:6,type:"Normal",effect:"Remove an opponent's already-selected tower."},
  Ban:{tier:"Rogue",difficulty:"Curse",cost:7,type:"Normal",effect:"Permanently remove a legal tower from the opponent's pool."},
  Steal:{tier:"Rogue",difficulty:"Curse",cost:7,type:"Divisional",effect:"Transfer an opponent's selected tower; victim gets one replacement."}
};

function json(res, code, data){
  res.writeHead(code, {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
  res.end(JSON.stringify(data));
}
function body(req){
  return new Promise((resolve,reject)=>{
    let b=""; req.on("data",c=>{b+=c; if(b.length>1e6) req.destroy();});
    req.on("end",()=>{try{resolve(b?JSON.parse(b):{});}catch(e){reject(e);}});
    req.on("error",reject);
  });
}
function id(n=5){return crypto.randomBytes(n).toString("base64url").slice(0,n).toUpperCase();}
function hash(value){return crypto.createHash("sha256").update(value).digest("hex");}
function broadcast(room){
  const snap = publicState(room);
  const payload = "data: "+JSON.stringify(snap)+"\n\n";
  for(const res of room.clients) res.write(payload);
}
function log(room, actor, action, target="", result="SUCCESS"){
  const t = Math.floor((Date.now()-room.startedAt)/1000);
  room.log.push({time:t, actor, action, target, result});
}
function playerByToken(room, token){ return room.players.find(p=>p.token===token); }
function teamPlayers(room, team){ return room.players.filter(p=>p.team===team); }
function publicPlayer(p, viewer, room){
  const sameTeam = viewer && p.team && viewer.team===p.team;
  const isSelf = viewer && p.token===viewer.token;
  const revealed = room.phase==="finished" || room.rulingsRevealed;
  return {
    id:p.id,name:p.name,role:p.role,team:p.team,
    confirmed:p.confirmed,rulingsLocked:p.rulingsLocked,
    points:p.rulings.reduce((s,r)=>s+(RULINGS[r]?.cost||0),0),
    rulings: (isSelf || sameTeam || revealed) ? p.rulings : p.rulings.map(()=> "SEALED"),
    towers: (isSelf || sameTeam || room.phase==="finished") ? p.towers : p.towers.map(x=>x.hidden?"HIDDEN":x.name),
    hiddenCount:p.towers.filter(x=>x.hidden).length
  };
}
function publicState(room, token){
  const viewer=playerByToken(room,token);
  return {
    ok:true,roomCode:room.code,mode:room.mode,draftType:room.draftType,
    phase:room.phase,players:room.players.map(p=>publicPlayer(p,viewer,room)),
    firstTeam:room.firstTeam, coinflip:room.coinflip,
    activePlayer:room.activePlayer, round:room.round, pickNumber:room.pickNumber,
    draftOrder:room.draftOrder, rulingsRevealed:room.rulingsRevealed,
    restrictions:room.restrictions, log:room.log.slice(-80),
    towers:TOWERS, rulings:RULINGS,
    message:room.message || "",
    commitments:room.commitments.map(c=>({playerId:c.playerId,commitment:c.commitment,round:c.round})),
    winner:room.winner || null
  };
}
function currentPicker(room){
  if(room.mode==="1v1"){
    const order = room.firstPickerIsP1 ? ["P1","P2","P2","P1","P1"] : ["P2","P1","P1","P2","P2"];
    return order[room.round-1];
  }
  return room.draftOrder[room.pickNumber-1] || null;
}
function validatePortfolio(names){
  if(!Array.isArray(names)||names.length!==3) return "Choose exactly 3 rulings.";
  const points=names.reduce((s,n)=>s+(RULINGS[n]?.cost||999),0);
  if(names.some(n=>!RULINGS[n])) return "Unknown ruling.";
  if(points>15) return "Portfolio exceeds the 15-point budget.";
  return null;
}
function beginDraft(room){
  room.phase="draft";
  room.round=1; room.pickNumber=1;
  if(room.mode==="1v1"){
    room.activePlayer=currentPicker(room);
  } else {
    room.draftOrder = room.firstTeam==="Blue"
      ? ["B1","B2","R1","R2","R1","R2","B1","B2","B1","B2","R1","R2","R1","R2","B1","B2","R1","R2","B1","B2"]
      : ["B1","B2","R1","R2","R1","R2","B1","B2","B1","B2","R1","R2","R1","R2","B1","B2","R1","R2","B1","B2"];
    room.activePlayer=currentPicker(room);
  }
  log(room,"SYSTEM","DRAFT_START");
  broadcast(room);
}
function tryBegin(room){
  const needed=room.mode==="1v1"?2:4;
  if(room.players.length===needed && room.players.every(p=>p.confirmed) && room.players.every(p=>p.rulingsLocked)){
    room.rulingsRevealed=true;
    beginDraft(room);
  }
}
function legalTower(room,p,name){
  if(name==="Farm") return false;
  if(!TOWERS.includes(name)) return false;
  if(p.towers.some(t=>t.name===name)) return false;
  if(room.mode==="1v1"){
    // Farm is auto-included; four free slots.
    if(p.towers.length>=4) return false;
  } else {
    if(p.towers.length>=4) return false;
  }
  if(room.restrictions.includes("No Cliff") && ["Sniper","Mortar","Red Sniper","Harpoon Hunter","Railgunner"].includes(name)) return false;
  return true;
}
function publicTowerState(p){
  return p.towers.map(t=>({name:t.name,hidden:!!t.hidden,commitment:t.commitment||null}));
}
function chooseTower(room,p,name,nonce){
  if(!legalTower(room,p,name)) return "Illegal tower selection.";
  if(room.mode==="2v2" && p.id!==room.activePlayer) return "Not your turn.";
  if(room.mode==="1v1" && p.id!==room.activePlayer) return "Not your turn.";
  const tower={name,hidden:false,nonce:nonce||null,commitment:null};
  p.towers.push(tower);
  room.pickNumber++;
  if(room.mode==="1v1"){
    room.round++;
    if(room.round<=5) room.activePlayer=currentPicker(room);
    else finishDraft(room);
  } else {
    room.activePlayer=currentPicker(room);
    if(room.pickNumber>20) finishDraft(room);
  }
  log(room,p.id,"PICK",name);
  broadcast(room);
}
function finishDraft(room){
  room.phase="finished";
  room.activePlayer=null;
  room.round=5;
  room.players.forEach(p=>p.towers.unshift({name:"Farm",hidden:false,nonce:null,commitment:null}));
  room.message="Draft complete. Loadouts are ready for the Tower Battles match.";
  log(room,"SYSTEM","DRAFT_COMPLETE");
  broadcast(room);
}

function createRoom(mode,draftType,name){
  const code=id(5);
  const room={
    code,mode,draftType:draftType==="Close"?"Close":"Open",
    players:[],clients:new Set(),phase:"lobby",coinflip:null,firstTeam:null,
    firstPickerIsP1:true,activePlayer:null,round:0,pickNumber:1,draftOrder:[],
    rulingsRevealed:false,restrictions:[],log:[],commitments:[],startedAt:Date.now(),
    message:"Waiting for opponent(s)."
  };
  const token=crypto.randomBytes(24).toString("hex");
  room.players.push({id:mode==="2v2"?"B1":"P1",role:"King",team:mode==="2v2"?"Blue":null,name:name||"Player 1",token,confirmed:false,rulings:[],rulingsLocked:false,towers:[]});
  rooms.set(code,room);
  return {room,token};
}

const server=http.createServer(async (req,res)=>{
  try{
    const u=new URL(req.url,`http://${req.headers.host||"localhost"}`);
    if(u.pathname==="/api/create" && req.method==="POST"){
      const b=await body(req);
      const {mode="1v1",draftType="Open",name="Player 1"}=b;
      if(!["1v1","2v2"].includes(mode)) return json(res,400,{error:"Invalid mode"});
      const {room,token}=createRoom(mode,draftType,name);
      return json(res,200,{code:room.code,token,state:publicState(room,token)});
    }
    if(u.pathname==="/api/join" && req.method==="POST"){
      const b=await body(req); const room=rooms.get(String(b.code||"").toUpperCase());
      if(!room) return json(res,404,{error:"Room not found."});
      const max=room.mode==="2v2"?4:2;
      if(room.players.length>=max) return json(res,409,{error:"Room is full."});
      if(room.phase!=="lobby") return json(res,409,{error:"Match already started."});
      const idx=room.players.length;
      const p = room.mode==="1v1"
        ? {id:"P2",role:"Queen",team:null}
        : ({id:["B2","R1","R2"][idx-1],role:idx===1?"Queen":"Queen",team:idx<=1?"Blue":"Red"});
      const token=crypto.randomBytes(24).toString("hex");
      room.players.push({...p,name:b.name||p.id,token,confirmed:false,rulings:[],rulingsLocked:false,towers:[]});
      room.message=`${room.players.at(-1).name} joined.`;
      broadcast(room);
      return json(res,200,{code:room.code,token,state:publicState(room,token)});
    }
    const m=u.pathname.match(/^\/api\/room\/([A-Z0-9]+)\/state$/);
    if(m && req.method==="GET"){
      const room=rooms.get(m[1]); if(!room) return json(res,404,{error:"Room not found."});
      return json(res,200,publicState(room,u.searchParams.get("token")||""));
    }
    const s=u.pathname.match(/^\/api\/room\/([A-Z0-9]+)\/stream$/);
    if(s && req.method==="GET"){
      const room=rooms.get(s[1]); if(!room){res.writeHead(404);return res.end();}
      res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache","Connection":"keep-alive","Access-Control-Allow-Origin":"*"});
      room.clients.add(res);
      res.write("data: "+JSON.stringify(publicState(room,u.searchParams.get("token")||""))+"\n\n");
      req.on("close",()=>room.clients.delete(res));
      return;
    }
    const a=u.pathname.match(/^\/api\/room\/([A-Z0-9]+)\/action$/);
    if(a && req.method==="POST"){
      const room=rooms.get(a[1]); if(!room) return json(res,404,{error:"Room not found."});
      const b=await body(req); const p=playerByToken(room,b.token);
      if(!p) return json(res,403,{error:"Invalid player token."});
      const act=b.action;
      if(act==="coinflip"){
        if(room.phase!=="lobby") return json(res,409,{error:"Too late."});
        room.coinflip=crypto.randomInt(0,2)===0 ? room.players[0].id : room.players[Math.min(1,room.players.length-1)].id;
        if(room.mode==="1v1"){
          room.firstPickerIsP1=room.coinflip==="P1";
        } else {
          room.firstTeam=p.team || "Blue";
        }
        log(room,"SYSTEM","COINFLIP",room.coinflip);
        broadcast(room); return json(res,200,publicState(room,p.token));
      }
      if(act==="team"){
        if(room.mode!=="2v2"||room.phase!=="lobby") return json(res,400,{error:"Team choice unavailable."});
        if(room.coinflip!==p.id) return json(res,403,{error:"Only the coinflip winner chooses the team."});
        if(!["Blue","Red"].includes(b.team)) return json(res,400,{error:"Invalid team."});
        // Reassign teams/IDs according to selected side.
        const current = room.players.map(x=>x);
        room.firstTeam=b.team;
        if(b.team==="Blue"){
          current.forEach((x,i)=>{x.team=i<2?"Blue":"Red"; x.id=["B1","B2","R1","R2"][i];});
        } else {
          current.forEach((x,i)=>{x.team=i>=2?"Blue":"Red"; x.id=["R1","R2","B1","B2"][i];});
          // Re-sort by fixed IDs for UI only.
          room.players=current;
        }
        broadcast(room); return json(res,200,publicState(room,p.token));
      }
      if(act==="confirm"){
        if(room.phase!=="lobby") return json(res,409,{error:"Configuration already locked."});
        p.confirmed=!!b.value;
        room.message=`${p.name} ${p.confirmed?"confirmed":"unconfirmed"} configuration.`;
        tryBegin(room); broadcast(room); return json(res,200,publicState(room,p.token));
      }
      if(act==="rulings"){
        if(room.phase!=="lobby") return json(res,409,{error:"Ruling selection is closed."});
        const err=validatePortfolio(b.rulings); if(err) return json(res,400,{error:err});
        p.rulings=b.rulings; p.rulingsLocked=!!b.locked;
        room.message=`${p.name} ${p.rulingsLocked?"locked":"edited"} their ruling portfolio.`;
        tryBegin(room); broadcast(room); return json(res,200,publicState(room,p.token));
      }
      if(act==="pick"){
        if(room.phase!=="draft") return json(res,409,{error:"Draft is not active."});
        const err=chooseTower(room,p,b.tower,b.nonce);
        if(err) return json(res,400,{error:err});
        return json(res,200,publicState(room,p.token));
      }
      if(act==="commit"){
        if(room.phase!=="draft") return json(res,409,{error:"Draft is not active."});
        if(p.id!==room.activePlayer) return json(res,403,{error:"Not your turn."});
        if(!b.tower||!b.nonce) return json(res,400,{error:"Tower and nonce required."});
        if(!legalTower(room,p,b.tower)) return json(res,400,{error:"Illegal tower."});
        const commitment=hash(`${b.tower}:${b.nonce}:${room.code}`);
        room.commitments.push({playerId:p.id,commitment,round:room.round});
        chooseTower(room,p,b.tower,b.nonce);
        return json(res,200,publicState(room,p.token));
      }
      if(act==="reveal"){
        const target=room.players.find(x=>x.id===b.playerId);
        if(!target) return json(res,404,{error:"Player not found."});
        for(const t of target.towers){
          if(t.hidden && t.nonce){
            t.hidden=false;
            const expected=hash(`${t.name}:${t.nonce}:${room.code}`);
            t.verified=(target.towers.find(x=>x===t)?.commitment||expected)===expected;
          }
        }
        log(room,p.id,"REVEAL",target.id);
        broadcast(room); return json(res,200,publicState(room,p.token));
      }
      if(act==="chat"){
        if(room.mode!=="2v2") return json(res,400,{error:"Chat is only enabled in 2v2."});
        const msg=String(b.message||"").slice(0,300);
        if(!msg) return json(res,400,{error:"Empty message."});
        room.log.push({time:Math.floor((Date.now()-room.startedAt)/1000),actor:p.id,action:"CHAT",target:msg,result:"TEAM_ONLY"});
        // Team chat is represented as a log event; client filters it by team.
        broadcast(room); return json(res,200,publicState(room,p.token));
      }
      return json(res,400,{error:"Unknown action."});
    }
    if(req.method==="GET"){
      let file=u.pathname==="/" ? "/index.html" : u.pathname;
      const fp=path.normalize(path.join(PUBLIC,file));
      if(!fp.startsWith(PUBLIC)) return json(res,403,{error:"Forbidden"});
      if(fs.existsSync(fp) && fs.statSync(fp).isFile()){
        const ext=path.extname(fp); const types={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8"};
        res.writeHead(200,{"Content-Type":types[ext]||"application/octet-stream","Cache-Control":"no-cache"});
        return fs.createReadStream(fp).pipe(res);
      }
    }
    json(res,404,{error:"Not found"});
  }catch(e){ console.error(e); json(res,500,{error:"Server error",detail:e.message}); }
});
server.listen(PORT,()=>console.log(`Ranked Flex multiplayer server: http://localhost:${PORT}`));
