
const API_BASE='';
const LOGIN_KEY='unicorn_crm_session_v2';
const NOTIF_KEY='unicorn_crm_notification_settings_v1';
const ONE_MONTH_MS=30*24*60*60*1000;

async function api(method,path,body){
  const session=JSON.parse(localStorage.getItem(LOGIN_KEY)||'{}');
  const token=session.token;
  const res=await fetch(API_BASE+path,{
    method,
    headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},
    body:body?JSON.stringify(body):undefined
  });
  if(!res.ok){
    const err=await res.json().catch(()=>({error:res.statusText}));
    throw new Error(err.error||'API Error '+res.status);
  }
  return res.json();
}

async function loginUser(){
  const email=(document.getElementById('loginEmail')?.value||'').trim();
  const password=(document.getElementById('loginPassword')?.value||'').trim();
  const remember=document.getElementById('rememberLogin')?.checked!==false;
  const errEl=document.getElementById('loginError');
  try{
    const data=await api('POST','/auth/login',{email,password});
    const expiresAt=Date.now()+(remember?ONE_MONTH_MS:8*60*60*1000);
    localStorage.setItem(LOGIN_KEY,JSON.stringify({...data,expiresAt}));
    if(errEl)errEl.classList.add('hidden');
    showApp();
    await loadInitialData();
  }catch(e){
    if(errEl){errEl.classList.remove('hidden');errEl.innerText=e.message}
  }
}
function showApp(){
  const login=document.getElementById('loginScreen');
  const app=document.getElementById('appRoot');
  if(login)login.classList.add('hidden');
  if(app)app.classList.remove('hidden');
}
function showLogin(){
  const login=document.getElementById('loginScreen');
  const app=document.getElementById('appRoot');
  if(login)login.classList.remove('hidden');
  if(app)app.classList.add('hidden');
}
async function checkLoginSession(){
  try{
    const raw=localStorage.getItem(LOGIN_KEY);
    if(!raw){showLogin();return}
    const session=JSON.parse(raw);
    if(!session.expiresAt||Date.now()>session.expiresAt){localStorage.removeItem(LOGIN_KEY);showLogin();return}
    showApp();
    await loadInitialData();
  }catch(e){localStorage.removeItem(LOGIN_KEY);showLogin()}
}
function logoutUser(){stopPolling();if(socket){socket.disconnect();socket=null}localStorage.removeItem(LOGIN_KEY);showLogin()}

function formatMsgTime(ts){
  if(!ts)return'';
  const d=new Date(ts);
  const h=d.getHours()%12||12;
  const m=String(d.getMinutes()).padStart(2,'0');
  const ampm=d.getHours()>=12?'PM':'AM';
  return h+':'+m+' '+ampm;
}

function contactToLead(c){
  const name=[c.first_name,c.last_name].filter(Boolean).join(' ')||c.username||'User #'+c.telegram_id;
  return{
    id:c.id,c:c.channel_id,n:name,pkg:c.package||'',
    u:'@'+(c.username||c.telegram_id),
    stage:c.lifecycle||'New Lead',
    time:formatMsgTime(c.last_message_time),
    unread:c.unread||0,msg:c.last_message||'',
    country:'',lang:'',sale:c.sale||'Unassigned',
    quality:70,online:false,lastSeenAt:c.last_seen_at||null,seen:true,typing:false,
    firstClick:c.created_at?(c.created_at.replace('T',' ').slice(0,16)):'',
    source:'Telegram bot',lastBroadcast:'None',renewAt:'Chưa đến hạn',
    telegramId:c.telegram_id,channelId:c.channel_id,messages:null,autoWelcomed:false,
    language_code:c.language_code||'',is_premium:c.is_premium||0,
    phone:c.phone||'',avatar_updated_at:c.avatar_updated_at||'',
    timeline:[{t:'First click bot',d:c.created_at?(c.created_at.replace('T',' ').slice(0,16)):''}]
  };
}

async function loadInitialData(){
  try{
    const[chs,qrs]=await Promise.all([api('GET','/channels'),api('GET','/quick-replies')]);
    channels=chs.map(c=>({id:c.id,name:c.name,icon:c.icon||'🤖',bot:'@'+(c.bot_username||''),bots:c.bots||[]}));
    quickReplies=qrs.map(q=>({...q,key:q.key_cmd,files:q.files||[]}));
    if(channels.length>0){
      activeChannel=channels[0].id;
      activeStage='all';
      activeFolderFilter='all';
      await loadConversations(activeChannel);
      // Auto-load messages cho lead đầu tiên
      if(activeLead){
        try{
          const msgs=await api('GET','/conversations/'+activeLead.id+'/messages');
          activeLead.messages=msgs;
        }catch(e){}
      }
    }
    renderAll();renderReports();loadNotificationSettings();initBroadcastInteractions();
    connectSocket();
  }catch(e){
    console.error('Lỗi tải dữ liệu:',e);
    showToast('Lỗi kết nối','Không thể kết nối server: '+e.message);
    renderAll();loadNotificationSettings();
  }
}

async function loadConversations(channelId){
  try{
    const contacts=await api('GET','/conversations?channel_id='+channelId);
    leads=leads.filter(l=>l.c!==channelId);
    leads.push(...contacts.map(contactToLead));
    if(!activeLead&&leads.length>0)activeLead=leads[0];
  }catch(e){console.error('Lỗi tải hội thoại:',e)}
}

let socket=null;
let pollingTimer=null;
function connectSocket(){
  if(socket)return;
  if(typeof io==='undefined'){startPolling();return}
  socket=io(window.location.origin);
  socket.on('msg_reaction',({contactId,messageId,reactions})=>{
    // Cập nhật reaction trong activeLead.messages nếu đang xem
    if(activeLead?.messages){
      const msg=activeLead.messages.find(m=>m.id===messageId);
      if(msg){
        msg.reactions=reactions;
        // Cập nhật DOM trực tiếp
        const wrap=document.querySelector('[data-msg-id="msg_'+messageId+'"]');
        if(wrap){
          const reacts=wrap.querySelector('.msg-reacts');
          if(reacts)renderReactionsInEl(reacts,reactions);
        }
      }
    }
  });
  socket.on('new_message',({contactId,channelId,message,contact})=>{
    const isNewLead=!leads.find(l=>l.id===contactId);
    let lead=leads.find(l=>l.id===contactId);
    if(!lead&&contact){lead=contactToLead(contact);leads.unshift(lead)}
    if(lead){
      lead.msg=message.text||'';
      lead.time=formatMsgTime(message.created_at);
      if(message.direction==='in'){
        lead.lastSeenAt=message.created_at||new Date().toISOString();
        lead.online=true;
      }
      if(activeLead?.id!==contactId&&message.direction==='in')lead.unread=(lead.unread||0)+1;
      if(activeLead?.id===contactId&&message.direction==='in'){
        if(!lead.messages)lead.messages=[];
        lead.messages.push(message);
        renderChat();
      }
    }
    renderList();
    renderTabs();
    if(message.direction==='in'){
      const n=lead?.n||'Khách hàng';
      notifyNewMessage(n,message.text||'');
      // ── Kích hoạt automation rules
      if(lead)checkAutomationRules(lead,message,isNewLead);
    }
  });
}
function startPolling(){
  if(pollingTimer)return;
  pollingTimer=setInterval(async()=>{
    if(!activeChannel)return;
    try{
      const contacts=await api('GET','/conversations?channel_id='+activeChannel);
      let refreshList=false;
      contacts.forEach(c=>{
        const lead=leads.find(l=>l.id===c.id);
        if(!lead){leads.unshift(contactToLead(c));refreshList=true}
        else if(c.last_message&&lead.msg!==c.last_message){
          const isNew=c.unread>(lead.unread||0)&&activeLead?.id!==c.id;
          lead.msg=c.last_message;lead.time=formatMsgTime(c.last_message_time);
          lead.unread=activeLead?.id===c.id?0:c.unread;
          if(isNew)notifyNewMessage(lead.n,c.last_message);
          refreshList=true;
        }
      });
      if(refreshList)renderList();
      if(activeLead?.messages){
        const msgs=await api('GET','/conversations/'+activeLead.id+'/messages');
        if(msgs.length>activeLead.messages.length){activeLead.messages=msgs;renderChat()}
      }
    }catch(e){}
  },5000);
}
function stopPolling(){if(pollingTimer){clearInterval(pollingTimer);pollingTimer=null}}
function getNotificationSettings(){
  try{return JSON.parse(localStorage.getItem(NOTIF_KEY))||{enabled:true,toast:true,sound:true,badge:true,volume:70,soundType:'telegram'}}catch(e){return {enabled:true,toast:true,sound:true,badge:true,volume:70,soundType:'telegram'}}
}
function saveNotificationSettings(){
  const data={
    enabled:$('notifEnabled').checked,
    toast:$('notifToast').checked,
    sound:$('notifSoundEnabled').checked,
    badge:$('notifBadge').checked,
    volume:Number($('notifVolume').value||70),
    soundType:$('notifSound').value||'telegram'
  };
  localStorage.setItem(NOTIF_KEY,JSON.stringify(data));
}
function loadNotificationSettings(){
  const s=getNotificationSettings();
  if($('notifEnabled'))$('notifEnabled').checked=s.enabled;
  if($('notifToast'))$('notifToast').checked=s.toast;
  if($('notifSoundEnabled'))$('notifSoundEnabled').checked=s.sound;
  if($('notifBadge'))$('notifBadge').checked=s.badge;
  if($('notifVolume'))$('notifVolume').value=s.volume;
  if($('notifSound'))$('notifSound').value=s.soundType;
  updateVolumeLabel();
}
function updateVolumeLabel(){if($('notifVolumeLabel'))$('notifVolumeLabel').innerText=($('notifVolume').value||70)+'%'}
function updateMsgStatus(msgId,status){
  const row=document.querySelector('[data-msg-id="'+msgId+'"]');
  if(!row)return;
  const statusEl=row.querySelector('.seen-check');
  if(!statusEl)return;
  if(status==='sent'){
    statusEl.innerText='✓ Sent';
    statusEl.className='seen-check text-black/50';
  }
  if(status==='seen'){
    statusEl.innerText='✓✓ Seen';
    statusEl.className='seen-check';
  }
}
function getLastSeenMins(lead){
  if(!lead?.lastSeenAt)return null;
  return Math.floor((Date.now()-new Date(lead.lastSeenAt).getTime())/60000);
}
function getOfflineText(lead){
  const l=lead||activeLead;
  const mins=getLastSeenMins(l);
  if(mins===null)return 'Chưa có hoạt động';
  if(mins<1)return 'Vừa online';
  if(mins<60)return 'Hoạt động '+mins+' phút trước';
  if(mins<1440)return 'Hoạt động '+Math.floor(mins/60)+' giờ trước';
  if(mins<10080)return 'Hoạt động '+Math.floor(mins/1440)+' ngày trước';
  return 'Hoạt động '+Math.floor(mins/10080)+' tuần trước';
}
function isOnline(lead){
  const mins=getLastSeenMins(lead||activeLead);
  return mins!==null&&mins<=5;
}
// Tự cập nhật presence mỗi 60 giây
setInterval(()=>{
  if(!activeLead)return;
  const label=$('presenceLabel');
  if(!label||activeLead.typing)return;
  const online=isOnline(activeLead);
  label.innerText=online?'🟢 Online':getOfflineText();
  label.className='text-sm '+(online?'text-green-400':'text-zinc-500');
},60000);
function setTypingState(isTyping){
  activeLead.typing=isTyping;
  const label=$('presenceLabel');
  if(label){
    const online=isOnline(activeLead);
    label.innerText=isTyping?'đang nhập...':(online?'Online':getOfflineText());
    label.className='text-sm '+(isTyping?'text-yellow-300':(online?'text-green-400':'text-zinc-500'));
  }
  const typing=$('typingIndicator');
  if(typing)typing.classList.toggle('hidden',!isTyping);
}
function simulateIncomingMessage(){
  const replies=['Ok bạn gửi mình giá nhé','Mình muốn xem feedback trước','Có gói Lifetime không?','Thanh toán USDT được không?','Can you send me VIP price?'];
  const text=replies[Math.floor(Math.random()*replies.length)];
  const wrap=$('chatBody').querySelector('.max-w-6xl');
  if(!wrap)return;
  const typing=$('typingIndicator');
  const html=chatBubble(esc(text),'Now','left');
  if(typing)typing.insertAdjacentHTML('beforebegin',html);else wrap.insertAdjacentHTML('beforeend',html);
  activeLead.msg=text;
  activeLead.time='Now';
  activeLead.unread=(activeLead.unread||0)+1;
  renderList();
  notifyNewMessage(activeLead.n,text);
  $('chatBody').scrollTop=$('chatBody').scrollHeight;
}
let realtimeDemoTimer=null;
function startRealtimeDemo(){
  clearTimeout(realtimeDemoTimer);
  setTypingState(false);
  realtimeDemoTimer=setTimeout(()=>{
    if(!activeLead)return;
    activeLead.online=true;
    setTypingState(true);
    setTimeout(()=>{
      setTypingState(false);
      simulateIncomingMessage();
    },1800);
  },2200);
}
function playTone(type='telegram',volume=70){
  const AudioCtx=window.AudioContext||window.webkitAudioContext;
  if(!AudioCtx)return;
  const ctx=new AudioCtx();
  const gain=ctx.createGain();
  gain.gain.value=(volume/100)*0.18;
  gain.connect(ctx.destination);
  const patterns={telegram:[[880,0,.08],[1320,.09,.08]],soft:[[660,0,.08],[880,.1,.08]],alert:[[520,0,.12],[520,.16,.12]],coin:[[1040,0,.06],[1560,.08,.08]]};
  (patterns[type]||patterns.telegram).forEach(p=>{
    const osc=ctx.createOscillator();
    osc.type='sine';
    osc.frequency.value=p[0];
    osc.connect(gain);
    osc.start(ctx.currentTime+p[1]);
    osc.stop(ctx.currentTime+p[1]+p[2]);
  });
  setTimeout(()=>ctx.close(),700);
}
function showToast(title,msg){
  const box=$('toastBox');
  if(!box)return;
  const id='toast_'+Date.now();
  box.insertAdjacentHTML('beforeend','<div id="'+id+'" class="pointer-events-auto w-[320px] rounded-2xl border line bg-[#0f1722] shadow-2xl shadow-black/50 p-4 bubble"><div class="flex items-start gap-3"><div class="w-10 h-10 rounded-xl bg-yellow-400 text-black grid place-items-center font-black">U</div><div class="min-w-0"><p class="font-black text-white">'+esc(title)+'</p><p class="text-sm text-zinc-400 mt-1 truncate">'+esc(msg)+'</p></div></div></div>');
  setTimeout(()=>{const el=$(id);if(el&&el.remove)el.remove()},3500);
}
function notifyNewMessage(title,msg){
  const s=getNotificationSettings();
  if(!s.enabled)return;
  if(s.toast)showToast(title,msg);
  if(s.sound)playTone(s.soundType,s.volume);
}
function testNotificationSound(){
  saveNotificationSettings();
  notifyNewMessage('Test thông báo','Khách mới vừa nhắn vào Telegram');
}

let _tgCv=null;

function openTelegramPreview(){
  if(!activeLead?.messages?.length){showToast('Chưa có tin nhắn','Chọn một hội thoại có tin nhắn trước');return}
  const ch=channels.find(x=>x.id===activeLead.c);
  const botLabel=(ch?ch.name:'UNICORN').toUpperCase();
  _tgCv=buildTgCanvas(activeLead.messages,botLabel);
  const modal=document.createElement('div');
  modal.id='tgPreviewModal';
  modal.style.cssText='position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.88);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:20px;overflow:auto;';
  const img=document.createElement('img');
  img.src=_tgCv.toDataURL('image/png');
  img.style.cssText='max-height:80vh;border-radius:12px;box-shadow:0 40px 120px rgba(0,0,0,0.9);max-width:420px;width:100%;';
  const btns=document.createElement('div');
  btns.style.cssText='display:flex;gap:12px;flex-shrink:0;';
  btns.innerHTML='<button onclick="document.getElementById(\'tgPreviewModal\').remove()" style="background:rgba(255,255,255,0.1);color:#fff;border:1px solid rgba(255,255,255,0.2);padding:11px 24px;border-radius:14px;font-weight:700;cursor:pointer;font-size:14px;font-family:inherit;">✕ Đóng</button><button onclick="saveTelegramScreenshot()" id="tgSaveBtn" style="background:#2B5278;color:#fff;border:none;padding:11px 24px;border-radius:14px;font-weight:700;cursor:pointer;font-size:14px;font-family:inherit;">📥 Tải ảnh PNG</button>';
  modal.appendChild(img);modal.appendChild(btns);
  document.body.appendChild(modal);
  modal.addEventListener('click',e=>{if(e.target===modal)modal.remove();});
}

async function saveTelegramScreenshot(){
  const btn=document.getElementById('tgSaveBtn');
  if(btn){btn.innerText='⏳ Đang xử lý...';btn.disabled=true;}
  try{
    if(!_tgCv){showToast('Lỗi','Chưa mở preview');return;}
    const link=document.createElement('a');
    const name=(activeLead?.n||'chat').replace(/\s+/g,'-');
    link.download='tg-'+name+'-'+Date.now()+'.png';
    link.href=_tgCv.toDataURL('image/png');
    link.click();
    showToast('Đã tải ảnh',link.download);
  }catch(e){showToast('Lỗi xuất ảnh',e.message);}
  finally{if(btn){btn.innerText='📥 Tải ảnh PNG';btn.disabled=false;}}
}

function buildTgCanvas(msgs,botName){
  const W=390,DPR=3;
  const FF="'Helvetica Neue',Arial,sans-serif";
  // Telegram dark exact colors
  const BG='#0E1621',BGH='#17212B',BUL='#182533',BUR='#2B5278',BGI='#242F3D';
  const CT='#FFFFFF',CB='#5EADF5',CTM='rgba(255,255,255,0.42)',CTK='#4FC3F7';
  const CDB='rgba(0,0,0,0.45)',CDT='rgba(255,255,255,0.70)';
  // Layout
  const SH=44,HH=56,FH=70,CP=12;
  const MTW=248,BPX=11,BPYT=8,BPYB=7;
  const MFS=14.5,MLH=21,TFS=11,NFS=12.5,NRH=18;
  const AVR=17,LP=12,RP=12,AVTG=5;
  const BLX=LP+AVR*2+AVTG; // left bubble x-start = 51
  const GS=3,GD=10;
  // Measurement ctx
  const mc=document.createElement('canvas').getContext('2d');
  const mf=(sz,b)=>{mc.font=`${b?'600':'400'} ${sz}px ${FF}`;};
  const mtw=(t,sz,b)=>{mf(sz||MFS,b);return mc.measureText(String(t||'')).width;};
  const mlines=(txt,mw)=>{
    mf(MFS,false);
    const out=[];
    for(const p of String(txt||'').split('\n')){
      if(!p){out.push('');continue;}
      let cur='';
      for(const w of p.split(' ')){
        const t=cur?cur+' '+w:w;
        if(mc.measureText(t).width<=mw)cur=t;
        else{if(cur)out.push(cur);cur=w;}
      }
      out.push(cur);
    }
    return out.length?out:[''];
  };
  // Build items
  const items=[];
  let lastDir=null,lastDate='';
  const valid=msgs.filter(m=>m.direction||m.text);
  for(let i=0;i<valid.length;i++){
    const m=valid[i];
    const isR=m.direction==='in'; // customer=right
    const d=m.created_at?new Date(m.created_at):new Date();
    const ds=d.toLocaleDateString('en-US',{month:'long',day:'numeric'});
    if(ds!==lastDate){
      items.push({k:'date',label:ds,gap:lastDate?GD*2:0});
      lastDate=ds;lastDir=null;
    }
    const isF=!valid[i-1]||valid[i-1].direction!==m.direction;
    const isL=!valid[i+1]||valid[i+1].direction!==m.direction;
    const raw=m.text==='[media]'?'📷 Photo':(m.text||'');
    const lines=mlines(raw,MTW);
    const ts=formatMsgTime(m.created_at);
    const tkW=isR?mtw('✓✓',TFS)+4:0;
    const trW=mtw(ts,TFS)+tkW+6;
    mf(MFS,false);
    let mxLW=0;for(const ln of lines)mxLW=Math.max(mxLW,mc.measureText(ln).width);
    const bW=Math.min(Math.max(BPX*2+mxLW,BPX*2+trW,64),MTW+BPX*2);
    const nH=(!isR&&isF)?NRH:0;
    const bH=BPYT+nH+lines.length*MLH+4+TFS+BPYB;
    const gap=lastDir===null?0:(lastDir===(isR?'R':'L')?GS:GD);
    items.push({k:'msg',isR,isF,isL,lines,ts,tkW,trW,bW,bH,gap,nH});
    lastDir=isR?'R':'L';
  }
  // Total chat height
  let chatH=CP;
  for(const it of items){
    if(it.k==='date')chatH+=(it.gap||0)+22+8;
    else chatH+=it.gap+it.bH;
  }
  chatH+=CP;
  // Create canvas
  const cv=document.createElement('canvas');
  cv.width=W*DPR;cv.height=(SH+HH+chatH+FH)*DPR;
  const c=cv.getContext('2d');
  c.scale(DPR,DPR);
  const cf=(sz,b)=>{c.font=`${b?'600':'400'} ${sz}px ${FF}`;};
  function rr(x,y,w,h,r){
    const[tl,tr,br,bl]=(Array.isArray(r)?r:[r,r,r,r]).map(v=>Math.min(v,Math.min(w,h)/2));
    c.beginPath();
    c.moveTo(x+tl,y);
    c.arcTo(x+w,y,x+w,y+h,tr);
    c.arcTo(x+w,y+h,x,y+h,br);
    c.arcTo(x,y+h,x,y,bl);
    c.arcTo(x,y,x+w,y,tl);
    c.closePath();
  }
  // ── STATUS BAR
  c.fillStyle=BGH;c.fillRect(0,0,W,SH);
  cf(15,true);c.fillStyle='#fff';c.textBaseline='middle';c.textAlign='left';
  c.fillText('9:41',20,SH/2);
  // signal bars
  c.fillStyle='rgba(255,255,255,0.9)';
  for(let i=0;i<4;i++){const h=4+i*3;c.fillRect(W-94+i*8,SH/2-h/2+2,6,h);}
  // wifi arcs
  const wx=W-62,wyb=SH/2+5;
  c.lineWidth=1.8;c.strokeStyle='rgba(255,255,255,0.9)';c.lineCap='round';
  for(let j=1;j<=3;j++){c.beginPath();c.arc(wx,wyb+j*3.5,j*3.5,Math.PI,0,true);c.stroke();}
  c.beginPath();c.arc(wx,wyb,1.8,0,Math.PI*2);c.fillStyle='rgba(255,255,255,0.9)';c.fill();
  c.lineCap='butt';
  // battery
  const bx=W-38,bby=SH/2-6;
  c.strokeStyle='rgba(255,255,255,0.85)';c.lineWidth=1.3;
  rr(bx,bby,24,12,2.5);c.stroke();
  c.fillStyle='rgba(255,255,255,0.85)';c.fillRect(bx+24,bby+3.5,2,5);
  rr(bx+1.5,bby+1.5,16,9,1.5);c.fill();
  // ── HEADER
  c.fillStyle=BGH;c.fillRect(0,SH,W,HH);
  c.strokeStyle='rgba(255,255,255,0.07)';c.lineWidth=0.5;
  c.beginPath();c.moveTo(0,SH+HH);c.lineTo(W,SH+HH);c.stroke();
  // back arrow
  const arY=SH+HH/2;
  c.strokeStyle='#5EADF5';c.lineWidth=2;c.lineCap='round';
  c.beginPath();c.moveTo(22,arY-7);c.lineTo(12,arY);c.lineTo(22,arY+7);c.stroke();
  c.lineCap='butt';
  // avatar
  const acx=45,acy=SH+HH/2,avr=19;
  c.save();c.beginPath();c.arc(acx,acy,avr,0,Math.PI*2);c.clip();
  const ag1=c.createLinearGradient(acx,acy-avr,acx,acy+avr);
  ag1.addColorStop(0,'#e63946');ag1.addColorStop(1,'#a01224');
  c.fillStyle=ag1;c.fillRect(acx-avr,acy-avr,avr*2,avr*2);c.restore();
  cf(12,true);c.fillStyle='#fff';c.textAlign='center';c.textBaseline='middle';
  c.fillText('UN',acx,acy);
  // bot name
  cf(15.5,true);c.fillStyle='#fff';c.textAlign='left';c.textBaseline='middle';
  c.fillText(botName,72,SH+HH/2-7);
  cf(13,false);c.fillStyle='rgba(255,255,255,0.45)';
  c.fillText('bot',72,SH+HH/2+9);
  // 3-dot menu
  c.fillStyle='rgba(255,255,255,0.6)';
  for(let d=-1;d<=1;d++){c.beginPath();c.arc(W-16,SH+HH/2+d*5.5,2,0,Math.PI*2);c.fill();}
  // ── CHAT BG
  c.fillStyle=BG;c.fillRect(0,SH+HH,W,chatH);
  // ── MESSAGES
  let curY=SH+HH+CP;
  for(const it of items){
    if(it.k==='date'){
      curY+=it.gap||0;
      const lw=mtw(it.label,12)+24;
      rr((W-lw)/2,curY,lw,22,11);c.fillStyle=CDB;c.fill();
      cf(12,false);c.fillStyle=CDT;c.textAlign='center';c.textBaseline='middle';
      c.fillText(it.label,W/2,curY+11);curY+=30;continue;
    }
    curY+=it.gap;
    const{isR,isF,isL,lines,ts,tkW,bW,bH,nH}=it;
    if(!isR){
      // left bubble (bot)
      const bx=BLX,by=curY;
      rr(bx,by,bW,bH,[isF?4:18,18,18,isL?4:18]);
      c.fillStyle=BUL;c.fill();
      // avatar (last in group)
      if(isL){
        const ax=LP+AVR,ay=by+bH-AVR;
        c.save();c.beginPath();c.arc(ax,ay,AVR,0,Math.PI*2);c.clip();
        const ag2=c.createRadialGradient(ax-4,ay-4,2,ax,ay,AVR);
        ag2.addColorStop(0,'#e63946');ag2.addColorStop(1,'#9b1c2a');
        c.fillStyle=ag2;c.fillRect(ax-AVR,ay-AVR,AVR*2,AVR*2);c.restore();
        cf(10,true);c.fillStyle='#fff';c.textAlign='center';c.textBaseline='middle';
        c.fillText('UN',ax,ay);
      }
      let ty=by+BPYT;
      if(nH){cf(NFS,true);c.fillStyle=CB;c.textAlign='left';c.textBaseline='top';c.fillText(botName,bx+BPX,ty);ty+=nH;}
      cf(MFS,false);c.fillStyle=CT;c.textAlign='left';c.textBaseline='top';
      for(const ln of lines){c.fillText(ln,bx+BPX,ty);ty+=MLH;}
      cf(TFS,false);c.fillStyle=CTM;c.textAlign='right';c.textBaseline='bottom';
      c.fillText(ts,bx+bW-BPX,by+bH-BPYB+1);
    }else{
      // right bubble (customer)
      const bx=W-RP-bW,by=curY;
      rr(bx,by,bW,bH,[18,isF?4:18,isL?4:18,18]);
      c.fillStyle=BUR;c.fill();
      let ty=by+BPYT;
      cf(MFS,false);c.fillStyle=CT;c.textAlign='left';c.textBaseline='top';
      for(const ln of lines){c.fillText(ln,bx+BPX,ty);ty+=MLH;}
      cf(TFS,false);c.textBaseline='bottom';
      const twts=mtw('✓✓',TFS);
      const twt=mtw(ts,TFS);
      c.fillStyle=CTM;c.textAlign='left';
      c.fillText(ts,bx+bW-BPX-twts-4-twt,by+bH-BPYB+1);
      c.fillStyle=CTK;c.textAlign='right';
      c.fillText('✓✓',bx+bW-BPX,by+bH-BPYB+1);
    }
    curY+=bH;
  }
  // ── FOOTER
  const fy=SH+HH+chatH;
  c.strokeStyle='rgba(255,255,255,0.08)';c.lineWidth=0.5;
  c.beginPath();c.moveTo(0,fy);c.lineTo(W,fy);c.stroke();
  c.fillStyle=BGH;c.fillRect(0,fy,W,FH);
  cf(22,false);c.fillStyle='rgba(255,255,255,0.5)';c.textAlign='center';c.textBaseline='middle';
  c.fillText('🙂',20,fy+FH/2);
  const ix=42,iw=W-42-16-48-8;
  rr(ix,fy+(FH-44)/2,iw,44,22);c.fillStyle=BGI;c.fill();
  cf(14.5,false);c.fillStyle='rgba(255,255,255,0.25)';c.textAlign='left';
  c.fillText('Message',ix+16,fy+FH/2);
  cf(20,false);c.fillStyle='rgba(255,255,255,0.5)';c.textAlign='center';
  c.fillText('📎',ix+iw+10,fy+FH/2);
  // send button circle
  const scx=W-22,scy=fy+FH/2;
  c.beginPath();c.arc(scx,scy,20,0,Math.PI*2);c.fillStyle='#2EA6D9';c.fill();
  c.strokeStyle='#fff';c.lineWidth=2.2;c.lineCap='round';c.lineJoin='round';
  c.beginPath();c.moveTo(scx-5,scy-5);c.lineTo(scx+6,scy);c.lineTo(scx-5,scy+5);
  c.moveTo(scx-4,scy);c.lineTo(scx+6,scy);c.stroke();
  c.lineCap='butt';c.lineJoin='miter';
  return cv;
}
// ── IMPORT & MIGRATE ────────────────────────────────────────────────────────
const EXPORT_SCRIPT = `# telegram_export.py — Export lịch sử Telegram sang JSON
# Cài đặt: pip install telethon
# Chạy: python telegram_export.py

import asyncio, json
from telethon import TelegramClient
from telethon.tl.types import User

print("=== Telegram History Exporter ===")
api_id   = int(input("API ID (từ my.telegram.org): "))
api_hash = input("API Hash: ")
limit    = int(input("Số tin nhắn tối đa mỗi người (mặc định 500): ") or 500)

async def main():
    async with TelegramClient("tg_session", api_id, api_hash) as client:
        me = await client.get_me()
        print(f"Đăng nhập: {me.first_name} (@{me.username})")
        dialogs = await client.get_dialogs()
        contacts, messages = [], []
        total = len([d for d in dialogs if isinstance(d.entity, User)])
        print(f"Tìm thấy {total} cuộc trò chuyện với người dùng...")
        done = 0
        for dialog in dialogs:
            entity = dialog.entity
            if not isinstance(entity, User) or entity.bot:
                continue
            done += 1
            print(f"[{done}/{total}] Đang export @{entity.username or entity.id}...")
            contacts.append({
                "telegram_id": entity.id,
                "first_name":  entity.first_name or "",
                "last_name":   entity.last_name  or "",
                "username":    entity.username   or ""
            })
            async for msg in client.iter_messages(entity, limit=limit):
                if not msg.message:
                    continue
                messages.append({
                    "telegram_id": entity.id,
                    "text":        msg.message,
                    "direction":   "out" if msg.out else "in",
                    "sender_name": (me.first_name if msg.out
                                    else (entity.first_name or entity.username or "")),
                    "created_at":  msg.date.isoformat()
                })
        output = {"contacts": contacts, "messages": messages}
        with open("telegram_export.json", "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)
        print(f"\\n✅ Xong! Exported {len(contacts)} contacts, {len(messages)} messages")
        print("   → Upload file telegram_export.json vào CRM (tab Import JSON)")

asyncio.run(main())`;

let _importCsvChannelId = null;
let _importJsonChannelId = null;

// ── RESPOND.IO WIZARD ──────────────────────────────────────────────────────────
let _respondData = null; // {contacts, uniqueChannels, uniqueLifecycles}

function loadRespondCsv(e){
  const file = e.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const text = ev.target.result;
    const parsed = parseRespondIoCsv(text);
    if(parsed){
      _respondData = parsed;
      showRespondStep2(parsed);
    } else {
      // Not Respond.io format, fall through to basic CSV
      $('csvImportText').value = text;
      showToast('Không phải Respond.io', 'Dùng tab Import CSV thông thường cho file này');
    }
  };
  reader.readAsText(file, 'UTF-8');
  e.target.value = '';
}

function parseRespondIoCsv(text){
  const {headers, rows} = parseCSV(text);
  // Detect Respond.io format: has "contactid" and "channels" columns
  if(!headers.includes('contactid') || !headers.includes('channels')) return null;

  const uniqueChannels = [...new Set(
    rows.map(r => (r.channels||'').trim().replace(/^\s+/, '')).filter(Boolean)
  )].sort();

  const uniqueLifecycles = [...new Set(
    rows.map(r => (r.lifecycle||'').trim()).filter(Boolean)
  )].sort();

  const contacts = rows.map(r => ({
    telegram_id: (r.contactid||'').trim(),
    first_name:  (r.firstname||'').trim(),
    last_name:   (r.lastname||'').trim(),
    lifecycle:   (r.lifecycle||'New Lead').trim(),
    status:      (r.status||'').trim(),
    tags:        r.tags ? r.tags.split(',').map(t=>t.trim()).filter(Boolean) : [],
    sale:        (r.assignee||'').trim(),
    last_time:   (r.lastinteractiontime||'').trim(),
    created_at:  (r.datetimecreated||'').trim(),
    channel_name:(r.channels||'').trim().replace(/^\s+/, ''),
  })).filter(c => c.telegram_id && /^\d+$/.test(c.telegram_id));

  return {contacts, uniqueChannels, uniqueLifecycles};
}

function showRespondStep2(parsed){
  $('csvStep1').classList.add('hidden');
  $('csvStep2').classList.remove('hidden');

  // Contact count
  const countEl = $('respondContactCount');
  if(countEl) countEl.textContent = parsed.contacts.length + ' contacts từ ' + parsed.uniqueChannels.length + ' kênh';

  // Channel mapping
  const mapEl = $('respondChannelMapping');
  if(mapEl){
    // Count contacts per Respond.io channel
    const chCount = {};
    parsed.contacts.forEach(c => { chCount[c.channel_name] = (chCount[c.channel_name]||0)+1; });

    mapEl.innerHTML = parsed.uniqueChannels.map(ch => {
      const cnt = chCount[ch] || 0;
      const opts = '<option value="">— Bỏ qua kênh này —</option>' +
        channels.map(c => {
          const botMatch = c.bot && ch.toLowerCase().replace(/[^a-z0-9]/g,'').includes(c.bot.toLowerCase().replace(/[^a-z0-9]/g,''));
          const nameMatch = c.name && ch.toLowerCase().includes(c.name.toLowerCase());
          return '<option value="'+c.id+'"'+(botMatch||nameMatch?' selected':'')+'>'+esc(c.icon+' '+c.name)+' ('+c.bot+')</option>';
        }).join('');
      const isBotLike = /bot|Bot|BOT/.test(ch) || ch.startsWith('@');
      return '<div class="flex items-center gap-2 rounded-xl bg-black/20 px-3 py-2" data-rch-row>'+
        '<div class="flex-1 min-w-0">'+
          '<div class="flex items-center gap-2">'+
            '<p class="text-sm font-black text-white truncate">'+esc(ch)+'</p>'+
            '<span class="text-[10px] text-zinc-600 shrink-0">'+cnt+' contacts</span>'+
          '</div>'+
          '<p class="text-[10px] text-zinc-600">'+(isBotLike?'🤖 Telegram Bot':'👤 User account / non-bot')+'</p>'+
        '</div>'+
        '<select data-rch="'+esc(ch)+'" onchange="updateRespondGroupHints()" class="h-9 rounded-xl bg-black/30 border line px-2 text-xs text-zinc-200 outline-none w-[200px]">'+opts+'</select>'+
      '</div>';
    }).join('');

    // Trigger initial group hint render
    setTimeout(updateRespondGroupHints, 100);
  }

  // Lifecycle preview
  const lifeEl = $('respondLifecycleList');
  if(lifeEl){
    const existing = new Set(stages.map(s=>s.toLowerCase()));
    lifeEl.innerHTML = parsed.uniqueLifecycles.map(lc => {
      const isNew = !existing.has(lc.toLowerCase());
      return '<span class="px-2 py-1 rounded-lg text-xs font-black '+(isNew?'bg-yellow-400/10 text-yellow-300 border border-yellow-400/20':'bg-white/5 text-zinc-400')+'">'+esc(lc)+(isNew?' ✦':'')+'</span>';
    }).join('');
  }

  // Stats
  const statsEl = $('respondStats');
  if(statsEl){
    const byChannel = {};
    parsed.contacts.forEach(c => { byChannel[c.channel_name] = (byChannel[c.channel_name]||0)+1; });
    const byLifecycle = {};
    parsed.contacts.forEach(c => { byLifecycle[c.lifecycle] = (byLifecycle[c.lifecycle]||0)+1; });
    const topLC = Object.entries(byLifecycle).sort((a,b)=>b[1]-a[1]).slice(0,6);
    statsEl.innerHTML =
      '<p class="text-zinc-300 font-black mb-1">Phân bổ lifecycle:</p>'+
      topLC.map(([lc,n])=>'<div class="flex justify-between"><span>'+esc(lc)+'</span><b class="text-yellow-300">'+n+'</b></div>').join('');
  }
}

function updateRespondGroupHints(){
  const hint = $('respondMappingGroupHint');
  if(!hint) return;

  // Group Respond.io channels by selected CRM channel
  const groups = {}; // crmChannelId → [respondChannelNames]
  document.querySelectorAll('[data-rch]').forEach(sel => {
    if(!sel.value) return;
    const rch = sel.getAttribute('data-rch');
    if(!groups[sel.value]) groups[sel.value] = [];
    groups[sel.value].push(rch);
  });

  // Only show groups with 2+ entries (merged channels)
  const merged = Object.entries(groups).filter(([,names]) => names.length > 1);
  if(!merged.length){ hint.classList.add('hidden'); return; }

  hint.classList.remove('hidden');
  hint.innerHTML = merged.map(([cid, names]) => {
    const ch = channels.find(c => c.id === Number(cid));
    const chName = ch ? ch.icon+' '+ch.name : 'Channel #'+cid;
    return '<div class="flex items-center gap-2 text-xs rounded-xl bg-green-500/10 border border-green-500/20 px-3 py-2">'+
      '<span class="text-green-400 font-black shrink-0">⛓ Gộp →</span>'+
      '<span class="text-white font-black">'+esc(chName)+'</span>'+
      '<span class="text-zinc-400">← '+names.map(n=>'<code class="text-yellow-300">'+esc(n)+'</code>').join(' + ')+'</span>'+
    '</div>';
  }).join('');

  // Also update import button text
  const btn = $('respondImportBtn');
  if(btn && _respondData){
    // Count mapped contacts
    const mapped = {};
    document.querySelectorAll('[data-rch]').forEach(sel => { if(sel.value) mapped[sel.getAttribute('data-rch')] = true; });
    const cnt = _respondData.contacts.filter(c => mapped[c.channel_name]).length;
    btn.textContent = '⬇ Import ' + cnt + ' contacts';
  }
}

function resetRespondImport(){
  _respondData = null;
  $('csvStep1').classList.remove('hidden');
  $('csvStep2').classList.add('hidden');
  $('respondImportResult').classList.add('hidden');
}

async function runRespondImport(){
  if(!_respondData) return;
  const btn = $('respondImportBtn');
  if(btn){btn.disabled=true; btn.textContent='⏳ Đang import...';}

  // Read channel mapping
  const chMap = {}; // respond_channel_name → crm_channel_id
  document.querySelectorAll('[data-rch]').forEach(sel => {
    if(sel.value) chMap[sel.getAttribute('data-rch')] = Number(sel.value);
  });

  // Add new lifecycle stages
  const existing = new Set(stages.map(s=>s.toLowerCase()));
  _respondData.uniqueLifecycles.forEach(lc => {
    if(lc && !existing.has(lc.toLowerCase())) {
      stages.splice(stages.indexOf('Không tiềm năng'), 0, lc);
    }
  });

  // Group contacts by channel
  const byChannel = {};
  _respondData.contacts.forEach(c => {
    const cid = chMap[c.channel_name];
    if(!cid) return; // skip unmapped channels
    if(!byChannel[cid]) byChannel[cid] = [];
    byChannel[cid].push(c);
  });

  let totalImported = 0, totalUpdated = 0, totalSkipped = 0;
  const result = $('respondImportResult');

  for(const [channel_id, contacts] of Object.entries(byChannel)){
    try{
      const r = await api('POST', '/import/contacts', {
        rows: contacts,
        channel_id: Number(channel_id)
      });
      totalImported += r.imported || 0;
      totalUpdated += r.updated || 0;
      totalSkipped += r.skipped || 0;
    }catch(e){
      totalSkipped += contacts.length;
    }
  }

  // Count unmapped
  const unmapped = _respondData.contacts.filter(c => !chMap[c.channel_name]).length;

  if(result){
    result.classList.remove('hidden');
    const hasErr = unmapped > 0;
    result.className = 'mt-4 rounded-2xl border p-4 text-sm ' +
      (hasErr ? 'border-yellow-500/20 bg-yellow-500/10 text-yellow-200' : 'border-green-500/20 bg-green-500/10 text-green-300');
    result.innerHTML =
      '✅ Import xong!<br>'+
      '<b>'+totalImported+'</b> contacts mới · <b>'+totalUpdated+'</b> cập nhật · <b>'+totalSkipped+'</b> lỗi'+
      (unmapped ? '<br>⚠ <b>'+unmapped+'</b> contacts bị bỏ qua vì kênh chưa được map. Chỉ định kênh và thử lại.' : '');
  }

  // Reload conversations for all affected channels
  for(const cid of Object.keys(byChannel)){
    try{ await loadConversations(Number(cid)); }catch{}
  }
  renderAll();
  renderLifecycle();

  showToast('Import xong', totalImported+' contacts mới từ Respond.io');
  if(btn){btn.disabled=false; btn.textContent='⬇ Import tất cả contacts';}
}

function openImportTab(tab){
  document.querySelectorAll('.import-pane').forEach(p=>p.classList.add('hidden'));
  document.querySelectorAll('.import-tab').forEach(b=>{b.classList.remove('bg-yellow-400','text-black');b.classList.add('text-zinc-400');});
  $('importPane'+tab.charAt(0).toUpperCase()+tab.slice(1))?.classList.remove('hidden');
  const btn=$('importTab'+tab.charAt(0).toUpperCase()+tab.slice(1));
  if(btn){btn.classList.add('bg-yellow-400','text-black');btn.classList.remove('text-zinc-400');}
  if(tab==='flush') renderFlushChannels();
  if(tab==='csv') renderImportChannelPicker('csv');
  if(tab==='json') renderImportChannelPicker('json');
  if(tab==='script'){
    const pre=$('exportScriptPre');
    if(pre&&!pre.textContent)pre.textContent=EXPORT_SCRIPT;
  }
}

function renderFlushChannels(){
  const box=$('flushChannelList');
  if(!box)return;
  if(!channels.length){box.innerHTML='<p class="text-zinc-500 text-sm">Chưa có channel nào. Thêm bot trước.</p>';return;}
  box.innerHTML=channels.map(c=>'<div class="flex items-center justify-between rounded-2xl border line bg-[#0f1722] p-4">'+
    '<div class="flex items-center gap-3"><span class="text-2xl">'+c.icon+'</span><div><p class="font-black text-white">'+esc(c.name)+'</p><p class="text-xs text-zinc-500">'+c.bot+'</p></div></div>'+
    '<button onclick="runFlush('+c.id+')" class="h-10 px-5 rounded-xl bg-yellow-400 text-black font-black text-sm">⚡ Flush</button>'+
  '</div>').join('');
}

async function runFlush(channelId){
  const btn=event.target;
  btn.disabled=true;btn.innerText='⏳ Đang lấy...';
  const result=$('flushResult');
  try{
    const r=await api('POST','/import/flush/'+channelId);
    if(result){
      result.classList.remove('hidden');
      result.innerHTML='✅ Flush xong: <b>'+r.messages+'</b> tin nhắn mới, <b>'+r.new_contacts+'</b> contact mới được tạo.'+
        (r.messages===0?' <span class="text-zinc-500">(Không có tin nhắn pending — đã được Respond.io consume hết)</span>':'');
    }
    if(r.messages>0){await loadConversations(channelId);renderAll();}
    showToast('Flush xong','+'+ r.messages+' tin, +'+r.new_contacts+' contacts');
  }catch(e){
    if(result){result.classList.remove('hidden');result.className='mt-4 rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-300 text-sm';result.textContent='Lỗi: '+e.message;}
  }finally{btn.disabled=false;btn.innerText='⚡ Flush';}
}

function renderImportChannelPicker(type){
  const box=$(type+'ChannelSelect');
  if(!box)return;
  box.innerHTML=channels.map(c=>'<label class="flex items-center gap-3 rounded-xl border line bg-[#0f1722] p-3 cursor-pointer hover:bg-white/5">'+
    '<input type="radio" name="'+type+'Channel" value="'+c.id+'" onchange="setImportChannel(\''+type+'\','+c.id+')" class="accent-yellow-400" '+(channels.indexOf(c)===0?'checked':'')+'>'+
    '<span class="text-xl">'+c.icon+'</span>'+
    '<div><p class="font-black text-white text-sm">'+esc(c.name)+'</p><p class="text-[11px] text-zinc-500">'+c.bot+'</p></div>'+
  '</label>').join('');
  if(channels.length){
    if(type==='csv') _importCsvChannelId=channels[0].id;
    if(type==='json') _importJsonChannelId=channels[0].id;
  }
}
function setImportChannel(type,id){if(type==='csv')_importCsvChannelId=id;if(type==='json')_importJsonChannelId=id;}

function loadImportFile(e,type){
  const file=e.target.files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=ev=>{
    if(type==='csv')$('csvImportText').value=ev.target.result;
    if(type==='json')$('jsonImportText').value=ev.target.result;
  };
  reader.readAsText(file,'UTF-8');
  e.target.value='';
}

// ── CSV parser
function parseCSV(text){
  const lines=text.trim().split('\n').filter(l=>l.trim());
  if(lines.length<2)return{headers:[],rows:[]};
  const parseRow=line=>{
    const r=[];let cur='',inQ=false;
    for(let i=0;i<line.length;i++){
      const c=line[i];
      if(c==='"'){inQ=!inQ;}
      else if(c===','&&!inQ){r.push(cur.trim());cur='';}
      else cur+=c;
    }
    r.push(cur.trim());return r;
  };
  const headers=parseRow(lines[0]).map(h=>h.replace(/['"]/g,'').toLowerCase().trim());
  const rows=lines.slice(1).map(l=>{
    const vals=parseRow(l);
    const obj={};
    headers.forEach((h,i)=>obj[h]=vals[i]?.replace(/^"|"$/g,'')||'');
    return obj;
  });
  return{headers,rows};
}

function mapCsvToContact(row){
  // Try common field names from different CRMs
  const tid=row.telegram_id||row.telegramid||row['telegram id']||row.tg_id||row.chat_id||row.chatid||'';
  const fn=row.first_name||row.firstname||row.name?.split(' ')[0]||row.full_name?.split(' ')[0]||'';
  const ln=row.last_name||row.lastname||row.name?.split(' ').slice(1).join(' ')||row.full_name?.split(' ').slice(1).join(' ')||'';
  return{telegram_id:tid.toString().replace(/\D/g,''),first_name:fn,last_name:ln,username:row.username||row.user_name||'',lifecycle:row.lifecycle||row.stage||row.status||'New Lead',notes:row.notes||row.note||'',sale:row.sale||row.assigned_to||row.owner||'',tags:row.tags?row.tags.split(/[,;]/).map(t=>t.trim()).filter(Boolean):[]};
}

function previewCsvImport(){
  const text=$('csvImportText')?.value||'';
  if(!text.trim()){showToast('Trống','Nhập CSV trước');return;}
  const{rows}=parseCSV(text);
  const mapped=rows.map(mapCsvToContact).filter(r=>r.telegram_id);
  const box=$('csvPreviewBox');
  if(!box)return;
  box.classList.remove('hidden');
  box.innerHTML='<p class="font-black text-white mb-2">Preview: '+mapped.length+'/'+rows.length+' dòng hợp lệ</p>'+
    mapped.slice(0,10).map(c=>'<div class="py-1.5 border-b border-white/5 flex gap-3"><span class="text-yellow-300 shrink-0">'+c.telegram_id+'</span><span class="text-white">'+esc(c.first_name+' '+c.last_name)+'</span><span class="text-zinc-500 truncate">'+esc(c.lifecycle)+'</span></div>').join('')+
    (mapped.length>10?'<p class="text-zinc-600 text-center mt-2">... và '+(mapped.length-10)+' dòng khác</p>':'');
}

async function runCsvImport(){
  const text=$('csvImportText')?.value||'';
  if(!text.trim()){showToast('Trống','Nhập CSV trước');return;}
  if(!_importCsvChannelId){showToast('Chọn channel','Chọn channel đích trước');return;}
  const{rows}=parseCSV(text);
  const mapped=rows.map(mapCsvToContact).filter(r=>r.telegram_id);
  if(!mapped.length){showToast('Không có dữ liệu','Không tìm thấy telegram_id trong CSV');return;}
  const result=$('csvImportResult');
  try{
    const r=await api('POST','/import/contacts',{rows:mapped,channel_id:_importCsvChannelId});
    if(result){result.classList.remove('hidden');result.className='mt-4 rounded-2xl border border-green-500/20 bg-green-500/10 p-4 text-green-300 text-sm';result.innerHTML='✅ Import xong: <b>'+r.imported+'</b> mới, <b>'+r.updated+'</b> cập nhật, <b>'+r.skipped+'</b> bỏ qua.';}
    await loadConversations(_importCsvChannelId);renderAll();
    showToast('Import xong',r.imported+' contacts mới');
  }catch(e){
    if(result){result.classList.remove('hidden');result.className='mt-4 rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-300 text-sm';result.textContent='Lỗi: '+e.message;}
  }
}

// ── JSON parser — hỗ trợ nhiều format
function parseImportJson(raw){
  let data;
  try{data=JSON.parse(raw);}catch(e){throw new Error('JSON không hợp lệ: '+e.message);}
  let contacts=[], messages=[];

  // Unicorn / Telethon format: {contacts:[...], messages:[...]}
  if(data.contacts||data.messages){
    contacts=data.contacts||[];
    messages=data.messages||[];
  }
  // Respond.io format: [{id,name,channels:[{type,identifier}],conversations:[{messages:[...]}]}]
  else if(Array.isArray(data)&&data[0]?.channels){
    for(const item of data){
      const tgChannel=item.channels?.find(c=>c.type==='telegram'||c.type==='telegramChannel');
      const tid=tgChannel?.identifier||tgChannel?.id||'';
      if(!tid)continue;
      const name=(item.name||'').split(' ');
      contacts.push({telegram_id:String(tid),first_name:name[0]||'',last_name:name.slice(1).join(' ')});
      for(const conv of(item.conversations||[])){
        for(const msg of(conv.messages||[])){
          messages.push({telegram_id:String(tid),text:msg.content||msg.text||'',direction:msg.direction==='outbound'?'out':'in',sender_name:msg.author?.name||'',created_at:msg.createdAt||msg.created_at||''});
        }
      }
    }
  }
  // Plain array of messages
  else if(Array.isArray(data)&&data[0]?.telegram_id){
    messages=data;
  }
  return{contacts,messages};
}

function previewJsonImport(){
  const text=$('jsonImportText')?.value||'';
  if(!text.trim()){showToast('Trống','Nhập JSON trước');return;}
  try{
    const{contacts,messages}=parseImportJson(text);
    const box=$('jsonPreviewBox');
    if(!box)return;
    box.classList.remove('hidden');
    box.innerHTML='<p class="font-black text-white mb-2">'+contacts.length+' contacts, '+messages.length+' messages</p>'+
      contacts.slice(0,8).map(c=>'<div class="py-1 border-b border-white/5 flex gap-3"><span class="text-yellow-300 shrink-0">'+esc(String(c.telegram_id))+'</span><span class="text-white">'+esc((c.first_name||'')+' '+(c.last_name||''))+'</span></div>').join('');
  }catch(e){showToast('Lỗi parse',''+e.message);}
}

async function runJsonImport(){
  const text=$('jsonImportText')?.value||'';
  if(!text.trim()){showToast('Trống','Nhập JSON trước');return;}
  const result=$('jsonImportResult');
  try{
    const{contacts,messages}=parseImportJson(text);
    let contactRes={imported:0,updated:0,skipped:0}, msgRes={imported:0,skipped:0};
    // Import contacts first
    if(contacts.length&&_importJsonChannelId){
      contactRes=await api('POST','/import/contacts',{rows:contacts,channel_id:_importJsonChannelId});
    }
    // Then messages
    if(messages.length){
      msgRes=await api('POST','/import/messages',{messages});
    }
    if(result){
      result.classList.remove('hidden');
      result.className='mt-4 rounded-2xl border border-green-500/20 bg-green-500/10 p-4 text-green-300 text-sm';
      result.innerHTML='✅ Import xong:<br>Contacts: <b>'+contactRes.imported+'</b> mới, <b>'+contactRes.updated+'</b> cập nhật<br>Messages: <b>'+msgRes.imported+'</b> mới, <b>'+msgRes.skipped+'</b> bỏ qua (contact chưa tồn tại)'+
        (msgRes.skipped>0?'<br><span class="text-zinc-500 text-xs">Tip: Import contacts trước, rồi import messages để giảm số bỏ qua</span>':'');
    }
    if(contacts.length&&_importJsonChannelId){await loadConversations(_importJsonChannelId);}
    renderAll();
    showToast('Import xong',contactRes.imported+' contacts + '+msgRes.imported+' messages');
  }catch(e){
    if(result){result.classList.remove('hidden');result.className='mt-4 rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-300 text-sm';result.textContent='Lỗi: '+e.message;}
  }
}

function copyExportScript(){
  if(navigator.clipboard)navigator.clipboard.writeText(EXPORT_SCRIPT).then(()=>showToast('Đã copy','Script đã được copy vào clipboard'));
}

checkLoginSession();
let channels=[];
const packages=['Premium','3 Month','Lifetime','Ultimate'];
let stages=['New Lead','Tiềm năng','PENDING PAYM...','Đã PAID','└ Premium','└ 3 Month','└ Lifetime','└ Ultimate','RENEW','Không tiềm năng','Khách phá','Đã chặn bot'];
let leads=[];
let activeChannel=null,activeStage='all',activeFolderFilter='all',activeLead=null,panelOpen=true,processedOpen=false,onlyUnreplied=false,searchOpen=false,lifecycleManageOpen=false;
const $=id=>{
  const el=document.getElementById(id);
  if(el)return el;
  return {
    innerHTML:'',innerText:'',value:'',style:{},scrollTop:0,scrollHeight:0,
    classList:{add(){},remove(){},toggle(){},contains(){return false}},
    querySelector(){return null},querySelectorAll(){return []},
    insertAdjacentHTML(){},focus(){},click(){},appendChild(){},setAttribute(){},removeAttribute(){}
  };
};
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function initials(n){return n.split(' ').map(x=>x[0]).slice(0,2).join('').toUpperCase()}

// Avatar với fallback initials
function avt(contactId, name, cls, fsize){
  const ini=initials(name);
  const fs=fsize||'text-[11px]';
  return '<div class="'+cls+' rounded-full overflow-hidden bg-gradient-to-br from-purple-500 to-blue-500 grid place-items-center '+fs+' font-black text-white shrink-0" style="position:relative">'+
    '<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:inherit">'+esc(ini)+'</span>'+
    '<img src="/avatar/'+contactId+'" loading="lazy" onerror="this.remove()" style="width:100%;height:100%;object-fit:cover;position:relative;z-index:1" />'+
  '</div>';
}
function isPkgStage(s){return s.indexOf('└')===0}
function cleanPkg(s){return s.replace('└','').trim()}
function getCurrentUserName(){try{const s=JSON.parse(localStorage.getItem(LOGIN_KEY)||'{}');return(s.user?.name||s.name||'').toLowerCase()}catch{return''}}
function filtered(){
  const myName=getCurrentUserName();
  return leads.filter(l=>{
    if(l.c!==activeChannel)return false;
    if(activeFolderFilter==='mine'&&l.sale?.toLowerCase()!==myName)return false;
    if(activeFolderFilter==='unassigned'&&l.sale&&l.sale!=='Unassigned')return false;
    if(onlyUnreplied&&!l.unread)return false;
    const keyword=($('searchInput').value||'').toLowerCase().trim();
    if(keyword&&!l.n.toLowerCase().includes(keyword))return false;
    if(activeStage==='all')return true;
    if(isPkgStage(activeStage))return l.stage==='Đã PAID'&&l.pkg===cleanPkg(activeStage);
    return l.stage===activeStage;
  });
}
function count(s){if(s==='all')return leads.filter(l=>l.c===activeChannel).length;if(isPkgStage(s))return leads.filter(l=>l.c===activeChannel&&l.stage==='Đã PAID'&&l.pkg===cleanPkg(s)).length;return leads.filter(l=>l.c===activeChannel&&l.stage===s).length}
function renderFolders(){
  const myName=getCurrentUserName();
  const inCh=l=>l.c===activeChannel;
  const allC=leads.filter(inCh).length;
  const mineC=leads.filter(l=>inCh(l)&&l.sale?.toLowerCase()===myName).length;
  const unassignedC=leads.filter(l=>inCh(l)&&(!l.sale||l.sale==='Unassigned')).length;
  const data=[['📥','Tất cả',allC,'all'],['🧑‍💼','Của tôi',mineC,'mine'],['☒','Chưa chỉ định',unassignedC,'unassigned']];
  $('mainFolders').innerHTML=data.map(x=>'<button onclick="openFolder(\''+x[3]+'\')" class="w-full h-10 px-2 rounded-xl flex items-center gap-3 '+(activeFolderFilter===x[3]?'life-active':'text-zinc-400 hover:text-white hover:bg-white/5')+'"><span class="w-6">'+x[0]+'</span><span class="truncate">'+x[1]+'</span>'+(x[2]?'<span class="ml-auto text-zinc-300">'+x[2]+'</span>':'')+'</button>').join('');
}
function renderLifecycle(){const icons={'New Lead':'🆕','Tiềm năng':'✨','PENDING PAYM...':'💵','Đã PAID':'📁','RENEW':'♻️','Không tiềm năng':'😐','Khách phá':'💀','Đã chặn bot':'🚫'};const pkgItems=['└ Premium','└ 3 Month','└ Lifetime','└ Ultimate'];let html='';stages.filter(s=>!isPkgStage(s)).forEach(s=>{html+='<button onclick="setStage(\''+s+'\')" class="w-full h-10 rounded-xl px-2 flex items-center gap-3 '+(activeStage===s?'life-active':'text-zinc-400 hover:bg-white/5 hover:text-white')+'"><span class="w-6">'+(icons[s]||'•')+'</span><span class="truncate">'+s+'</span><span class="ml-auto text-zinc-300">'+(count(s)||'')+'</span></button>';if(s==='Đã PAID'){html+='<button onclick="toggleProcessed()" class="w-full h-8 rounded-xl pl-10 pr-2 flex items-center gap-3 text-zinc-500 hover:text-white hover:bg-white/5"><span class="w-6">'+(processedOpen?'▾':'▸')+'</span><span class="truncate text-sm">Gói khách hàng</span></button>';if(processedOpen){pkgItems.forEach((p,idx)=>{const icons2=['⭐','🗓️','♾️','👑'];html+='<button onclick="setStage(\''+p+'\')" class="w-full h-9 rounded-xl pl-14 pr-2 flex items-center gap-3 '+(activeStage===p?'life-active':'text-zinc-400 hover:bg-white/5 hover:text-white')+'"><span class="w-5">'+icons2[idx]+'</span><span class="truncate text-sm">'+p.replace('└','')+'</span><span class="ml-auto text-zinc-300">'+(count(p)||'')+'</span></button>'})}}});$('lifecycleMenu').innerHTML=html}
function renderTabs(){
  $('channelTabs').innerHTML=channels.map(c=>{
    const unread=leads.filter(l=>l.c===c.id&&l.unread>0).reduce((s,l)=>s+(l.unread||0),0);
    const badge=unread?'<span style="background:#ef4444;color:#fff;font-size:11px;font-weight:900;border-radius:999px;padding:1px 7px;min-width:20px;text-align:center;line-height:18px;">'+unread+'</span>':'';
    return '<button onclick="setChannel('+c.id+')" class="shrink-0 h-full px-8 border-r line flex items-center gap-3 font-black '+(activeChannel===c.id?'tab-active':'text-white hover:bg-white/5')+'"><span class="text-2xl">'+c.icon+'</span>'+c.name+badge+'</button>';
  }).join('');
}
function renderList(){const rows=filtered();$('pageCount').innerText='Hiển thị 1 - '+rows.length+' của '+count('all');$('conversationList').innerHTML=rows.map(l=>'<button onclick="selectLead('+l.id+')" class="row w-full min-h-[68px] px-4 py-2.5 border-b line flex gap-3 text-left '+(activeLead?.id===l.id?'bg-white/5':'')+'">'+ avt(l.id,l.n,'w-8 h-8')+'<div class="min-w-0 flex-1"><div class="flex justify-between items-center gap-2"><p class="font-black text-[14px] text-white truncate">'+l.n+'</p><span class="text-[11px] text-zinc-500 shrink-0">'+l.time+'</span></div><p class="mt-0.5 text-[12px] text-zinc-400 truncate">'+l.msg+'</p></div>'+(l.unread?'<span class="badge mt-5">'+l.unread+'</span>':'')+'</button>').join('')||'<div class="p-8 text-zinc-500">Không có khách trong mục này.</div>'}
function chatBubble(text,time,side,meta,id,status){
  const msgId=id||('msg_'+Date.now()+Math.floor(Math.random()*999));
  const right=side==='right';
  const bubbleClass=right
    ? 'rounded-[20px] rounded-br-[4px] bg-yellow-400 text-black px-4 py-3'
    : 'rounded-[20px] rounded-bl-[4px] bg-[#1a2535] border border-white/8 px-4 py-3';
  const textClass=right
    ? 'text-[14px] leading-6 text-black'
    : 'text-[14px] leading-6 text-white';
  const timeClass=right?'text-black/50':'text-zinc-500';
  const safeText=String(text).replaceAll('`','&#96;').replaceAll('"','&quot;');
  const statusHtml=right?(status==='seen'?'<span class="seen-check text-[10px] text-sky-500 ml-1">✓✓</span>':status==='sent'?'<span class="seen-check text-[10px] text-black/40 ml-1">✓</span>':'<span class="seen-check text-[10px] text-black/30 ml-1">⏳</span>'):'';

  return `
    <div class="flex ${right?'justify-end':'justify-start'} bubble msg-wrap group relative" data-msg-id="${msgId}" data-msg-text="${safeText}" oncontextmenu="openMessageMenu(event,this)">
      <div style="max-width:72%; display:inline-block;">
        <div class="${bubbleClass}" style="display:inline-block; min-width:80px; max-width:100%; word-break:break-word; overflow-wrap:break-word;">
          ${meta?`<div class="text-[11px] font-black mb-1 ${right?'text-black/50':'text-yellow-300'} uppercase tracking-wide">${meta}</div>`:''}
          <p class="${textClass}" style="white-space:pre-wrap;">${text}</p>
          <div style="display:flex; justify-content:flex-end; align-items:center; margin-top:4px; gap:3px;">
            <span class="text-[11px] ${timeClass}" style="white-space:nowrap;">${time}</span>
            ${statusHtml}
          </div>
          <div class="msg-reacts flex flex-wrap gap-1 mt-1"></div>
        </div>
      </div>
    </div>
  `;
}
function renderTypingIndicator(){
  return '<div id="typingIndicator" class="hidden flex justify-start"><div class="rounded-3xl rounded-bl-md bg-[#151f2a] border line px-4 py-3 flex items-center gap-2"><span class="text-xs text-zinc-400 mr-1">Khách đang nhập</span><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div></div>';
}
function renderChat(){
  if(!activeLead){
    $('chatHeader').innerHTML='';
    $('chatBody').innerHTML='<div class="flex items-center justify-center h-full"><p class="text-zinc-500 text-sm">Chọn một hội thoại để bắt đầu</p></div>';
    $('customerPanel').classList.add('hide');
    return;
  }
  const c=channels.find(x=>x.id===activeLead.c);
  const _online=isOnline(activeLead);
  $('chatHeader').innerHTML=`<div class="flex items-center gap-3 min-w-0">${avt(activeLead.id,activeLead.n,'w-10 h-10','text-sm')}<div><h2 class="text-base font-black text-white">${activeLead.n}</h2><p id="presenceLabel" class="text-sm ${_online?'text-green-400':'text-zinc-500'}">${activeLead.typing?'đang nhập...':(_online?'🟢 Online':getOfflineText())}</p></div></div><div class="flex items-center gap-2"><button onclick="openTelegramPreview()" class="h-10 px-3 rounded-xl bg-white/10 border border-white/15 hover:bg-white/20 text-zinc-200 font-black text-sm flex items-center gap-2 shadow-md transition-all duration-150" title="Xuất ảnh feedback"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg><span>Xuất ảnh</span></button><button onclick="togglePanel()" class="h-10 px-4 rounded-xl bg-white/10 border border-white/15 hover:bg-yellow-400/20 hover:border-yellow-400/40 text-zinc-100 hover:text-yellow-300 font-black text-sm flex items-center gap-2 shadow-md transition-all duration-150"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" class="text-yellow-300 shrink-0"><circle cx="12" cy="12" r="9"></circle><path d="M12 8h.01"></path><path d="M11 12h1v4h1"></path></svg><span>Thông tin khách</span></button></div>`;
  if(activeLead.messages){
    const msgs=activeLead.messages;
    // Gộp ảnh có cùng media_group_id thành album
    const grouped=[];
    const seenGroups=new Set();
    for(const m of msgs){
      if(m.media_group_id){
        if(seenGroups.has(m.media_group_id))continue;
        seenGroups.add(m.media_group_id);
        grouped.push({type:'album',msgs:msgs.filter(x=>x.media_group_id===m.media_group_id),ref:m});
      } else {
        grouped.push({type:'single',msg:m});
      }
    }
    const bubbles=grouped.map(item=>{
      if(item.type==='album'){
        const m=item.ref;
        const side=m.direction==='out'?'right':'left';
        const meta=m.direction==='out'?(m.sender_name||'You'):'';
        return chatAlbumBubble(item.msgs,formatMsgTime(m.created_at),side,meta);
      }
      const m=item.msg;
      const side=m.direction==='out'?'right':'left';
      const meta=m.direction==='out'?(m.sender_name||'You'):'';
      const content=msgContent(m);
      return chatBubble(content,formatMsgTime(m.created_at),side,meta,'msg_'+m.id,m.direction==='out'?'seen':'');
    }).join('');
    $('chatBody').innerHTML='<div class="max-w-6xl mx-auto space-y-8">'+(msgs.length===0?'<div class="flex justify-center"><span class="px-4 py-2 rounded-full bg-white/5 text-xs text-zinc-400">Chưa có tin nhắn</span></div>':'')+bubbles+renderTypingIndicator()+'</div>';
    // Render reactions cho từng message
    msgs.forEach(m=>{
      if(m.reactions){
        const reactions=typeof m.reactions==='string'?JSON.parse(m.reactions):m.reactions;
        const wrap=document.querySelector('[data-msg-id="msg_'+m.id+'"]');
        if(wrap){const el=wrap.querySelector('.msg-reacts');if(el)renderReactionsInEl(el,reactions)}
      }
    });
    setTimeout(()=>{$('chatBody').scrollTop=$('chatBody').scrollHeight},30);
  }else{
    $('chatBody').innerHTML='<div class="flex items-center justify-center h-full"><p class="text-zinc-500 text-sm">Đang tải tin nhắn...</p></div>';
  }
  renderPanel();
}
function customerTimelineBox(){
  const items=activeLead.timeline||[];
  return '<div class="rounded-2xl border line p-4">'+
    '<p class="text-sm font-black mb-3">Customer Timeline</p>'+
    '<div class="grid grid-cols-2 gap-2 mb-4">'+
      '<div class="rounded-xl bg-white/5 p-3"><p class="text-[11px] text-zinc-500">Lần đầu click bot</p><b class="text-xs text-white">'+(activeLead.firstClick||'Unknown')+'</b></div>'+
      '<div class="rounded-xl bg-white/5 p-3"><p class="text-[11px] text-zinc-500">Nguồn lead</p><b class="text-xs text-yellow-300">'+(activeLead.source||'Unknown')+'</b></div>'+
      '<div class="rounded-xl bg-white/5 p-3"><p class="text-[11px] text-zinc-500">Renew</p><b class="text-xs text-green-300">'+(activeLead.renewAt||'Chưa đến hạn')+'</b></div>'+
      '<div class="rounded-xl bg-white/5 p-3"><p class="text-[11px] text-zinc-500">Broadcast gần nhất</p><b class="text-xs text-zinc-300">'+(activeLead.lastBroadcast||'None')+'</b></div>'+
    '</div>'+
    '<div class="space-y-3">'+items.map(x=>'<div class="flex gap-3"><div class="w-2 h-2 rounded-full bg-yellow-400 mt-2 shrink-0"></div><div><p class="text-sm font-black text-white">'+x.t+'</p><p class="text-xs text-zinc-500 mt-1">'+x.d+'</p></div></div>').join('')+'</div>'+
  '</div>';
}
function renderPanel(){
  if(!panelOpen||!activeLead){$('customerPanel').classList.add('hide');return}
  $('customerPanel').classList.remove('hide');

  let stageBtns=['New Lead','Tiềm năng','PENDING PAYM...','Đã PAID','RENEW','Không tiềm năng','Khách phá','Đã chặn bot'].map(s=>'<button onclick="changeStage(\''+s+'\')" class="h-10 rounded-xl text-xs font-black '+(activeLead.stage===s?'bg-yellow-400 text-black':'bg-white/5 text-zinc-300')+'">'+s+'</button>').join('');

  let packageBox='';
  if(activeLead.stage==='Đã PAID'){
    packageBox='<div class="rounded-2xl border line p-4 space-y-4">'+
      '<div>'+
        '<p class="text-[11px] text-zinc-500 uppercase mb-1">Payment</p>'+
        '<div class="rounded-2xl bg-white/5 p-4">'+
          '<div class="grid grid-cols-2 gap-2">'+
            '<input value="'+(activeLead.payPlan||activeLead.pkg||'Lifetime')+'" onchange="activeLead.payPlan=this.value" class="col-span-1 h-9 rounded-xl bg-black/25 border line px-3 outline-none text-xs font-black text-white" placeholder="Plan">'+
            '<input value="'+(activeLead.payAmount||'399 USDT')+'" onchange="activeLead.payAmount=this.value" class="col-span-1 h-9 rounded-xl bg-black/25 border line px-3 outline-none text-xs font-black text-white" placeholder="Amount">'+
            '<input value="'+(activeLead.payWallet||'TRC20')+'" onchange="activeLead.payWallet=this.value" class="col-span-2 h-9 rounded-xl bg-black/25 border line px-3 outline-none text-xs text-zinc-300" placeholder="Wallet / Network">'+
          '</div>'+
          '<div class="mt-3">'+
            '<p class="text-[10px] text-zinc-500 uppercase mb-1">TXID</p>'+
            '<input value="'+(activeLead.payTxid||'8sd8as9d...')+'" onchange="activeLead.payTxid=this.value" class="w-full h-9 rounded-xl bg-black/25 border line px-3 outline-none text-xs text-zinc-300" placeholder="Transaction hash">'+
          '</div>'+
          '<div class="mt-3 grid grid-cols-2 gap-2 text-xs">'+
            '<label class="text-zinc-500">Renew<input value="'+(activeLead.payRenew||'27/5')+'" onchange="activeLead.payRenew=this.value" class="mt-1 w-full h-8 rounded-xl bg-black/25 border line px-3 outline-none text-yellow-300"></label>'+
            '<label class="text-zinc-500">Sale<input value="'+(activeLead.paySale||activeLead.sale||'Tony')+'" onchange="activeLead.paySale=this.value" class="mt-1 w-full h-8 rounded-xl bg-black/25 border line px-3 outline-none text-white"></label>'+
          '</div>'+
          '<textarea onchange="activeLead.payNote=this.value" class="mt-3 w-full h-[62px] rounded-xl bg-black/25 border line p-3 outline-none resize-none text-xs text-zinc-300 leading-5" placeholder="Note">'+(activeLead.payNote||'BTC futures\nPotential upsale')+'</textarea>'+
          '<button onclick="confirmPaymentInfo()" class="mt-3 w-full h-10 rounded-xl bg-yellow-400 text-black text-sm font-black">Confirm</button>'+
        '</div>'+
      '</div>'+
      '<div>'+
        '<div class="flex items-center justify-between mb-3">'+
          '<p class="text-sm font-black">Phân nhóm gói khách</p>'+
          '<span class="text-[11px] text-violet-300 bg-violet-500/10 px-2 py-1 rounded-lg">Đã PAID</span>'+
        '</div>'+
        '<div class="grid grid-cols-2 gap-2">'+
          packages.map(p=>'<button onclick="changePackage(\''+p+'\')" class="h-10 rounded-xl text-xs font-black '+(activeLead.pkg===p?'bg-violet-500 text-white':'bg-white/5 text-zinc-300 hover:bg-white/10')+'">'+p+'</button>').join('')+
        '</div>'+
      '</div>'+
    '</div>';
  }

  const langMap={'vi':'🇻🇳 Tiếng Việt','en':'🇬🇧 English','zh':'🇨🇳 Chinese','ja':'🇯🇵 Japanese','ko':'🇰🇷 Korean','ru':'🇷🇺 Russian','th':'🇹🇭 Thai','id':'🇮🇩 Indonesian','fr':'🇫🇷 French','de':'🇩🇪 German','es':'🇪🇸 Spanish','pt':'🇧🇷 Portuguese','ar':'🇸🇦 Arabic','tr':'🇹🇷 Turkish','uk':'🇺🇦 Ukrainian'};
  const langDisplay=activeLead.language_code?(langMap[activeLead.language_code]||('🌐 '+activeLead.language_code.toUpperCase())):'';
  const premiumBadge=activeLead.is_premium?'<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-yellow-400/20 text-yellow-300 text-[10px] font-black">⭐ Premium</span>':'';
  const tgInfoRows=[
    activeLead.phone?'<div class="flex justify-between text-xs"><span class="text-zinc-500">📞 Số điện thoại</span><span class="text-white font-black">'+activeLead.phone+'</span></div>':'',
    langDisplay?'<div class="flex justify-between text-xs"><span class="text-zinc-500">🌐 Ngôn ngữ</span><span class="text-white">'+langDisplay+'</span></div>':'',
    activeLead.avatar_updated_at?'<div class="flex justify-between text-xs"><span class="text-zinc-500">🖼 Avatar</span><span class="text-zinc-400">'+activeLead.avatar_updated_at.slice(0,16).replace('T',' ')+'</span></div>':'',
    '<div class="flex justify-between text-xs"><span class="text-zinc-500">🆔 Telegram ID</span><span class="text-zinc-400 font-mono">'+activeLead.telegramId+'</span></div>',
    activeLead.firstClick?'<div class="flex justify-between text-xs"><span class="text-zinc-500">📅 Lần đầu nhắn</span><span class="text-zinc-400">'+activeLead.firstClick+'</span></div>':'',
  ].filter(Boolean).join('');
  const tgInfoBox=tgInfoRows?'<div class="rounded-2xl border line p-4 space-y-2.5">'+tgInfoRows+'</div>':'';

  $('customerPanel').innerHTML='<div class="h-[72px] border-b line px-5 flex items-center justify-between"><h3 class="font-black text-white">Thông tin khách</h3><button onclick="togglePanel()" class="w-11 h-11 rounded-2xl bg-white/5 hover:bg-yellow-400/10 border line flex items-center justify-center text-zinc-300 hover:text-yellow-300 transition-all duration-200 text-2xl font-black -mr-1">❯</button></div><div class="p-5 space-y-5"><div class="flex gap-3 items-center">'+avt(activeLead.id,activeLead.n,'w-14 h-14','text-base')+'<div><p class="text-xl font-black text-white">'+activeLead.n+'</p><p class="text-zinc-500 text-sm mt-0.5">'+activeLead.u+'</p><div class="flex items-center gap-2 mt-1">'+premiumBadge+'</div></div></div>'+tgInfoBox+'<div class="rounded-2xl border line p-4"><p class="text-sm font-black mb-3">Chuyển vòng đời</p><div class="grid grid-cols-2 gap-2">'+stageBtns+'</div></div>'+packageBox+customerTimelineBox()+'</div>'
}
async function setChannel(id){
  activeChannel=id;activeStage='all';activeFolderFilter='all';
  await loadConversations(id);
  activeLead=filtered()[0]||leads.find(l=>l.c===id)||null;
  if(activeLead){
    try{
      const msgs=await api('GET','/conversations/'+activeLead.id+'/messages');
      activeLead.messages=msgs;
    }catch(e){}
  }
  renderAll();
}
function setStage(s){activeStage=s;activeFolderFilter='all';if(isPkgStage(s))processedOpen=true;activeLead=filtered()[0]||activeLead;renderAll()}
function toggleProcessed(){processedOpen=!processedOpen;renderLifecycle()}
async function selectLead(id){
  activeLead=leads.find(l=>l.id===id)||activeLead;
  if(!activeLead)return;
  activeLead.messages=null;
  activeLead.unread=0;
  renderAll();
  renderList();
  renderTabs();
  api('POST','/conversations/'+id+'/read').catch(()=>{});
  try{
    const msgs=await api('GET','/conversations/'+id+'/messages');
    activeLead.messages=msgs;
    renderChat();
  }catch(e){console.error('Lỗi tải messages:',e)}
}

function triggerAutoWelcome(lead){
  if(!lead||lead.autoWelcomed)return;

  const welcomeIndex=quickReplies.findIndex(x=>x.key==='/hello');
  if(welcomeIndex===-1)return;

  lead.autoWelcomed=true;

  setTimeout(()=>{
    const item=quickReplies[welcomeIndex];
    const wrap=$('chatBody')?.querySelector('.max-w-6xl');
    if(!wrap)return;

    const text=esc(item.text)
      .split(String.fromCharCode(10))
      .join('<br>');

    let filesHtml='';

    if(item.files&&item.files.length){
      filesHtml=renderAttachmentHtml(
        item.files.map(name=>({
          name:name,
          kind:name.match(/\.(png|jpg|jpeg|gif|webp)$/i)?'image':'file',
          url:'',
          size:0
        })),
        true
      );
    }

    wrap.insertAdjacentHTML(
      'beforeend',
      chatBubble(text+filesHtml,'Now','right','BOT')
    );

    $('chatBody').scrollTop=$('chatBody').scrollHeight;
  },900);
}
function changeStage(s){
  if(!activeLead)return;
  activeLead.stage=s;
  if(s==='Đã PAID'&&!activeLead.pkg){activeLead.pkg='Premium'}
  api('PATCH','/conversations/'+activeLead.id,{lifecycle:s}).catch(()=>{});
  renderAll();updateBroadcastAudience();renderReports();
}
function changePackage(p){
  if(!activeLead)return;
  activeLead.pkg=p;activeLead.stage='Đã PAID';activeLead.payPlan=activeLead.payPlan||p;processedOpen=true;
  api('PATCH','/conversations/'+activeLead.id,{lifecycle:'Đã PAID',package:p}).catch(()=>{});
  renderAll();updateBroadcastAudience();renderReports();
}
function confirmPaymentInfo(){
  activeLead.stage='Đã PAID';
  activeLead.pkg=activeLead.payPlan||activeLead.pkg||'Lifetime';
  activeLead.timeline=activeLead.timeline||[];
  activeLead.timeline.unshift({t:'Payment confirmed',d:(activeLead.payAmount||'399 USDT')+' • '+(activeLead.payWallet||'TRC20')+' • '+(activeLead.paySale||activeLead.sale||'Tony')});
  showToast('Payment confirmed',activeLead.n+' đã được xác nhận PAID');
  renderAll();
  renderReports();
}
function togglePanel(){panelOpen=!panelOpen;$('inboxShell').style.gridTemplateColumns=panelOpen?'318px minmax(0,1fr) 360px':'318px minmax(0,1fr) 0px';renderPanel()}

// Render album nhiều ảnh
function chatAlbumBubble(msgs, time, side, meta){
  const right=side==='right';
  const imgs=msgs.map(m=>{
    const src='/media/'+(m.channel_id||activeLead?.c)+'/'+m.file_id;
    return `<img src="${src}" loading="lazy" onerror="this.parentElement.removeChild(this)"
      data-msg-id="msg_${m.id}"
      style="width:140px;height:140px;object-fit:cover;border-radius:8px;cursor:pointer;flex-shrink:0;"
      onclick="window.open(this.src,'_blank')"
      oncontextmenu="openAlbumImgMenu(event,this)" />`;
  }).join('');
  const metaHtml=meta?`<div style="font-size:11px;font-weight:900;margin-bottom:6px;${right?'color:rgba(0,0,0,0.5)':'color:#facc15'};text-transform:uppercase;">${meta}</div>`:'';
  const timeClass=right?'color:rgba(0,0,0,0.5)':'color:#71717a';
  const bubbleStyle=right
    ?'background:#facc15;border-radius:20px 20px 4px 20px;padding:10px;display:inline-block;'
    :'background:#1a2535;border:1px solid rgba(255,255,255,0.08);border-radius:20px 20px 20px 4px;padding:10px;display:inline-block;';
  return `<div class="flex ${right?'justify-end':'justify-start'} bubble msg-wrap group relative" data-group-id="${msgs[0]?.media_group_id||''}">
    <div style="max-width:72%;">
      <div class="album-bubble" style="${bubbleStyle}">
        ${metaHtml}
        <div class="album-grid" style="display:flex;flex-wrap:wrap;gap:4px;max-width:290px;">${imgs}</div>
        <div style="display:flex;justify-content:flex-end;margin-top:4px;">
          <span style="font-size:11px;${timeClass}">${time}</span>
        </div>
      </div>
    </div>
  </div>`;
}

// Trả về HTML content cho bubble — xử lý ảnh nếu có file_id
function msgContent(m){
  if(m.file_id&&(m.media_type==='photo'||m.media_type==='sticker')){
    const src='/media/'+(m.channel_id||activeLead?.c)+'/'+m.file_id;
    let html='<img src="'+src+'" loading="lazy" onerror="this.style.display=\'none\'" style="display:block;max-width:220px;max-height:280px;border-radius:12px;object-fit:cover;cursor:pointer;" onclick="window.open(this.src,\'_blank\')" />';
    if(m.text&&m.text!=='[photo]'&&m.text!=='[sticker]')html+='<span style="display:block;margin-top:5px;">'+esc(m.text)+'</span>';
    return html;
  }
  if(m.media_type==='document'){
    const name=m.text?.replace(/^\[file:/,'').replace(/\]$/,'')||'document';
    return '📎 <b>'+esc(name)+'</b>';
  }
  if(m.media_type==='video')return '🎥 Video';
  if(m.media_type==='voice')return '🎙 Voice message';
  if(m.media_type==='gif')return '🎞 GIF';
  return esc(m.text||'');
}

let replyingMessage=null;
async function sendMsg(){
  const box=$('replyText');
  const txt=box.value.trim();
  // Nếu đang ở chế độ sửa tin nhắn
  if(editingMsg){
    if(!txt)return;
    const ok=await submitEdit(txt);
    if(ok)cancelEdit();
    return;
  }
  const imgAtts=pendingAttachments.filter(a=>a.kind==='image'&&a.url);
  if(!txt&&!imgAtts.length||!activeLead)return;

  const wrap=$('chatBody').querySelector('.max-w-6xl');
  const currentReply=replyingMessage; // lưu trước khi clear
  replyingMessage=null;
  pendingAttachments=[];
  renderQuickAttachPreview();
  hideReplyPreview();

  // ── gửi text
  if(txt){
    box.value='';
    box.style.height='34px';box.style.overflowY='hidden';
    let safe=esc(txt).split(String.fromCharCode(10)).join('<br>');
    const msgId='sale_'+Date.now();
    const tempMsg={id:msgId,text:txt,direction:'out',sender_name:'You',created_at:new Date().toISOString()};
    if(!activeLead.messages)activeLead.messages=[];
    activeLead.messages.push(tempMsg);
    activeLead.msg=txt;activeLead.time=formatMsgTime(tempMsg.created_at);
    if(wrap){wrap.insertAdjacentHTML('beforeend',chatBubble(safe,'Now','right','You',msgId,'sending'));setTimeout(()=>{$('chatBody').scrollTop=$('chatBody').scrollHeight},30);}
    try{
      const replyDbId=currentReply?.id?(currentReply.id+'').replace(/^(msg_|img_)/,''):null;
      const r=await api('POST','/reply',{contact_id:activeLead.id,text:txt,...(replyDbId&&!isNaN(Number(replyDbId))?{reply_to_msg_id:Number(replyDbId)}:{})});
      // Cập nhật data-msg-id từ ID tạm sang DB id thật
      if(r.message?.id){
        const el=wrap?.querySelector('[data-msg-id="'+msgId+'"]');
        if(el)el.dataset.msgId='msg_'+r.message.id;
      }
      updateMsgStatus(msgId,'sent');
      const idx=activeLead.messages.findIndex(m=>m.id===msgId);
      if(idx>-1)activeLead.messages[idx]=r.message;
      setTimeout(()=>updateMsgStatus(msgId,'seen'),1500);
    }catch(e){
      activeLead.messages=activeLead.messages.filter(m=>m.id!==msgId);
      if(wrap){const el=wrap.querySelector('[data-msg-id="'+msgId+'"]');if(el)el.remove();}
      if(e.message?.includes('chặn bot')||e.message?.includes('blocked')){
        showToast('🚫 Bị chặn','Khách hàng đã chặn bot. Không thể nhắn tin.');
        // Cập nhật badge lifecycle trên UI
        const badge=document.querySelector('#leadDetailPanel [data-lifecycle]');
        if(badge){badge.textContent='Blocked';badge.dataset.lifecycle='Blocked';}
      } else {
        showToast('Lỗi gửi tin',e.message);
      }
    }
  }

  // ── gửi ảnh (album hoặc đơn lẻ)
  if(imgAtts.length>0){
    // Render preview tạm
    const tempGroupId='tmpgrp_'+Date.now();
    const previewImgs=imgAtts.map((att,i)=>{
      const tid='img_'+Date.now()+'_'+i;
      return {tid,att};
    });
    if(imgAtts.length===1){
      const {tid,att}=previewImgs[0];
      if(wrap){wrap.insertAdjacentHTML('beforeend',chatBubble('<img src="'+att.url+'" style="display:block;max-width:220px;max-height:280px;border-radius:12px;object-fit:cover;" />','Now','right','You',tid,'sending'));setTimeout(()=>{$('chatBody').scrollTop=$('chatBody').scrollHeight},30);}
    } else {
      const previewGrid=previewImgs.map(({tid,att})=>`<img src="${att.url}" data-msg-id="${tid}" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;" />`).join('');
      const cols=imgAtts.length===2?2:3;
      const html=`<div class="flex justify-end bubble msg-wrap group relative" data-group-id="${tempGroupId}"><div style="max-width:72%"><div class="rounded-[20px] rounded-br-[4px] bg-yellow-400 p-2"><div class="text-[11px] font-black mb-2 text-black/50 uppercase tracking-wide">You</div><div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:4px;">${previewGrid}</div><div style="display:flex;justify-content:flex-end;margin-top:4px;"><span class="text-[11px] text-black/50">Now</span></div></div></div></div>`;
      if(wrap){wrap.insertAdjacentHTML('beforeend',html);setTimeout(()=>{$('chatBody').scrollTop=$('chatBody').scrollHeight},30);}
    }
    try{
      const r=await api('POST','/reply-photos',{contact_id:activeLead.id,images:imgAtts.map(a=>({base64:a.url,mime_type:a.type}))});
      if(!activeLead.messages)activeLead.messages=[];
      const now=new Date().toISOString();
      r.messages.forEach(m=>activeLead.messages.push({...m,contact_id:activeLead.id,channel_id:activeLead.c,direction:'out',sender_name:'You',created_at:now}));
      // Swap preview tạm → bubble thật, không reload toàn bộ
      const side='right',meta='You',time=formatMsgTime(now);
      let realHtml;
      if(r.messages.length===1){
        const m={...r.messages[0],channel_id:activeLead.c};
        realHtml=chatBubble(msgContent(m),time,side,meta,'msg_'+m.id,'sent');
      } else {
        const grouped=r.messages.map(m=>({...m,channel_id:activeLead.c}));
        realHtml=chatAlbumBubble(grouped,time,side,meta);
      }
      const tmpEl=imgAtts.length===1
        ?wrap?.querySelector('[data-msg-id="'+previewImgs[0].tid+'"]')?.closest('.msg-wrap')
        :wrap?.querySelector('[data-group-id="'+tempGroupId+'"]');
      if(tmpEl){tmpEl.outerHTML=realHtml;}
      else if(wrap){wrap.insertAdjacentHTML('beforeend',realHtml);}
    }catch(e){
      showToast('Lỗi gửi ảnh',e.message);
      if(imgAtts.length===1){const el=wrap?.querySelector('[data-msg-id="'+previewImgs[0].tid+'"]')?.closest('.msg-wrap');if(el)el.remove();}
      else{const el=wrap?.querySelector('[data-group-id="'+tempGroupId+'"]');if(el)el.remove();}
    }
  }

  box.value='';
  renderList();
}

function replyMessage(id,text){
  replyingMessage={id,text};
  const bar=$('replyPreviewBar');
  if(!bar)return;
  bar.classList.remove('hidden');
  bar.innerHTML='<div class="flex items-center justify-between gap-4"><div class="min-w-0"><p class="text-[11px] font-black text-yellow-300 uppercase">Replying message</p><p class="text-sm text-white truncate mt-1">'+text.replace(/<br>/g,' ')+'</p></div><button onclick="hideReplyPreview()" class="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-300">✕</button></div>';
  $('replyText').focus();
}

function hideReplyPreview(){
  replyingMessage=null;
  const bar=$('replyPreviewBar');
  if(bar){bar.classList.add('hidden');bar.innerHTML=''}
}

function addReactionToWrap(wrap,emoji){
  if(!wrap)return;

  const reacts=wrap.querySelector('.msg-reacts');
  if(!reacts)return;

  const existing=[...reacts.querySelectorAll('[data-emoji]')].find(el=>el.dataset.emoji===emoji);

  if(existing){
    existing.remove();
    return;
  }

  const reaction=document.createElement('button');
  reaction.type='button';
  reaction.dataset.emoji=emoji;
  reaction.className='px-2 py-1 rounded-full bg-white/10 hover:bg-white/15 text-xs flex items-center gap-1 transition cursor-pointer';
  reaction.innerHTML=emoji+' <span>1</span>';

  reaction.onclick=function(e){
    e.stopPropagation();
    this.remove();
  };

  reacts.appendChild(reaction);
}

function reactMessage(btn,emoji){
  const wrap=btn.closest('.msg-wrap');
  addReactionToWrap(wrap,emoji);
}

const extraReactions=['😍','👏','💯','🚀','🥶','😡','🙏','👀','💰','🎯','⚡','🤝'];

function openReactionPicker(btn){
  document.querySelectorAll('.floatingReactionPicker').forEach(el=>el.remove());

  const rect=btn.getBoundingClientRect();

  const box=document.createElement('div');
  box.className='floatingReactionPicker fixed z-[9999] rounded-2xl border line bg-[#101923] p-2 grid grid-cols-6 gap-1 shadow-2xl shadow-black/50';
  box.style.left=(rect.left-120)+'px';
  box.style.top=(rect.top-64)+'px';

  box.innerHTML=extraReactions.map(emoji=>{
    return '<button class="w-9 h-9 rounded-xl hover:bg-white/10 text-lg">'+emoji+'</button>';
  }).join('');

  document.body.appendChild(box);

  [...box.querySelectorAll('button')].forEach((button,index)=>{
    button.onclick=()=>{
      reactMessage(btn,extraReactions[index]);
      box.remove();
    };
  });
}

function toggleReaction(el){
  if(!el)return;
  el.remove();
}

function openReactionPickerForTarget(btn,target){
  document.querySelectorAll('.floatingReactionPicker').forEach(el=>el.remove());

  const rect=btn.getBoundingClientRect();

  const box=document.createElement('div');
  box.className='floatingReactionPicker fixed z-[9999] rounded-2xl border line bg-[#101923] p-2 grid grid-cols-6 gap-1 shadow-2xl shadow-black/50';
  box.style.left=(rect.left-120)+'px';
  box.style.top=(rect.top-64)+'px';

  box.innerHTML=extraReactions.map(emoji=>{
    return '<button class="w-9 h-9 rounded-xl hover:bg-white/10 text-lg">'+emoji+'</button>';
  }).join('');

  document.body.appendChild(box);

  [...box.querySelectorAll('button')].forEach((button,index)=>{
    button.onclick=()=>{
      addReactionToWrap(target,extraReactions[index]);
      box.remove();
    };
  });
}
let contextTargetMsg=null;

function renderReactionsInEl(el,reactions){
  if(!el||!reactions)return;
  const entries=Object.entries(reactions).filter(([,users])=>users.length>0);
  el.innerHTML=entries.map(([emoji,users])=>
    `<button class="px-2 py-1 rounded-full bg-white/10 hover:bg-white/15 text-xs flex items-center gap-1" title="${users.join(', ')}">${emoji} <span>${users.length}</span></button>`
  ).join('');
}

async function sendReactionToTelegram(emoji){
  const msgIdAttr=contextTargetMsg?.dataset?.msgId||'';
  const dbId=msgIdAttr.replace('msg_','');
  if(!dbId||isNaN(dbId)){showToast('Không thể thả reaction','Tin nhắn này chưa có ID Telegram');return}
  hideMessageMenu();
  try{
    const result=await api('POST','/react',{message_id:parseInt(dbId),emoji});
    // Dùng reactions từ server để render lại — không tự tính trên frontend
    const wrap=contextTargetMsg;
    if(wrap){
      const reacts=wrap.querySelector('.msg-reacts');
      if(reacts)renderReactionsInEl(reacts,result.reactions||{});
    }
  }catch(e){showToast('Lỗi reaction',e.message)}
}

const QUICK_REACTIONS=['👍','❤️','🔥','🎉','😂','👏','🚀','💯'];

function deleteMessage(btn){
  const row=btn.closest('.msg-wrap');
  if(!row)return;
  row.style.opacity='0';
  row.style.transform='translateY(8px)';
  setTimeout(()=>row.remove(),180);
}

function openMessageMenu(e,row){
  e.preventDefault();
  e.stopPropagation();
  contextTargetMsg=row;

  const menu=$('messageContextMenu');
  if(!menu)return;

  const quickRow=QUICK_REACTIONS.map(e=>`<button onclick="sendReactionToTelegram('${e}')" class="w-9 h-9 rounded-xl hover:bg-white/10 text-xl transition-all hover:scale-110" title="Thả ${e}">${e}</button>`).join('');
  const isOut=contextTargetMsg?.classList?.contains('justify-end')||(contextTargetMsg?.className||'').includes('justify-end');
  const editBtn=isOut?'<button onclick="editFromContext()">✏️ Sửa tin nhắn</button>':'';
  menu.innerHTML=`
    <div class="flex items-center gap-1 px-2 pb-2 border-b border-white/8 mb-1">${quickRow}</div>
    <button onclick="replyFromContext()">↩ Reply tin nhắn</button>
    ${editBtn}
    <button onclick="translateFromContext()">🌐 Dịch sang tiếng Việt</button>
    <button onclick="copyFromContext()">📋 Copy</button>
    <button onclick="deleteFromContext()" class="!text-red-300">🗑 Xóa tin nhắn</button>
  `;

  const x=Math.min(e.clientX,window.innerWidth-260);
  const y=Math.min(e.clientY,window.innerHeight-230);
  menu.style.left=x+'px';
  menu.style.top=y+'px';
  menu.classList.remove('hidden');
}

function hideMessageMenu(){
  const menu=$('messageContextMenu');
  if(menu)menu.classList.add('hidden');
}

document.addEventListener('click',function(e){
  const menu=$('messageContextMenu');
  if(menu&&!menu.contains(e.target))hideMessageMenu();
});

function replyFromContext(){
  if(!contextTargetMsg)return;
  replyMessage(contextTargetMsg.dataset.msgId,contextTargetMsg.dataset.msgText||'');
  hideMessageMenu();
}

// ── Edit message
let editingMsg=null;
function editFromContext(){
  if(!contextTargetMsg)return;
  const rawId=(contextTargetMsg.dataset.msgId||'').replace(/^(msg_|img_)/,'');
  if(!rawId||isNaN(Number(rawId)))return;
  const textEl=contextTargetMsg.querySelector('p');
  const currentText=contextTargetMsg.dataset.msgText||textEl?.innerText||'';
  hideMessageMenu();
  editingMsg={id:rawId,el:contextTargetMsg,textEl};
  const bar=$('replyPreviewBar');
  if(!bar)return;
  bar.classList.remove('hidden');
  bar.innerHTML=`<div class="flex items-center justify-between gap-4"><div class="min-w-0"><p class="text-[11px] font-black text-blue-300 uppercase">✏️ Đang sửa tin nhắn</p><p class="text-sm text-white truncate mt-1">${currentText}</p></div><button onclick="cancelEdit()" class="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-300">✕</button></div>`;
  const box=$('replyText');
  box.value=currentText;
  box.focus();
  box.style.height='34px';
  const h=Math.min(box.scrollHeight,200);
  box.style.height=h+'px';
  // Đổi nút Gửi thành Lưu
  const sendBtn=document.querySelector('#replyText ~ button, button[onclick="sendMsg()"]');
  if(sendBtn){sendBtn.dataset.origText=sendBtn.innerText;sendBtn.innerText='Lưu ✓';sendBtn.style.background='#3b82f6';}
}
function cancelEdit(){
  editingMsg=null;
  hideReplyPreview();
  const box=$('replyText');
  box.value='';box.style.height='34px';
  const sendBtn=document.querySelector('button[onclick="sendMsg()"]');
  if(sendBtn&&sendBtn.dataset.origText){sendBtn.innerText=sendBtn.dataset.origText;sendBtn.style.background='';}
}
async function submitEdit(text){
  if(!editingMsg)return false;
  const {id,el,textEl}=editingMsg;
  try{
    const r=await api('PATCH','/messages/'+id+'/text',{text});
    // Cập nhật DOM
    if(textEl)textEl.innerText=text;
    if(el)el.dataset.msgText=text;
    // Thêm dấu "(đã sửa)"
    const timeEl=el?.querySelector('span.seen-check')?.parentElement||el?.querySelector('[style*="justify-content:flex-end"]');
    if(timeEl&&!timeEl.querySelector('.edited-mark')){
      const mark=document.createElement('span');
      mark.className='edited-mark';
      mark.style.cssText='font-size:10px;opacity:0.6;margin-right:4px;';
      mark.innerText='đã sửa';
      timeEl.prepend(mark);
    }
    if(r.tg_error)showToast('⚠️','Telegram: '+r.tg_error);
    return true;
  }catch(e){showToast('Lỗi sửa tin',e.message);return false;}
}

let albumImgTarget=null;
function openAlbumImgMenu(e,imgEl){
  e.preventDefault();e.stopPropagation();
  albumImgTarget=imgEl;
  const menu=$('messageContextMenu');
  if(!menu)return;
  menu.innerHTML=`
    <button onclick="deleteAlbumImg()">🗑 Xóa ảnh này</button>
    <button onclick="deleteAlbumAll()" class="!text-red-300">🗑 Xóa toàn bộ album</button>`;
  const x=Math.min(e.clientX,window.innerWidth-220);
  const y=Math.min(e.clientY,window.innerHeight-100);
  menu.style.left=x+'px';menu.style.top=y+'px';
  menu.classList.remove('hidden');
}
async function deleteAlbumImg(){
  if(!albumImgTarget)return;
  const rawId=albumImgTarget.dataset.msgId||'';
  const dbId=rawId.replace(/^(msg_|img_)/,'');
  hideMessageMenu();
  if(!dbId||isNaN(Number(dbId)))return;
  albumImgTarget.style.opacity='0.3';
  try{
    const res=await api('DELETE','/messages/'+dbId);
    const wrapper=albumImgTarget.closest('[data-group-id]');
    albumImgTarget.style.transition='all 0.15s';
    albumImgTarget.style.width='0';albumImgTarget.style.height='0';albumImgTarget.style.margin='0';albumImgTarget.style.padding='0';
    setTimeout(()=>{
      albumImgTarget.remove();
      // Nếu không còn ảnh nào → xóa cả bubble
      if(wrapper&&!wrapper.querySelector('img[data-msg-id]'))wrapper.remove();
    },160);
    if(res.tg_error)showToast('⚠️ Telegram','Không xóa được bên Telegram: '+res.tg_error);
  }catch(e){
    albumImgTarget.style.opacity='1';
    showToast('Lỗi',e.message);
  }
}
async function deleteAlbumAll(){
  if(!albumImgTarget)return;
  const wrapper=albumImgTarget.closest('[data-group-id]');
  hideMessageMenu();
  const imgs=wrapper?[...wrapper.querySelectorAll('img[data-msg-id]')]:[];
  for(const img of imgs){
    const dbId=(img.dataset.msgId||'').replace(/^(msg_|img_)/,'');
    if(dbId&&!isNaN(Number(dbId)))await api('DELETE','/messages/'+dbId).catch(()=>{});
  }
  if(wrapper){wrapper.style.opacity='0';wrapper.style.transform='translateY(8px)';setTimeout(()=>wrapper.remove(),180);}
}

async function deleteFromContext(){
  if(!contextTargetMsg)return;
  const rawId=contextTargetMsg.dataset.msgId||'';
  const dbId=rawId.replace(/^(msg_|img_)/,'');
  const row=contextTargetMsg;
  hideMessageMenu();

  // Tin nhắn tạm (chưa lưu DB) — chỉ xóa DOM
  if(!dbId||isNaN(Number(dbId))){
    row.style.opacity='0';
    row.style.transform='translateY(8px)';
    setTimeout(()=>row.remove(),180);
    return;
  }

  row.style.opacity='0.4';
  try {
    const res=await api('DELETE','/messages/'+dbId);
    row.style.opacity='0';
    row.style.transform='translateY(8px)';
    setTimeout(()=>row.remove(),180);
    if(res.tg_error) showToast('⚠️ Telegram','Không xóa được bên Telegram: '+res.tg_error);
  } catch(e) {
    row.style.opacity='1';
    alert('Xóa thất bại: '+e.message);
  }
}

function copyFromContext(){
  if(!contextTargetMsg)return;
  const text=contextTargetMsg.dataset.msgText||'';
  if(navigator.clipboard)navigator.clipboard.writeText(text);
  showToast('Copied','Đã copy nội dung tin nhắn');
  hideMessageMenu();
}

function fakeTranslateToVi(text){
  const lower=String(text).toLowerCase();
  if(lower.includes('price')||lower.includes('payment'))return 'Khách đang hỏi về giá hoặc thông tin thanh toán.';
  if(lower.includes('vip')||lower.includes('plan'))return 'Khách đang quan tâm gói VIP / gói dịch vụ.';
  if(lower.includes('support'))return 'Khách cần được hỗ trợ.';
  return 'Bản dịch demo: '+text;
}

function translateFromContext(){
  if(!contextTargetMsg)return;
  const bubble=contextTargetMsg.querySelector('.inline-flex.flex-col');
  if(!bubble)return;

  const old=bubble.querySelector('.translate-box');
  if(old){old.remove();hideMessageMenu();return}

  const text=contextTargetMsg.dataset.msgText||'';
  bubble.insertAdjacentHTML('beforeend','<div class="translate-box"><b>Dịch sang tiếng Việt:</b><br>'+esc(fakeTranslateToVi(text))+'</div>');
  hideMessageMenu();
}

function openReactionPickerFromMenu(){
  if(!contextTargetMsg)return;
  const rect=contextTargetMsg.getBoundingClientRect();
  const fakeBtn={getBoundingClientRect:function(){return {left:rect.left+120,top:rect.top+20}}};
  openReactionPickerForTarget(fakeBtn,contextTargetMsg);
  hideMessageMenu();
}

function handleReplyKey(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg()}if(e.key==='Escape'){hideQuickReplies();hideMessageMenu()}}
const autoReplyTemplates={
  welcome:{
    enabled:true,
    delay:900,
    text:'🔥 Chào mừng bạn đến với Unicorn VIP\n\nBạn đang quan tâm:\n• Futures Signals\n• Copytrade\n• VIP Group\n• AI Trading\n\nReply:\n1️⃣ Futures\n2️⃣ VIP\n3️⃣ Copytrade'
  }
};

let quickReplies=[{key:'/hello',title:'Auto Welcome',text:`🔥 Chào mừng bạn đến với Unicorn VIP

Bạn đang quan tâm:
• Futures Signals
• Copytrade
• VIP Group
• AI Trading

Reply:
1️⃣ Futures
2️⃣ VIP
3️⃣ Copytrade`,files:['bang-gia-vip.png']},{key:'/price',title:'Báo giá',text:'Hiện bên mình có 4 gói: Premium, 3 Month, Lifetime và Ultimate. Bạn muốn mình gửi chi tiết gói nào trước?',files:['bang-gia-vip.png']},{key:'/feedback',title:'Feedback khách hàng',text:'Mình gửi bạn một vài feedback khách đã tham gia nhóm để bạn tham khảo trước nhé.',files:['feedback-01.jpg','feedback-02.jpg']},{key:'/pay',title:'Thanh toán',text:'Bạn có thể thanh toán qua USDT hoặc chuyển khoản. Sau khi thanh toán, gửi bill tại đây để mình kích hoạt gói cho bạn.',files:[]}];
let selectedQuickFiles=[];
let pendingAttachments=[];
let broadcastAttachments=[];
let broadcastButtonLink='';
let broadcastButtonLabel='';

function openAttachFile(){const input=$('attachFileInput');if(input)input.click()}
function openAttachImage(){const input=$('attachImageInput');if(input)input.click()}
function handleAttachFiles(e){
  const files=Array.from(e.target.files||[]);
  files.forEach(file=>{
    const item={name:file.name,type:file.type||'file',size:file.size,url:'',kind:file.type&&file.type.startsWith('image/')?'image':'file'};
    if(item.kind==='image'){
      const reader=new FileReader();
      reader.onload=ev=>{item.url=ev.target.result;pendingAttachments.push(item);renderQuickAttachPreview()};
      reader.readAsDataURL(file);
    }else{
      pendingAttachments.push(item);
    }
  });
  e.target.value='';
  renderQuickAttachPreview();
}
function formatFileSize(size){if(!size)return'';if(size<1024)return size+' B';if(size<1024*1024)return Math.round(size/1024)+' KB';return (size/1024/1024).toFixed(1)+' MB'}
function renderAttachmentHtml(items, outgoing){
  if(!items||!items.length)return'';
  return '<div class="mt-3 grid grid-cols-2 gap-2">'+items.map(a=>{
    if(a.kind==='image'&&a.url){return '<div class="rounded-2xl overflow-hidden border '+(outgoing?'border-black/10':'line')+' bg-black/10"><img src="'+a.url+'" class="w-full h-28 object-cover"><div class="px-3 py-2 text-[11px] '+(outgoing?'text-black/70':'text-zinc-400')+' truncate">'+esc(a.name)+'</div></div>'}
    return '<div class="rounded-2xl border '+(outgoing?'border-black/10 bg-black/10 text-black/70':'line bg-white/5 text-zinc-300')+' px-3 py-2 text-xs"><div class="font-black truncate">📎 '+esc(a.name)+'</div><div class="opacity-70 mt-1">'+formatFileSize(a.size)+'</div></div>'
  }).join('')+'</div>';
}
let editingQuickReply=-1;
let editingChannel=-1;

function toggleChannelManager(){
  const box=$('channelManager');
  if(!box)return;
  box.classList.toggle('hidden');
  renderChannelManager();
}

function renderChannelManager(){
  const wrap=$('channelManageList');
  if(!wrap)return;
  wrap.innerHTML=channels.map((c,i)=>{
    const bots=c.bots||[];
    const botTags=bots.map(b=>'<span class="px-2 py-0.5 rounded-lg bg-white/5 text-zinc-400 text-[11px]">@'+(b.bot_username||'?')+'</span>').join('');
    return '<div class="rounded-2xl border line bg-black/20 p-4">'+
      '<div class="flex items-center justify-between gap-4 mb-3">'+
        '<div class="flex items-center gap-3 min-w-0">'+
          '<div class="w-11 h-11 rounded-2xl bg-white/5 grid place-items-center text-2xl shrink-0">'+c.icon+'</div>'+
          '<div class="min-w-0"><p class="font-black text-white">'+esc(c.name)+'</p>'+
            '<div class="flex flex-wrap gap-1 mt-1">'+botTags+'</div>'+
          '</div>'+
        '</div>'+
        '<div class="flex gap-1.5 shrink-0">'+
          '<button onclick="editChannel('+i+')" class="h-8 px-3 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-300 text-xs font-black">✎ Sửa</button>'+
          '<button onclick="deleteChannel('+i+')" class="h-8 px-3 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-300 text-xs font-black">🗑</button>'+
        '</div>'+
      '</div>'+
      // Bot list với nút xóa từng bot
      '<div class="space-y-1.5 mb-3">'+
        bots.map(b=>'<div class="flex items-center justify-between rounded-xl bg-black/20 px-3 py-2">'+
          '<span class="text-xs text-zinc-300">🤖 @'+(b.bot_username||'?')+'</span>'+
          (bots.length>1?'<button onclick="removeBot('+c.id+','+b.id+')" class="text-[10px] text-red-400 hover:text-red-300">✕ Gỡ</button>':'<span class="text-[10px] text-zinc-600">Primary</span>')+
        '</div>').join('')+
      '</div>'+
      // Add bot form
      '<div class="flex gap-2">'+
        '<input id="addBotInput_'+c.id+'" placeholder="Token bot thứ 2..." class="flex-1 h-9 rounded-xl bg-black/30 border line px-3 text-xs outline-none text-zinc-300" />'+
        '<button onclick="addBotToChannel('+c.id+')" class="h-9 px-3 rounded-xl bg-yellow-400/10 hover:bg-yellow-400 hover:text-black text-yellow-300 text-xs font-black transition-colors">＋ Thêm bot</button>'+
      '</div>'+
    '</div>';
  }).join('')||'<p class="text-zinc-500 text-sm text-center py-4">Chưa có channel nào.</p>';
}

function resetChannelForm(){
  editingChannel=-1;
  $('channelNameInput').value='';
  $('channelIconInput').value='';
  $('channelBotInput').value='';
}

async function saveChannel(){
  const name=$('channelNameInput').value.trim();
  const icon=$('channelIconInput').value.trim()||'🔥';
  const bot_token=$('channelBotInput').value.trim();
  if(!name||!bot_token)return showToast('Thiếu thông tin','Vui lòng nhập tên và bot token');
  try{
    showToast('Đang kết nối...','Đang kiểm tra bot token');
    const ch=await api('POST','/channels',{name,icon,bot_token});
    channels.push({id:ch.id,name:ch.name,icon:ch.icon,bot:'@'+(ch.bot_username||''),bots:ch.bots||[]});
    resetChannelForm();renderTabs();renderChannelManager();
    renderBroadcastTargetControls();updateBroadcastAudience();renderReports();
    showToast('Thành công','Đã thêm channel '+name);
  }catch(e){showToast('Lỗi',e.message)}
}

async function addBotToChannel(channelId){
  const input=$('addBotInput_'+channelId);
  const bot_token=(input?.value||'').trim();
  if(!bot_token)return showToast('Thiếu token','Nhập bot token để thêm');
  try{
    showToast('Đang kết nối...','Kiểm tra bot token thứ 2');
    const b=await api('POST','/channels/'+channelId+'/bots',{bot_token});
    const ch=channels.find(c=>c.id===channelId);
    if(ch){if(!ch.bots)ch.bots=[];ch.bots.push(b);}
    if(input)input.value='';
    renderChannelManager();
    showToast('Đã thêm bot','@'+(b.bot_username||'?')+' đã được gắn vào channel');
  }catch(e){showToast('Lỗi',e.message)}
}

async function removeBot(channelId, botId){
  if(!confirm('Gỡ bot này khỏi channel?'))return;
  try{
    await api('DELETE','/channels/'+channelId+'/bots/'+botId);
    const ch=channels.find(c=>c.id===channelId);
    if(ch&&ch.bots)ch.bots=ch.bots.filter(b=>b.id!==botId);
    renderChannelManager();
    showToast('Đã gỡ bot','Bot đã được gỡ khỏi channel');
  }catch(e){showToast('Lỗi',e.message)}
}

function editChannel(i){
  const c=channels[i];
  if(!c)return;
  editingChannel=i;
  $('channelNameInput').value=c.name;
  $('channelIconInput').value=c.icon;
  $('channelBotInput').value='';
}

async function deleteChannel(i){
  if(channels.length<=1)return showToast('Không thể xóa','Cần có ít nhất 1 channel');
  const ch=channels[i];
  if(!confirm('Xóa channel "'+ch.name+'" và TẤT CẢ bots của nó?'))return;
  try{
    await api('DELETE','/channels/'+ch.id);
    channels.splice(i,1);
    leads=leads.filter(l=>l.c!==ch.id);
    if(activeChannel===ch.id){activeChannel=channels[0]?.id||null}
    renderTabs();renderChannelManager();renderList();
    renderBroadcastTargetControls();updateBroadcastAudience();renderReports();
    showToast('Đã xóa',ch.name+' đã được xóa');
  }catch(e){showToast('Lỗi',e.message)}
}
function handleQuickReplyInput(){
  const box=$('replyText');
  const value=box.value;
  // Auto-expand textarea
  box.style.height='34px';
  const newH=Math.min(box.scrollHeight,200);
  box.style.height=newH+'px';
  box.style.overflowY=newH>=200?'auto':'hidden';
  if(value.trimStart().startsWith('/'))showQuickReplies(value.trim());
  else hideQuickReplies();
}
function showQuickReplies(q){
  const wrap=$('quickReplyBox');
  if(!wrap)return;
  const lower=q.toLowerCase();
  const items=quickReplies.map((r,i)=>({r,i})).filter(({r})=>r.key.includes(lower)||r.title.toLowerCase().includes(lower)||lower==='/');
  if(!items.length){hideQuickReplies();return;}
  wrap.classList.remove('hidden');
  wrap.innerHTML='<div class="px-4 py-3 border-b line flex items-center justify-between"><p class="text-xs font-black text-zinc-400 uppercase tracking-wider">Trả lời nhanh</p><p class="text-[10px] text-zinc-600">Tab hoặc click để chọn</p></div>'+
    items.map(({r,i})=>{
      const fc=(r.files||[]).length;
      const imgs=(r.files||[]).filter(f=>typeof f==='object'&&f.base64&&f.type.startsWith('image/')).slice(0,2);
      return '<button onclick="useQuickReply('+i+')" class="w-full px-4 py-3 text-left hover:bg-white/5 flex gap-3 items-center transition-colors">'+
        '<span class="px-2 py-1 rounded-lg bg-yellow-400/10 text-yellow-300 text-xs font-black shrink-0">'+esc(r.key)+'</span>'+
        '<div class="min-w-0 flex-1">'+
          '<p class="text-sm font-black text-white leading-tight">'+esc(r.title)+'</p>'+
          '<p class="text-xs text-zinc-500 truncate mt-0.5">'+esc(r.text.split('\n')[0])+'</p>'+
        '</div>'+
        (imgs.length?'<div class="flex gap-1 shrink-0">'+imgs.map(f=>'<img src="'+f.base64+'" class="w-8 h-8 rounded object-cover opacity-70" />').join('')+'</div>':'')+
        (fc&&!imgs.length?'<span class="text-[11px] text-zinc-500 shrink-0">📎'+fc+'</span>':'')+
      '</button>';
    }).join('');
}
function hideQuickReplies(){const wrap=$('quickReplyBox');if(wrap)wrap.classList.add('hidden')}
const emojiGroups={
  'Mặt cười':['😀','😁','😂','🤣','😊','😍','😘','😎','😡','😭','😱','🥶','😈','🤝','🙏','🔥','💯','🚀','💰','📈'],
  'Trading':['🟢','🔴','📊','📉','📈','💵','💎','👑','⚡','✅','❌','⏳','🎯','🏆','🧲','🧨','🔔','📌','🧾','🤑'],
  'Tay':['👍','👎','👌','✌️','👏','🙌','🤙','👊','💪','🫡','👉','👇','👆','👀','🧠','❤️','💛','💚','💙','🖤']
};
function toggleEmojiPicker(){
  const box=$('emojiPicker');
  if(!box)return;
  box.classList.toggle('hidden');
  if(!box.classList.contains('hidden')) renderEmojiPicker();
}
function renderEmojiPicker(){
  const box=$('emojiPicker');
  if(!box)return;
  box.innerHTML=Object.keys(emojiGroups).map(group=>{
    return '<div class="p-3 border-b line"><p class="text-[11px] font-black text-zinc-500 uppercase mb-2">'+group+'</p><div class="grid grid-cols-8 gap-1">'+emojiGroups[group].map(e=>'<button onclick="insertEmoji(\''+e+'\')" class="w-8 h-8 rounded-lg hover:bg-white/10 grid place-items-center text-lg">'+e+'</button>').join('')+'</div></div>';
  }).join('');
}
function insertEmoji(emoji){
  const input=$('replyText');
  if(!input)return;
  const start=input.selectionStart||0;
  const end=input.selectionEnd||0;
  input.value=input.value.slice(0,start)+emoji+input.value.slice(end);
  input.focus();
  input.selectionStart=input.selectionEnd=start+emoji.length;
}
function useQuickReply(i){
  const item=quickReplies[i];
  if(!item)return;
  $('replyText').value=item.text;
  pendingAttachments=(item.files||[]).map(f=>{
    if(typeof f==='object'&&f.base64){
      return {name:f.name||'file',type:f.type||'application/octet-stream',size:f.size||0,url:f.base64,kind:f.type.startsWith('image/')?'image':'file'};
    }
    // legacy string filename — no actual data, skip
    return null;
  }).filter(Boolean);
  renderQuickAttachPreview();
  hideQuickReplies();
  $('replyText').focus();
}
function renderQuickAttachPreview(){
  const box=$('quickAttachPreview');
  if(!box)return;
  const all=[...pendingAttachments];
  if(!all.length){box.classList.add('hidden');box.innerHTML='';return}
  box.classList.remove('hidden');
  box.innerHTML='<div class="flex items-center justify-between gap-3 mb-2"><p class="text-xs font-black text-zinc-400 uppercase">File đính kèm ('+all.length+')</p><button onclick="clearQuickFiles()" class="text-xs text-red-300">✕ Xóa hết</button></div>'+
    '<div class="flex flex-wrap gap-2">'+all.map((a,i)=>{
      if(a.kind==='image'&&a.url)return '<div class="relative group"><img src="'+a.url+'" class="w-16 h-16 rounded-xl object-cover border line" /><button onclick="removePendingFile('+i+')" class="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white text-[10px] hidden group-hover:flex items-center justify-center">✕</button></div>';
      return '<div class="relative group flex items-center gap-2 px-3 py-2 rounded-xl bg-white/5 border line text-xs text-zinc-300"><span>📎</span><span class="truncate max-w-[80px]">'+esc(a.name)+'</span><button onclick="removePendingFile('+i+')" class="ml-1 text-red-300 hidden group-hover:inline">✕</button></div>';
    }).join('')+'</div>';
}
function clearQuickFiles(){selectedQuickFiles=[];pendingAttachments=[];renderQuickAttachPreview()}
function removePendingFile(i){pendingAttachments.splice(i,1);renderQuickAttachPreview()}

// ── QR Manager: file handling
let qrFilesData=[]; // [{name, type, base64}]

function handleQrFileAdd(e){
  const files=Array.from(e.target.files||[]);
  files.forEach(file=>{
    const reader=new FileReader();
    reader.onload=ev=>{
      qrFilesData.push({name:file.name,type:file.type||'application/octet-stream',base64:ev.target.result,size:file.size});
      renderQrFilePreviews();
    };
    reader.readAsDataURL(file);
  });
  e.target.value='';
}

function removeQrFile(i){qrFilesData.splice(i,1);renderQrFilePreviews()}

function renderQrFilePreviews(){
  const box=$('qrFilePreviews');
  if(!box)return;
  if(!qrFilesData.length){box.innerHTML='';return}
  box.innerHTML=qrFilesData.map((f,i)=>{
    const isImg=f.type.startsWith('image/');
    return '<div class="relative group rounded-xl overflow-hidden border line bg-black/20">'+(
      isImg
        ?'<img src="'+f.base64+'" class="w-full h-20 object-cover" />'
        :'<div class="h-20 flex flex-col items-center justify-center gap-1"><span class="text-2xl">📎</span><span class="text-[10px] text-zinc-400 truncate px-1">'+esc(f.name)+'</span></div>'
    )+'<button onclick="removeQrFile('+i+')" class="absolute top-1 right-1 w-5 h-5 rounded-full bg-red-500 text-white text-[10px] hidden group-hover:flex items-center justify-center leading-none">✕</button></div>';
  }).join('');
}

function toggleQuickReplyManager(){
  const box=$('quickReplyManager');
  if(!box)return;
  box.classList.toggle('hidden');
  renderQuickReplyManager();
  const btn=$('navQuickReply');
  if(btn){btn.classList.toggle('bg-yellow-400',!box.classList.contains('hidden'));btn.classList.toggle('text-black',!box.classList.contains('hidden'))}
}

function renderQuickReplyManager(){
  const wrap=$('quickReplyList');
  if(!wrap)return;
  wrap.innerHTML=quickReplies.map((r,i)=>{
    const files=r.files||[];
    const imgFiles=files.filter(f=>(typeof f==='object'?f.type:f).startsWith?.('image')||String(f).match(/\.(png|jpg|jpeg|gif|webp)$/i));
    const otherFiles=files.filter(f=>!imgFiles.includes(f));
    return '<div class="rounded-2xl border line bg-black/20 p-4">'+
      '<div class="flex items-start justify-between gap-3">'+
        '<div class="min-w-0 flex-1">'+
          '<div class="flex items-center gap-2 mb-1">'+
            '<span class="px-2 py-1 rounded-lg bg-yellow-400/10 text-yellow-300 text-xs font-black">'+esc(r.key)+'</span>'+
            '<p class="font-black text-white text-sm truncate">'+esc(r.title)+'</p>'+
          '</div>'+
          '<p class="text-xs text-zinc-500 leading-5 line-clamp-2 whitespace-pre-wrap">'+esc(r.text)+'</p>'+
        '</div>'+
        '<div class="flex gap-1.5 shrink-0">'+
          '<button onclick="useQuickReplyDirect('+i+')" class="h-8 px-3 rounded-xl bg-yellow-400/10 hover:bg-yellow-400 hover:text-black text-yellow-300 text-xs font-black transition-colors" title="Dùng ngay">▶ Dùng</button>'+
          '<button onclick="editQuickReply('+i+')" class="w-8 h-8 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-300 text-sm">✎</button>'+
          '<button onclick="deleteQuickReply('+i+')" class="w-8 h-8 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-300 text-sm">🗑</button>'+
        '</div>'+
      '</div>'+
      (files.length?
        '<div class="mt-3 flex items-center gap-2">'+
          (imgFiles.length?imgFiles.slice(0,4).map(f=>'<img src="'+(typeof f==='object'?f.base64:'')+'" class="w-10 h-10 rounded-lg object-cover border line" />').join('')+
            (imgFiles.length>4?'<span class="text-xs text-zinc-500">+'+( imgFiles.length-4)+'</span>':''):'')  +
          (otherFiles.length?'<span class="text-xs text-zinc-400 bg-white/5 px-2 py-1 rounded-lg">📎 '+otherFiles.length+' file</span>':'')+
        '</div>'
      :'')+
    '</div>';
  }).join('')||'<p class="text-center text-zinc-500 py-6 text-sm">Chưa có mẫu nào. Điền form bên phải để tạo.</p>';
}

function resetQuickReplyForm(){
  editingQuickReply=-1;
  $('qrKey').value='';
  $('qrTitle').value='';
  $('qrText').value='';
  qrFilesData=[];
  renderQrFilePreviews();
}

async function saveQuickReply(){
  const key=$('qrKey').value.trim();
  const title=$('qrTitle').value.trim();
  const text=$('qrText').value.trim();
  if(!key||!title||!text){showToast('Thiếu thông tin','Cần điền đủ key, tên và nội dung');return;}
  const keyCmd=key.startsWith('/')?key:'/'+key;
  try{
    const r=await api('POST','/quick-replies',{key_cmd:keyCmd,title,text,files:qrFilesData});
    const data={id:r.id,key:keyCmd,key_cmd:keyCmd,title,text,files:qrFilesData};
    if(editingQuickReply>-1)quickReplies[editingQuickReply]=data;
    else quickReplies.unshift(data);
    resetQuickReplyForm();
    renderQuickReplyManager();
    showToast('Đã lưu','Mẫu '+keyCmd+' đã được lưu');
  }catch(e){showToast('Lỗi',e.message)}
}

function editQuickReply(i){
  const item=quickReplies[i];
  if(!item)return;
  editingQuickReply=i;
  $('qrKey').value=item.key;
  $('qrTitle').value=item.title;
  $('qrText').value=item.text;
  // Restore files
  qrFilesData=(item.files||[]).filter(f=>typeof f==='object'&&f.base64);
  renderQrFilePreviews();
  // Scroll form into view
  const form=$('qrKey');
  if(form)form.scrollIntoView({behavior:'smooth',block:'center'});
  form.focus();
}

async function deleteQuickReply(i){
  const item=quickReplies[i];
  if(!item)return;
  try{
    if(item.id)await api('DELETE','/quick-replies/'+item.id);
    quickReplies.splice(i,1);
    renderQuickReplyManager();
  }catch(e){showToast('Lỗi',e.message)}
}

// Dùng QR trực tiếp từ manager (không cần gõ /)
function useQuickReplyDirect(i){
  useQuickReply(i);
  toggleQuickReplyManager();
  const chatInput=$('replyText');
  if(chatInput)chatInput.focus();
}
function openModule(name){document.querySelectorAll('.module-screen').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.module-btn').forEach(x=>x.classList.remove('active'));$('screen'+name).classList.add('active');$('nav'+name).classList.add('active')}
function openFolder(type){
  activeFolderFilter=type;
  activeStage='all';
  activeLead=filtered()[0]||activeLead;
  renderAll();
}
function toggleSearch(){searchOpen=!searchOpen;const wrap=$('searchWrap');if(wrap){wrap.classList.toggle('hidden',!searchOpen);if(searchOpen)setTimeout(()=>$('searchInput')&&$('searchInput').focus(),50)}}
function toggleUnreplied(){onlyUnreplied=!onlyUnreplied;const btn=$('unrepliedBtn');if(btn){btn.className=onlyUnreplied?'h-8 px-2.5 rounded-lg bg-yellow-400 text-black text-[11px] font-black':'h-8 px-2.5 rounded-lg bg-black/30 border line text-[11px] font-black text-zinc-300'}renderList()}
function toggleLifecycleManage(){lifecycleManageOpen=!lifecycleManageOpen;const box=$('lifecycleManage');if(box)box.classList.toggle('hidden',!lifecycleManageOpen)}
function addLifecycleStage(){const input=$('newStageInput');const name=(input?input.value:'').trim();if(!name||stages.includes(name))return;const idx=stages.indexOf('Đã PAID');stages.splice(idx>0?idx:stages.length,0,name);input.value='';renderAll()}
const AUTO_KEY='unicorn_automation_v2';
const TRIGGER_LABELS={new_lead:'Khách mới vào bot',keyword_price:'Từ khóa: giá',keyword_pay:'Từ khóa: thanh toán',keyword_vip:'Từ khóa: VIP',keyword_custom:'Từ khóa tự nhập',any_message:'Mọi tin nhắn'};
const ACTION_LABELS={send_welcome:'Gửi /hello',send_price:'Gửi /price',send_payment:'Gửi /pay',send_quick_reply:'Gửi quick reply',send_custom:'Gửi tin tùy soạn',remind_sale:'Nhắc sale',move_lead:'Chuyển → Tiềm năng',change_lifecycle:'Đổi lifecycle'};

function onAutoTriggerChange(){
  const v=$('autoTrigger').value;
  $('triggerCustomWrap').classList.toggle('hidden',v!=='keyword_custom');
}
function onAutoActionChange(){
  const v=$('autoAction').value;
  $('actionQRWrap').classList.toggle('hidden',v!=='send_quick_reply');
  $('actionCustomWrap').classList.toggle('hidden',v!=='send_custom');
  $('actionLifecycleWrap').classList.toggle('hidden',v!=='change_lifecycle');
  if(v==='send_quick_reply'){
    const sel=$('actionQRSelect');
    if(sel)sel.innerHTML=quickReplies.map(r=>'<option value="'+esc(r.key)+'">'+esc(r.key)+' — '+esc(r.title)+'</option>').join('');
  }
}
let automationRules=(()=>{try{const s=JSON.parse(localStorage.getItem(AUTO_KEY)||'[]');return s.length?s:[
  {name:'Khách mới → Auto /hello',trigger:'new_lead',action:'send_welcome',enabled:true,note:'Tự gửi mẫu /hello khi khách lần đầu nhắn vào bot',delay:1200},
  {name:'Hỏi giá → Auto /price',trigger:'keyword_price',action:'send_price',enabled:false,note:'Tự gửi bảng giá khi khách nhắn từ khóa giá',delay:800},
  {name:'Muốn thanh toán → Auto /pay',trigger:'keyword_pay',action:'send_payment',enabled:false,note:'Tự gửi hướng dẫn thanh toán khi khách nhắn',delay:800}
]}catch{return[]}})(  );
function saveAutoRules(){try{localStorage.setItem(AUTO_KEY,JSON.stringify(automationRules))}catch{}}

// ── Thêm log vào panel Automation
function addAutomationLog(msg,type){
  const el=$('automationLog');
  if(!el)return;
  if(el.innerHTML==='Chưa có log.')el.innerHTML='';
  const t=new Date().toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const cls=type==='error'?'text-red-300':type==='warn'?'text-yellow-300':'text-green-300';
  el.insertAdjacentHTML('afterbegin','<div class="py-1 border-b border-white/5 flex gap-3"><span class="text-zinc-500 shrink-0">'+t+'</span><span class="'+cls+'">'+esc(String(msg))+'</span></div>');
}

// ── Thực thi một rule với lead cụ thể
async function executeAutomationRule(rule,lead){
  if(!rule||!lead)return;
  const label='['+rule.name+'] → '+lead.n;
  // Xác định nội dung cần gửi
  let textToSend=null;
  if(rule.action==='send_welcome'||rule.action==='send_price'||rule.action==='send_payment'){
    const keyMap={send_welcome:'/hello',send_price:'/price',send_payment:'/pay'};
    const reply=quickReplies.find(x=>x.key===keyMap[rule.action]);
    if(!reply){addAutomationLog(label+' — không tìm thấy quick reply '+keyMap[rule.action],'warn');return;}
    textToSend=reply.text;
  }
  if(rule.action==='send_quick_reply'){
    const reply=quickReplies.find(x=>x.key===rule.quick_reply_key);
    if(!reply){addAutomationLog(label+' — không tìm thấy quick reply '+rule.quick_reply_key,'warn');return;}
    textToSend=reply.text;
  }
  if(rule.action==='send_custom'){
    if(!rule.custom_text){addAutomationLog(label+' — thiếu nội dung tin nhắn','warn');return;}
    textToSend=rule.custom_text;
  }
  if(textToSend!==null){
    if(!lead.id){addAutomationLog(label+' — lead chưa có ID','warn');return;}
    addAutomationLog(label+' — gửi sau '+(rule.delay||1200)+'ms...');
    setTimeout(async()=>{
      try{
        await api('POST','/reply',{contact_id:lead.id,text:textToSend});
        addAutomationLog(label+' ✓ Đã gửi');
      }catch(e){addAutomationLog(label+' — Lỗi: '+e.message,'error');}
    },rule.delay||1200);
  }
  if(rule.action==='remind_sale'){
    addAutomationLog(label+' — Nhắc sale: '+esc(rule.note||'Cần xử lý'));
    notifyNewMessage('⚡ Automation',lead.n+': '+(rule.note||'Cần sale xử lý'));
  }
  if(rule.action==='move_lead'){
    if(lead.stage==='New Lead'){
      lead.stage='Tiềm năng';
      if(lead.id)api('PATCH','/conversations/'+lead.id,{lifecycle:'Tiềm năng'}).catch(()=>{});
      addAutomationLog(label+' — Chuyển → Tiềm năng');renderList();
    }
  }
  if(rule.action==='change_lifecycle'&&rule.target_lifecycle){
    const prev=lead.stage;
    lead.stage=rule.target_lifecycle;
    if(lead.id)api('PATCH','/conversations/'+lead.id,{lifecycle:rule.target_lifecycle}).catch(()=>{});
    addAutomationLog(label+' — Đổi lifecycle: '+prev+' → '+rule.target_lifecycle);
    renderList();
  }
}

// ── Kiểm tra và kích hoạt rules khi có tin nhắn mới
const _autoTriggered=new Set(); // tránh trigger trùng
async function checkAutomationRules(lead,message,isNewLead){
  if(!lead||!message)return;
  const txt=(message.text||'').toLowerCase();
  const enabled=automationRules.filter(r=>r.enabled&&(!r.channel_ids?.length||r.channel_ids.includes(lead.c)));
  for(const rule of enabled){
    let fire=false;
    if(rule.trigger==='new_lead'&&isNewLead&&!lead.autoWelcomed){
      const key='nl_'+lead.id;
      if(!_autoTriggered.has(key)){_autoTriggered.add(key);lead.autoWelcomed=true;fire=true;}
    }
    if(rule.trigger==='keyword_price'){
      const kws=['price','giá','bao nhiêu','how much','fee','phí','cost','gói'];
      if(kws.some(k=>txt.includes(k)))fire=true;
    }
    if(rule.trigger==='keyword_pay'){
      const kws=['pay','payment','usdt','thanh toán','chuyển khoản','transfer','bill','ck'];
      if(kws.some(k=>txt.includes(k)))fire=true;
    }
    if(rule.trigger==='keyword_vip'){
      const kws=['vip','tham gia','join','đăng ký','register','mua','buy'];
      if(kws.some(k=>txt.includes(k)))fire=true;
    }
    if(rule.trigger==='keyword_custom'&&rule.custom_keywords?.length){
      if(rule.custom_keywords.some(k=>txt.includes(k)))fire=true;
    }
    if(rule.trigger==='any_message')fire=true;
    if(fire)await executeAutomationRule(rule,lead);
  }
}

let autoFilterChannel=0; // 0 = tất cả
let autoSelectedChannels=[]; // [] = tất cả

function renderAutoChannelPicker(){
  const box=$('autoChannelPicker');
  if(!box)return;
  const allActive=autoSelectedChannels.length===0;
  box.innerHTML='<button onclick="toggleAutoChannel(0)" class="h-9 px-4 rounded-xl text-xs font-black '+(allActive?'bg-yellow-400 text-black':'bg-white/5 text-zinc-300 hover:bg-white/10')+'">🌐 Tất cả</button>'+
    channels.map(c=>'<button onclick="toggleAutoChannel('+c.id+')" class="h-9 px-4 rounded-xl text-xs font-black '+(autoSelectedChannels.includes(c.id)?'bg-yellow-400 text-black':'bg-white/5 text-zinc-300 hover:bg-white/10')+'">'+c.icon+' '+c.name+'</button>').join('');
}
function toggleAutoChannel(id){
  if(id===0){autoSelectedChannels=[];}
  else{
    const idx=autoSelectedChannels.indexOf(id);
    if(idx>-1)autoSelectedChannels.splice(idx,1);
    else autoSelectedChannels.push(id);
  }
  renderAutoChannelPicker();
}

function renderAutoFilterTabs(){
  const box=$('autoFilterTabs');
  if(!box)return;
  box.innerHTML='<button onclick="setAutoFilter(0)" class="h-8 px-3 rounded-xl text-xs font-black '+(autoFilterChannel===0?'bg-yellow-400 text-black':'bg-white/5 text-zinc-400 hover:bg-white/10')+'">🌐 Tất cả</button>'+
    channels.map(c=>'<button onclick="setAutoFilter('+c.id+')" class="h-8 px-3 rounded-xl text-xs font-black '+(autoFilterChannel===c.id?'bg-yellow-400 text-black':'bg-white/5 text-zinc-400 hover:bg-white/10')+'">'+c.icon+' '+c.name+'</button>').join('');
}
function setAutoFilter(id){autoFilterChannel=id;renderAutoFilterTabs();renderAutomationRules();}

function renderAutomationRules(){
  renderAutoFilterTabs();
  renderAutoChannelPicker();
  const box=$('automationRuleList');
  if(!box)return;
  const filtered=automationRules.filter(r=>{
    if(autoFilterChannel===0)return true;
    return !r.channel_ids?.length||r.channel_ids.includes(autoFilterChannel);
  });
  box.innerHTML=filtered.map(r=>{
    const i=automationRules.indexOf(r);
    const tl=TRIGGER_LABELS[r.trigger]||r.trigger;
    const al=ACTION_LABELS[r.action]||r.action;
    const chBadges=r.channel_ids?.length
      ?r.channel_ids.map(id=>{const c=channels.find(x=>x.id===id);return c?'<span class="px-2 py-1 rounded-lg bg-blue-500/10 text-blue-300">'+c.icon+' '+c.name+'</span>':''}).join('')
      :'<span class="px-2 py-1 rounded-lg bg-white/5 text-zinc-400">🌐 Tất cả channel</span>';
    return '<div class="rounded-2xl border line bg-black/20 p-4">'+
      '<div class="flex items-start justify-between gap-3 mb-3">'+
        '<div><p class="font-black text-white text-sm">'+esc(r.name)+'</p><p class="text-xs text-zinc-500 mt-1">'+esc(r.note||'')+'</p></div>'+
        '<div class="flex gap-2 shrink-0">'+
          '<button onclick="toggleAutomationRule('+i+')" class="px-3 py-1 rounded-lg '+(r.enabled?'bg-green-500/10 text-green-300':'bg-white/5 text-zinc-500')+' text-xs font-black">'+(r.enabled?'✓ ON':'OFF')+'</button>'+
          '<button onclick="deleteAutomationRule('+i+')" class="w-7 h-7 rounded-lg bg-red-500/10 text-red-300 text-xs">✕</button>'+
        '</div>'+
      '</div>'+
      '<div class="flex flex-wrap gap-2 text-[11px]">'+
        '<span class="px-2 py-1 rounded-lg bg-yellow-400/10 text-yellow-300">⚡ '+esc(tl)+'</span>'+
        (r.custom_keywords?.length?'<span class="px-2 py-1 rounded-lg bg-yellow-400/5 text-yellow-200/70">'+r.custom_keywords.join(', ')+'</span>':'')+
        '<span class="px-2 py-1 rounded-lg bg-violet-500/10 text-violet-300">→ '+esc(al)+'</span>'+
        (r.custom_text?'<span class="px-2 py-1 rounded-lg bg-violet-400/5 text-violet-200/70 max-w-[180px] truncate">'+esc(r.custom_text.slice(0,40))+'...</span>':'')+
        (r.target_lifecycle?'<span class="px-2 py-1 rounded-lg bg-blue-500/10 text-blue-300">'+esc(r.target_lifecycle)+'</span>':'')+
        (r.quick_reply_key?'<span class="px-2 py-1 rounded-lg bg-violet-400/10 text-violet-200">'+esc(r.quick_reply_key)+'</span>':'')+
        '<span class="px-2 py-1 rounded-lg bg-white/5 text-zinc-400">'+r.delay+'ms</span>'+
        chBadges+
      '</div>'+
    '</div>';
  }).join('')||'<p class="text-zinc-500 text-sm text-center py-4">Chưa có rule nào'+(autoFilterChannel?' cho channel này.':'. Bấm ＋ New Rule để thêm.')+'</p>';
}
function toggleAutomationRule(i){automationRules[i].enabled=!automationRules[i].enabled;saveAutoRules();renderAutomationRules()}
function deleteAutomationRule(i){automationRules.splice(i,1);saveAutoRules();renderAutomationRules()}
function addAutomationRule(){
  openModule('Automation');
  $('autoNote').value='';$('autoTrigger').value='new_lead';$('autoAction').value='send_welcome';
  if($('autoDelay'))$('autoDelay').value='1200';
  autoSelectedChannels=activeChannel?[activeChannel]:[];
  renderAutoChannelPicker();
}
function saveAutomationRule(){
  const trigger=$('autoTrigger').value;
  const action=$('autoAction').value;
  const note=$('autoNote').value.trim()||'Rule automation';
  const delay=parseInt($('autoDelay')?.value||'1200')||1200;
  const channel_ids=[...autoSelectedChannels];
  // Custom trigger data
  const custom_keywords=trigger==='keyword_custom'
    ?($('triggerKeywords').value||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean)
    :[];
  // Custom action data
  const custom_text=action==='send_custom'?($('actionCustomText').value||'').trim():'';
  const quick_reply_key=action==='send_quick_reply'?($('actionQRSelect').value||''):'';
  const target_lifecycle=action==='change_lifecycle'?($('actionLifecycleSelect').value||''):'';

  if(trigger==='keyword_custom'&&!custom_keywords.length){showToast('Thiếu từ khóa','Nhập ít nhất 1 từ khóa');return;}
  if(action==='send_custom'&&!custom_text){showToast('Thiếu nội dung','Nhập tin nhắn cần gửi');return;}

  const chLabel=channel_ids.length?channel_ids.map(id=>channels.find(c=>c.id===id)?.name||id).join(', '):'Tất cả';
  const name=(TRIGGER_LABELS[trigger]||trigger)+' → '+(ACTION_LABELS[action]||action);
  automationRules.unshift({name,trigger,action,enabled:true,note,delay,channel_ids,custom_keywords,custom_text,quick_reply_key,target_lifecycle});
  saveAutoRules();
  renderAutomationRules();
  addAutomationLog('Đã lưu rule: '+name+' ['+chLabel+']');
  autoSelectedChannels=[];
  // Reset fields
  $('triggerCustomWrap').classList.add('hidden');
  $('actionQRWrap').classList.add('hidden');
  $('actionCustomWrap').classList.add('hidden');
  $('actionLifecycleWrap').classList.add('hidden');
}
function runAutomationDemo(){
  if(!activeLead){showToast('Chưa chọn khách','Chọn một hội thoại để test rule');return;}
  const trigger=$('autoTrigger').value;
  const action=$('autoAction').value;
  const note=$('autoNote').value;
  const delay=parseInt($('autoDelay')?.value||'1200')||1200;
  const testRule={name:'[TEST] '+trigger,trigger,action,enabled:true,note,delay};
  addAutomationLog('[TEST] Chạy rule: '+trigger+' → '+action+' cho '+activeLead.n);
  executeAutomationRule(testRule,activeLead);
}
function renderAll(){renderFolders();renderLifecycle();renderTabs();renderList();renderChat();renderAutomationRules();renderBroadcastTargetControls();updateBroadcastAudience()}
let broadcastTarget={channel:'all',lifecycle:'all',package:'Lifetime'};
function renderBroadcastTargetControls(){
  const channelBox=$('broadcastChannelGroup');
  const lifeBox=$('broadcastLifecycleGroup');
  const pkgBox=$('broadcastPackageGroup');

  if(channelBox){
    const allChannels=[{id:'all',name:'Tất cả channel'},...channels];
    channelBox.innerHTML=allChannels.map(c=>{
      const value=c.id==='all'?'all':c.name;
      const active=broadcastTarget.channel===value;
      return '<button onclick="selectBroadcastChannel(this,\''+value+'\')" class="broadcast-channel h-11 rounded-xl '+(active?'bg-yellow-400 text-black font-black':'bg-white/5 text-zinc-300')+' text-sm">'+(c.icon?c.icon+' ':'')+c.name+'</button>';
    }).join('');
  }

  if(lifeBox){
    const allowed=['all',...stages.filter(s=>!isPkgStage(s)&&s!=='Khách phá'&&s!=='Đã chặn bot')];
    lifeBox.innerHTML=allowed.map(s=>{
      const label=s==='all'?'Tất cả lifecycle':s;
      const active=broadcastTarget.lifecycle===s;
      return '<button onclick="selectBroadcastLifecycle(this,\''+s+'\')" class="broadcast-life h-10 px-4 rounded-xl '+(active?'bg-yellow-400 text-black font-black':'bg-white/5 text-zinc-300')+' text-sm">'+label+'</button>';
    }).join('');
  }

  if(pkgBox){
    pkgBox.innerHTML=packages.map(p=>{
      const active=broadcastTarget.package===p;
      return '<button onclick="selectBroadcastPackage(this,\''+p+'\')" class="broadcast-package h-10 px-4 rounded-xl '+(active?'bg-violet-500 text-white font-black':'bg-white/5 text-zinc-300')+' text-sm">'+p+'</button>';
    }).join('');
  }
}
function resetBroadcastButtons(selector){
  document.querySelectorAll(selector).forEach(btn=>{
    btn.classList.remove('bg-yellow-400','text-black','font-black','bg-violet-500','text-white');
    btn.classList.add('bg-white/5','text-zinc-300');
  });
}
function setBroadcastActive(btn,type){
  btn.classList.remove('bg-white/5','text-zinc-300');
  if(type==='package')btn.classList.add('bg-violet-500','text-white','font-black');
  else btn.classList.add('bg-yellow-400','text-black','font-black');
}
function selectBroadcastChannel(btn,value){
  resetBroadcastButtons('.broadcast-channel');
  setBroadcastActive(btn,'channel');
  broadcastTarget.channel=value;
  updateBroadcastAudience();
}
function selectBroadcastLifecycle(btn,value){
  resetBroadcastButtons('.broadcast-life');
  setBroadcastActive(btn,'life');
  broadcastTarget.lifecycle=value;
  updateBroadcastAudience();
}
function selectBroadcastPackage(btn,value){
  resetBroadcastButtons('.broadcast-package');
  setBroadcastActive(btn,'package');
  broadcastTarget.package=value;
  updateBroadcastAudience();
}
function updateBroadcastAudience(){
  const total=leads.filter(l=>{
    if(l.stage==='Khách phá'||l.stage==='Đã chặn bot')return false;

    const channelOk=broadcastTarget.channel==='all'||channels.find(c=>c.id===l.c)?.name===broadcastTarget.channel;
    const lifeOk=broadcastTarget.lifecycle==='all'||l.stage===broadcastTarget.lifecycle;
    const pkgOk=broadcastTarget.lifecycle==='Đã PAID'?l.pkg===broadcastTarget.package:true;

    return channelOk&&lifeOk&&pkgOk;
  }).length;

  const box=$('broadcastAudienceBox');
  if(box){
    const channelText=broadcastTarget.channel==='all'?'Tất cả channel':broadcastTarget.channel;
    const lifeText=broadcastTarget.lifecycle==='all'?'Tất cả lifecycle':broadcastTarget.lifecycle;
    box.innerHTML='Audience: <b class="text-yellow-300">'+total+'</b> khách phù hợp <span class="text-zinc-600">• '+channelText+' • '+lifeText+(broadcastTarget.lifecycle==='Đã PAID'?' • '+broadcastTarget.package:'')+'</span>';
  }

  return total;
}
// ── Broadcast: storage & state
const BCAST_KEY='unicorn_broadcast_v1';
let _bcHistory=(()=>{try{return JSON.parse(localStorage.getItem(BCAST_KEY)||'[]')}catch{return[]}})();
let _bcSending=false;

function saveBcHistory(){try{localStorage.setItem(BCAST_KEY,JSON.stringify(_bcHistory.slice(0,100)))}catch{}}

function getBroadcastAudience(){
  return leads.filter(l=>{
    const chOk=broadcastTarget.channel==='all'||channels.find(c=>c.id===l.c)?.name===broadcastTarget.channel;
    const lifeOk=broadcastTarget.lifecycle==='all'||l.stage===broadcastTarget.lifecycle;
    const pkgOk=broadcastTarget.lifecycle==='Đã PAID'?l.pkg===broadcastTarget.package:true;
    return chOk&&lifeOk&&pkgOk;
  });
}

function updateBroadcastCharCount(){
  const body=$('broadcastBody')?.value||'';
  const el=$('broadcastCharCount');
  if(!el)return;
  const len=body.length;
  el.textContent=len+' ký tự';
  el.className='text-xs transition-colors '+(len>3000?'text-red-400':len>1500?'text-yellow-400':'text-zinc-500');
}
function updateBroadcastPreview(){
  const title=($('broadcastTitle')?.value||'').trim();
  const body=($('broadcastBody')?.value||'').trim();
  const el=$('broadcastPreviewText');
  if(!el)return;
  if(!title&&!body){el.innerHTML='<span class="text-zinc-600 italic">Preview sẽ hiện khi soạn nội dung...</span>';return;}
  el.innerHTML='<b class="text-white">'+esc(title)+'</b>'+(title&&body?'\n\n':'')+esc(body);
  // button link preview
  const wrap=$('broadcastLinkBtnWrap');
  const btnEl=$('broadcastLinkBtnPreview');
  if(wrap&&btnEl){
    if(broadcastButtonLink){wrap.classList.remove('hidden');btnEl.textContent=broadcastButtonLabel||broadcastButtonLink;}
    else{wrap.classList.add('hidden');}
  }
}

function renderBcHistory(){
  const hist=$('broadcastHistory');
  const count=$('broadcastHistCount');
  if(count)count.textContent=_bcHistory.length+' campaign đã gửi';
  if(!hist)return;
  if(!_bcHistory.length){hist.innerHTML='<p class="text-zinc-600 text-sm py-4 text-center">Chưa có lịch sử gửi.</p>';return;}
  hist.innerHTML=_bcHistory.slice(0,30).map(c=>{
    const statusCls=c.failed>0?'text-yellow-300':'text-green-400';
    const statusText=c.failed>0?c.sent+'/'+c.total+' ('+c.failed+' lỗi)':'✓ '+c.sent+' sent';
    const tgt=[c.channel!=='all'?c.channel:'',c.lifecycle!=='all'?c.lifecycle:''].filter(Boolean).join(' • ')||'Tất cả';
    return '<div class="py-3 flex items-center justify-between hover:bg-white/3 gap-3">'+
      '<div class="min-w-0">'+
        '<p class="font-black text-white text-sm truncate">'+esc(c.name||'Campaign')+'</p>'+
        '<p class="text-xs text-zinc-500 mt-0.5">'+esc(tgt)+(c.attachments?' • 📎'+c.attachments:'')+'</p>'+
      '</div>'+
      '<div class="flex items-center gap-3 text-xs shrink-0">'+
        '<span class="text-zinc-500">'+esc(c.date+' '+c.time)+'</span>'+
        '<span class="'+statusCls+' font-black">'+statusText+'</span>'+
      '</div>'+
    '</div>';
  }).join('');
}

function renderBcCampaignList(){
  const box=$('broadcastCampaignList');
  if(!box)return;
  if(!_bcHistory.length){box.innerHTML='<p class="text-zinc-600 text-sm text-center py-4">Chưa có campaign nào.</p>';return;}
  box.innerHTML=_bcHistory.slice(0,10).map((c,i)=>{
    const ok=!c.failed;
    return '<button onclick="loadBcCampaign('+i+')" class="w-full rounded-2xl border '+(i===0?'border-yellow-400/30 bg-yellow-400/10':'line bg-white/5 hover:bg-white/10')+' p-3 text-left transition-colors">'+
      '<div class="flex items-center justify-between gap-2">'+
        '<p class="font-black text-white text-sm truncate">'+esc(c.name||'Campaign')+'</p>'+
        '<span class="text-[10px] px-2 py-0.5 rounded-lg '+(ok?'bg-green-500/20 text-green-300':'bg-yellow-500/20 text-yellow-300')+' shrink-0">'+(ok?'Sent':'Partial')+'</span>'+
      '</div>'+
      '<p class="text-xs text-zinc-500 mt-1">'+c.sent+' sent • '+esc(c.date)+'</p>'+
    '</button>';
  }).join('');
}

function loadBcCampaign(i){
  const c=_bcHistory[i];
  if(!c)return;
  if($('broadcastTitle'))$('broadcastTitle').value=c.name||'';
  if($('broadcastBody'))$('broadcastBody').value=c.body||'';
  updateBroadcastPreview();
}

function setBroadcastSending(pct,label){
  const box=$('broadcastSendStatus');if(!box)return;
  box.classList.remove('hidden');
  box.innerHTML='<div class="flex items-center justify-between mb-3">'+
    '<div><p class="font-black text-white">'+esc(label)+'</p></div>'+
    '<span class="text-yellow-300 font-black text-lg">'+pct+'%</span>'+
    '</div>'+
    '<div class="h-2 rounded-full bg-white/10 overflow-hidden">'+
    '<div class="h-full bg-yellow-400 rounded-full transition-all duration-300" style="width:'+pct+'%"></div></div>';
}

async function sendBroadcastNow(){
  if(_bcSending){showToast('Đang gửi','Vui lòng chờ campaign hiện tại hoàn thành');return;}
  const body=($('broadcastBody')?.value||'').trim();
  const title=($('broadcastTitle')?.value||'').trim();
  if(!body){showToast('Thiếu nội dung','Nhập nội dung tin nhắn trước khi gửi');return;}
  const audience=getBroadcastAudience();
  if(!audience.length){showToast('Không có audience','Chọn channel/lifecycle để có khách nhận tin');return;}

  const confirmed=confirm('Gửi broadcast tới '+audience.length+' khách?\n\n'+title+'\n'+(body.length>100?body.slice(0,100)+'...':body));
  if(!confirmed)return;

  _bcSending=true;
  const btn=$('broadcastNowBtn'),btn2=$('broadcastSendBtn');
  if(btn){btn.disabled=true;btn.innerText='⏳ Đang gửi...';}
  if(btn2){btn2.disabled=true;btn2.innerText='Sending...';}

  const text=(title?'*'+title+'*\n\n':'')+body;
  let sent=0,failed=0;
  const total=audience.length;
  const imgAtts=broadcastAttachments.filter(a=>a.kind==='image'&&a.url);

  setBroadcastSending(0,'Bắt đầu gửi tới '+total+' khách...');

  for(const lead of audience){
    try{
      const btnPayload=broadcastButtonLink?{button_label:broadcastButtonLabel||broadcastButtonLink,button_url:broadcastButtonLink}:{};
      await api('POST','/reply',{contact_id:lead.id,text,...btnPayload});
      for(const att of imgAtts){
        try{await api('POST','/reply-photo',{contact_id:lead.id,base64:att.url,mime_type:att.type});}catch{}
      }
      sent++;
    }catch(e){failed++;}
    const pct=Math.round(((sent+failed)/total)*100);
    setBroadcastSending(pct,'Đã gửi '+(sent+failed)+'/'+total+(failed?' ('+failed+' lỗi)':''));
    // Rate limit: ~12 msg/s
    await new Promise(r=>setTimeout(r,85));
  }

  _bcSending=false;
  if(btn){btn.disabled=false;btn.innerText='Send Now';}
  if(btn2){btn2.disabled=false;btn2.innerText='Send Broadcast';}

  // Lưu lịch sử
  const rec={
    name:title||('Broadcast '+new Date().toLocaleDateString('vi-VN')),
    body,sent,failed,total,
    attachments:imgAtts.length,
    channel:broadcastTarget.channel,
    lifecycle:broadcastTarget.lifecycle,
    time:new Date().toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'}),
    date:new Date().toLocaleDateString('vi-VN'),
    ts:Date.now()
  };
  _bcHistory.unshift(rec);
  saveBcHistory();
  renderBcHistory();
  renderBcCampaignList();

  const msg=failed?('Gửi '+sent+'/'+total+' — '+failed+' thất bại'):('✓ Gửi thành công '+sent+'/'+total+' khách');
  showToast('Broadcast xong',msg);
  setBroadcastSending(100,msg);

  // Clear attachments sau khi gửi
  broadcastAttachments=[];
  renderBroadcastAttachments();
}

function scheduleBroadcast(){
  const body=($('broadcastBody')?.value||'').trim();
  if(!body){showToast('Thiếu nội dung','Nhập nội dung trước');return;}
  const time=$('broadcastTimeInput')?.value||'20:30';
  const audience=getBroadcastAudience();
  showToast('Đã hẹn giờ','Sẽ gửi lúc '+time+' tới '+audience.length+' khách');
  setBroadcastSending(0,'Đã hẹn lúc '+time+' — '+audience.length+' khách sẽ nhận tin');
}

function initBroadcastInteractions(){
  renderBcHistory();
  renderBcCampaignList();
  updateBroadcastPreview();
}

function openBroadcastImage(){const input=$('broadcastImageInput');if(input)input.click()}
function openBroadcastFile(){const input=$('broadcastFileInput');if(input)input.click()}
function handleBroadcastFiles(e){
  const files=Array.from(e.target.files||[]);
  files.forEach(file=>{
    const item={name:file.name,size:file.size,type:file.type||'file',kind:file.type&&file.type.startsWith('image/')?'image':'file',url:''};
    if(item.kind==='image'){
      const reader=new FileReader();
      reader.onload=ev=>{item.url=ev.target.result;broadcastAttachments.push(item);renderBroadcastAttachments();updateBroadcastPreview();};
      reader.readAsDataURL(file);
    }else{broadcastAttachments.push(item);renderBroadcastAttachments();}
  });
  e.target.value='';
}
function renderBroadcastAttachments(){
  const box=$('broadcastAttachList');if(!box)return;
  const link=broadcastButtonLink?'<div class="rounded-2xl border line bg-white/5 p-3 text-sm text-zinc-300 col-span-2 flex items-center gap-2"><span>🔗</span><div class="min-w-0 flex-1"><p class="font-black text-white truncate">'+(broadcastButtonLabel||broadcastButtonLink)+'</p><p class="text-xs text-zinc-500 truncate">'+esc(broadcastButtonLink)+'</p></div><button onclick="broadcastButtonLink=\'\';broadcastButtonLabel=\'\';renderBroadcastAttachments();updateBroadcastPreview()" class="ml-auto text-red-300 text-xs shrink-0">✕ Xóa</button></div>':'';
  if(!broadcastAttachments.length&&!broadcastButtonLink){box.innerHTML='';return;}
  box.innerHTML=broadcastAttachments.map((a,i)=>{
    if(a.kind==='image'&&a.url)return '<div class="relative rounded-2xl border line overflow-hidden bg-black/20 group"><img src="'+a.url+'" class="w-full h-24 object-cover"><button onclick="removeBroadcastAttach('+i+')" class="absolute top-1.5 right-1.5 w-6 h-6 rounded-lg bg-black/70 text-white text-xs hidden group-hover:flex items-center justify-center">×</button><p class="px-2 py-1.5 text-[10px] text-zinc-400 truncate">'+esc(a.name)+'</p></div>';
    return '<div class="relative rounded-2xl border line bg-white/5 p-3 group"><button onclick="removeBroadcastAttach('+i+')" class="absolute top-1.5 right-1.5 w-6 h-6 rounded-lg bg-black/40 text-white text-xs hidden group-hover:flex items-center justify-center">×</button><p class="text-sm font-black text-white truncate pr-6">📄 '+esc(a.name)+'</p><p class="text-xs text-zinc-500 mt-1">'+formatFileSize(a.size)+'</p></div>';
  }).join('')+link;
}
function removeBroadcastAttach(i){broadcastAttachments.splice(i,1);renderBroadcastAttachments();updateBroadcastPreview()}
function addBroadcastButtonLink(){
  const label=prompt('Tên hiển thị trên nút (VD: 🔥 Tham gia ngay):',broadcastButtonLabel||'🔥 Tham gia ngay');
  if(label===null)return;
  const link=prompt('URL khi khách bấm vào nút:',broadcastButtonLink||'https://t.me/your_bot');
  if(link===null)return;
  broadcastButtonLabel=label.trim();
  broadcastButtonLink=link.trim();
  renderBroadcastAttachments();
  updateBroadcastPreview();
}
function toggleBroadcastPreview(){
  const panel=$('broadcastPreviewPanel');
  const shell=document.querySelector('#screenBroadcast .h-full.grid');
  if(!panel||!shell)return;
  const hidden=panel.classList.toggle('hidden');
  shell.style.gridTemplateColumns=hidden?'320px 1fr':'320px 1fr 360px';
}

function getChannelNameById(id){
  return channels.find(c=>c.id===id)?.name||'Unknown Channel';
}
function parseLeadDay(lead){
  const raw=lead.firstClick||'2026-05-01';
  const match=String(raw).match(/([0-9]{4})-([0-9]{2})-([0-9]{2})/);
  if(!match)return {day:'01/05',date:'2026-05-01',dayNum:1,month:'05',year:'2026'};
  return {day:match[3]+'/'+match[2],date:match[1]+'-'+match[2]+'-'+match[3],dayNum:Number(match[3]),month:match[2],year:match[1]};
}
function buildRealtimeReportData(){
  return leads.map((lead,index)=>{
    const date=parseLeadDay(lead);
    const clicks=lead.clicks||lead.clickCount||lead.click||Math.max(1,Math.round((lead.quality||50)*2.8+(index%9)*17));
    const leadCount=1;
    const paid=lead.stage==='Đã PAID'?1:0;
    return {
      leadId:lead.id,
      day:date.day,
      date:date.date,
      dayNum:date.dayNum,
      channel:getChannelNameById(lead.c),
      lifecycle:lead.stage,
      country:lead.country||'Unknown',
      clicks,
      leads:leadCount,
      paid,
      conversion:clicks?paid/clicks*100:0
    };
  });
}
function getReportRows(){
  const from=$('reportDateFrom')?.value||'1900-01-01';
  const to=$('reportDateTo')?.value||'2999-12-31';
  const filter=$('reportChannelFilter')?.value||'all';
  return buildRealtimeReportData().filter(r=>{
    const dateOk=r.date>=from&&r.date<=to;
    const channelOk=filter==='all'||r.channel===filter;
    return dateOk&&channelOk;
  });
}
function renderReportChannelOptions(){
  const select=$('reportChannelFilter');
  if(!select)return;
  const current=select.value||'all';
  select.innerHTML='<option value="all">Tất cả channel</option>'+channels.map(c=>'<option value="'+c.name+'">'+c.name+'</option>').join('');
  select.value=[...select.options].some(o=>o.value===current)?current:'all';
}
function sumReport(rows,key){return rows.reduce((a,b)=>a+b[key],0)}
function changeReportMonth(){
  const picker=$('reportMonthPicker');
  if(!picker)return;
  const val=picker.value.split('/');
  const month=val[0];
  const year=val[1];
  $('reportDateFrom').value=year+'-'+month+'-01';
  $('reportDateTo').value=year+'-'+month+'-30';
  renderReports();
}

function renderCountryPie(rows){
  const colors=['#facc15','#22c55e','#38bdf8','#a855f7','#fb7185','#f97316','#94a3b8','#eab308','#14b8a6'];
  const map={};
  rows.forEach(r=>{map[r.country]=(map[r.country]||0)+r.clicks});
  const data=Object.keys(map).map((country,i)=>({country,value:map[country],color:colors[i%colors.length]})).sort((a,b)=>b.value-a.value);
  const total=data.reduce((sum,item)=>sum+item.value,0)||1;
  let start=0;
  const gradient=data.map(item=>{
    const pct=item.value/total*100;
    const part=item.color+' '+start.toFixed(2)+'% '+(start+pct).toFixed(2)+'%';
    start+=pct;
    return part;
  }).join(',');
  const pie=$('countryPieChart');
  if(pie){
    pie.style.background='conic-gradient('+gradient+')';
    pie.innerHTML='<div class="w-full h-full rounded-full grid place-items-center"><div class="w-[130px] h-[130px] rounded-full bg-[#0f1722] border line grid place-items-center text-center"><div><p class="text-xs text-zinc-500">Total Click</p><b class="text-2xl text-white">'+total.toLocaleString()+'</b></div></div></div>';
  }
  const legend=$('countryPieLegend');
  if(legend){
    legend.innerHTML=data.map(item=>{
      const pct=item.value/total*100;
      return '<div class="flex items-center justify-between rounded-2xl bg-white/5 px-4 py-3"><div class="flex items-center gap-3"><span class="w-3 h-3 rounded-full" style="background:'+item.color+'"></span><div><p class="font-black text-white">'+item.country+'</p><p class="text-xs text-zinc-500">'+item.value.toLocaleString()+' clicks</p></div></div><b class="text-yellow-300">'+pct.toFixed(1)+'%</b></div>';
    }).join('');
  }
  const top=$('topCountries');
  if(top){
    top.innerHTML=data.slice(0,5).map((item,i)=>{
      const pct=item.value/total*100;
      return '<div><div class="flex items-center justify-between text-sm mb-2"><span class="text-zinc-300 font-black">#'+(i+1)+' '+item.country+'</span><b>'+pct.toFixed(1)+'%</b></div><div class="h-3 rounded-full bg-white/10 overflow-hidden"><div class="h-full" style="width:'+pct+'%;background:'+item.color+'"></div></div></div>';
    }).join('');
  }
}

function renderReports(){
  renderReportChannelOptions();
  const rows=getReportRows();
  renderCountryPie(rows);
  const clicks=sumReport(rows,'clicks');
  const leadsCount=sumReport(rows,'leads');
  const paid=sumReport(rows,'paid');
  const conv=clicks?paid/clicks*100:0;
  $('reportCards').innerHTML=[
    ['Total Click',clicks.toLocaleString(),'Trong 30 ngày'],
    ['New Lead',leadsCount.toLocaleString(),'Từ click vào bot'],
    ['Paid',paid.toLocaleString(),'Khách đã chốt'],
    ['Conversion',conv.toFixed(2)+'%','Paid / Click']
  ].map(c=>'<div class="rounded-3xl border line bg-[#0f1722] p-5"><p class="text-sm text-zinc-500">'+c[0]+'</p><h3 class="text-3xl font-black text-white mt-2">'+c[1]+'</h3><p class="text-xs text-zinc-500 mt-2">'+c[2]+'</p></div>').join('');
  const max=Math.max(...rows.map(x=>x.clicks),1);
  $('monthlyBarChart').innerHTML=rows.map(r=>'<div class="flex-1 min-w-[14px] flex flex-col items-center justify-end gap-1 group"><div class="w-full max-w-[18px] rounded-t-lg bg-green-400/80" style="height:'+Math.max(4,(r.paid/max*320))+'px" title="Paid '+r.paid+'"></div><div class="w-full max-w-[18px] rounded-t-lg bg-yellow-400" style="height:'+Math.max(8,(r.clicks/max*320))+'px" title="'+r.day+' • '+r.clicks+' click"></div></div>').join('');
  $('monthlyBarLabels').innerHTML=rows.map((r,i)=>'<span class="flex-1 min-w-[14px] text-center '+(i%2?'opacity-40':'')+'">'+r.day.split('/')[0]+'</span>').join('');
  const funnel=[['Click',clicks,100],['New Lead',leadsCount,clicks?leadsCount/clicks*100:0],['Paid',paid,clicks?paid/clicks*100:0]];
  $('conversionFunnel').innerHTML=funnel.map(f=>'<div><div class="flex justify-between text-sm mb-2"><span class="text-zinc-400">'+f[0]+'</span><b>'+f[1].toLocaleString()+' • '+f[2].toFixed(1)+'%</b></div><div class="h-3 rounded-full bg-white/10 overflow-hidden"><div class="h-full bg-yellow-400" style="width:'+Math.min(100,f[2])+'%"></div></div></div>').join('');
  const ch=channels.map(channel=>{const a=rows.filter(x=>x.channel===channel.name);return {ch:channel.name,clicks:sumReport(a,'clicks'),paid:sumReport(a,'paid')}}).sort((a,b)=>b.clicks-a.clicks);
  $('topChannels').innerHTML=ch.map((x,i)=>'<div class="flex items-center justify-between rounded-2xl bg-white/5 px-4 py-3"><div><p class="font-black text-white">#'+(i+1)+' '+x.ch+'</p><p class="text-xs text-zinc-500 mt-1">'+x.paid+' paid</p></div><b class="text-yellow-300">'+x.clicks.toLocaleString()+'</b></div>').join('');
  const matrixChannels=channels.map(c=>c.name);
  $('reportMatrixBody').innerHTML=matrixChannels.map(ch=>{
    const arr=Array.from({length:30},(_,i)=>{
      return rows.filter(x=>x.channel===ch&&x.dayNum===i+1).reduce((sum,item)=>sum+item.clicks,0);
    });
    return '<tr class="hover:bg-white/5">'+
      '<td class="sticky left-0 bg-[#0f1722] border-r line px-5 py-4 font-black text-white">'+ch+'</td>'+
      arr.map((v,i)=>'<td title="Ngày '+String(i+1).padStart(2,'0')+'/'+($('reportMonthPicker')?.value||'05/2026')+' • '+ch+' • '+v+' click" class="px-3 py-4 text-center font-black text-zinc-300 hover:bg-yellow-400/10 hover:text-yellow-300 cursor-pointer transition">'+v+'</td>').join('')+
    '</tr>';
  }).join('');
}
// Initialization handled by checkLoginSession() → loadInitialData()
