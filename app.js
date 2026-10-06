(function(){
"use strict";

/* ============ קבועים ============ */
var STATUS = { ontime:{label:'בזמן'}, late:{label:'איחור'}, excused:{label:'מאושר'}, absent:{label:'חיסור'} };
var ORDER = ['ontime','late','excused','absent'];
var LKEY = 'shacharit:layer';     // קוד השכבה השמור במכשיר
var CACHE_PREFIX = 'shacharit:cache:'; // גיבוי מקומי של נתוני השכבה

/* ============ מצב ============ */
var layer = '';          // קוד השכבה הנוכחי
var online = false;      // האם Firebase מחובר
var db = null, ref = null;
var curClass = '';       // id הכיתה הנבחרת

/* מבנה הנתונים המלא של השכבה:
   D = {
     classes: { <cid>: { name, teacher, camp:{...}, alerts:{...} } },
     students:{ <cid>: { <sid>:{name,phone} } },
     att:     { <cid>: { <date>:{ <sid>:{s,n} } } }
   }  */
var D = { classes:{}, students:{}, att:{} };

/* ============ עזרים ============ */
function $(s){ return document.querySelector(s); }
function all(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); }
function esc(t){ return String(t==null?'':t).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function iso(d){ return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2); }
function parseISO(s){ var p=s.split('-'); return new Date(+p[0],+p[1]-1,+p[2],12,0,0); }
function shift(s,n){ var d=parseISO(s); d.setDate(d.getDate()+n); return iso(d); }
function today(){ return iso(new Date()); }
function uid(p){ return (p||'x')+Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
function shortDate(s){ var p=s.split('-'); return p[2]+'.'+p[1]; }

var hebFmt=null,dayFmt=null,gregFmt=null;
try{hebFmt=new Intl.DateTimeFormat('he-u-ca-hebrew',{day:'numeric',month:'long',year:'numeric'});}catch(e){}
try{dayFmt=new Intl.DateTimeFormat('he-IL',{weekday:'long'});}catch(e){}
try{gregFmt=new Intl.DateTimeFormat('he-IL',{day:'numeric',month:'long',year:'numeric'});}catch(e){}
var GEM=[[400,'ת'],[300,'ש'],[200,'ר'],[100,'ק'],[90,'צ'],[80,'פ'],[70,'ע'],[60,'ס'],[50,'נ'],[40,'מ'],[30,'ל'],[20,'כ'],[10,'י'],[9,'ט'],[8,'ח'],[7,'ז'],[6,'ו'],[5,'ה'],[4,'ד'],[3,'ג'],[2,'ב'],[1,'א']];
function gematria(n){var o='';while(n>0){if(n===15){o+='טו';break;}if(n===16){o+='טז';break;}for(var i=0;i<GEM.length;i++){if(GEM[i][0]<=n){o+=GEM[i][1];n-=GEM[i][0];break;}}}if(o.length===1)return o+'׳';return o.slice(0,-1)+'״'+o.slice(-1);}
function hebrewDate(s){try{if(!hebFmt)return'';if(!hebFmt.formatToParts)return hebFmt.format(parseISO(s));var p=hebFmt.formatToParts(parseISO(s)),day='',month='',year='';for(var i=0;i<p.length;i++){if(p[i].type==='day')day=p[i].value;else if(p[i].type==='month')month=p[i].value;else if(p[i].type==='year')year=p[i].value;}var dn=parseInt(day.replace(/\D/g,''),10),yn=parseInt(year.replace(/\D/g,''),10);if(!dn||!yn||!month)return hebFmt.format(parseISO(s));return gematria(dn)+' ב'+month+' '+gematria(yn%1000);}catch(e){return'';}}
function weekday(s){try{return dayFmt?dayFmt.format(parseISO(s)):'';}catch(e){return'';}}
function gregDate(s){try{return gregFmt?gregFmt.format(parseISO(s)):s;}catch(e){return s;}}

function toast(t){var el=$('#toast');el.textContent=t;el.classList.add('on');clearTimeout(el._t);el._t=setTimeout(function(){el.classList.remove('on');},2100);}

/* ברירת מחדל לכיתה חדשה */
function newClass(name){
  return { name:name||'כיתה חדשה', teacher:'',
    camp:{name:'מבצע מתמידים',from:'',to:'',pts:{ontime:2,late:1,excused:0,absent:0}},
    alerts:{days:14,max:3} };
}
function ensureShape(){
  if(!D.classes)D.classes={}; if(!D.students)D.students={}; if(!D.att)D.att={};
  for(var cid in D.classes){ var c=D.classes[cid];
    if(!c.camp)c.camp=newClass().camp; if(!c.camp.pts)c.camp.pts=newClass().camp.pts;
    if(!c.alerts)c.alerts=newClass().alerts;
    if(!D.students[cid])D.students[cid]={}; if(!D.att[cid])D.att[cid]={};
  }
}

/* ============ שמירה / סנכרון ============ */
var saveTimer;
function persistLocal(){ try{ localStorage.setItem(CACHE_PREFIX+layer, JSON.stringify(D)); }catch(e){} }
function pushRemote(){
  if(!online||!ref) return;
  clearTimeout(saveTimer);
  saveTimer=setTimeout(function(){ try{ ref.set(D); }catch(e){} },250);
}
function save(){ persistLocal(); pushRemote(); }

function setSyncDot(){
  var d=$('#sync-dot');
  d.className='sync-dot '+(online?'live':'off');
  d.title=online?'מסונכרן בענן':'עובד מקומית (ללא חיבור)';
}

/* ============ חיבור Firebase ============ */
function connect(code, cb){
  var cfg = window.FIREBASE_CONFIG;
  var configured = cfg && cfg.apiKey && cfg.apiKey.indexOf('הדבק')===-1 && cfg.databaseURL && cfg.databaseURL.indexOf('הדבק')===-1;
  layer = code;

  // טען גיבוי מקומי קודם כדי שהמסך לא יהיה ריק
  try{ var raw=localStorage.getItem(CACHE_PREFIX+layer); if(raw){ D=JSON.parse(raw); ensureShape(); } }catch(e){}

  if(!configured || !window.firebase){
    online=false; setSyncDot();
    cb(true); // נכנסים במצב מקומי
    return;
  }
  try{
    if(!firebase.apps.length) firebase.initializeApp(cfg);
    db = firebase.database();
    ref = db.ref('layers/'+layer);

    db.ref('.info/connected').on('value', function(snap){
      online = snap.val()===true; setSyncDot();
    });

    ref.on('value', function(snap){
      var v = snap.val();
      if(v){ D=v; ensureShape(); persistLocal(); }
      else { ensureShape(); }
      // ודא בחירת כיתה תקפה ורנדר מחדש את המסך הפעיל
      refreshClassLists();
      rerenderActive();
    }, function(){ online=false; setSyncDot(); });

    online=true; setSyncDot();
    cb(true);
  }catch(e){
    online=false; setSyncDot(); cb(true);
  }
}

/* ============ ניווט ============ */
var views={entry:'#v-entry',dash:'#v-dash',student:'#v-student',set:'#v-set'};
var active='entry';
function go(name){
  active=name;
  for(var k in views) $(views[k]).classList.toggle('on',k===name);
  all('.tabs button').forEach(function(b){ b.classList.toggle('on',b.dataset.view===name); });
  window.scrollTo(0,0);
  rerenderActive();
}
function rerenderActive(){
  if(active==='entry') renderEntry();
  else if(active==='dash') renderDash();
  else if(active==='student'){ fillStudentSelect(); renderReport(); }
  else if(active==='set') renderSettings();
}
$('.tabs').addEventListener('click',function(e){var b=e.target.closest('button[data-view]');if(b)go(b.dataset.view);});

/* ============ כיתות ============ */
function classIds(){
  return Object.keys(D.classes).sort(function(a,b){
    return (D.classes[a].name||'').localeCompare(D.classes[b].name||'','he');
  });
}
function ensureCurClass(){
  var ids=classIds();
  if(!ids.length){ curClass=''; return; }
  if(ids.indexOf(curClass)===-1) curClass=ids[0];
}
function refreshClassLists(){
  ensureCurClass();
  var ids=classIds();
  var opts=ids.map(function(id){return '<option value="'+id+'"'+(id===curClass?' selected':'')+'>'+esc(D.classes[id].name)+'</option>';}).join('');
  if(!ids.length) opts='<option value="">— אין כיתות —</option>';
  ['#class-select','#class-select-2','#class-select-3','#class-select-4'].forEach(function(sel){ var el=$(sel); if(el) el.innerHTML=opts; });
}
function onClassChange(v){ curClass=v; refreshClassLists(); rerenderActive(); }
['#class-select','#class-select-2','#class-select-3','#class-select-4'].forEach(function(sel){
  var el=$(sel); if(el) el.onchange=function(){ onClassChange(this.value); };
});
$('#class-add').onclick=function(){
  var name=prompt('שם הכיתה החדשה','ט׳ '+(classIds().length+1));
  if(!name||!name.trim())return;
  var id=uid('c'); D.classes[id]=newClass(name.trim()); D.students[id]={}; D.att[id]={};
  curClass=id; save(); refreshClassLists(); rerenderActive(); toast('הכיתה נוספה');
};

/* גישה נוחה לכיתה הנוכחית */
function C(){ return D.classes[curClass]; }
function CS(){ return D.students[curClass]||{}; }
function CA(){ if(!D.att[curClass])D.att[curClass]={}; return D.att[curClass]; }
function sortedStudents(){
  var s=CS(); return Object.keys(s).map(function(id){return {id:id,name:s[id].name,phone:s[id].phone||''};})
    .sort(function(a,b){return a.name.localeCompare(b.name,'he');});
}
function rec(date,sid){ var a=CA()[date]; return a&&a[sid]?a[sid]:null; }
function datesBetween(from,to){ var out=[],a=CA();for(var k in a){if(k>=from&&k<=to&&Object.keys(a[k]).length)out.push(k);}return out.sort(); }
function tally(from,to,sid){
  var t={ontime:0,late:0,excused:0,absent:0,days:0},a=CA(),ds=datesBetween(from,to),s=CS();
  for(var i=0;i<ds.length;i++){var day=a[ds[i]],counted=false;for(var id in day){if(sid&&id!==sid)continue;if(!sid&&!s[id])continue;if(STATUS[day[id].s]){t[day[id].s]++;counted=true;}}if(counted)t.days++;}
  return t;
}

/* ============ מסך נוכחות ============ */
var cur=today();
function renderEntry(){
  $('#klass-label').textContent=[C()?C().name:'',C()?C().teacher:''].filter(Boolean).join(' · ');
  $('#day-heb').textContent=hebrewDate(cur)||gregDate(cur);
  $('#day-greg').textContent=weekday(cur)+' · '+gregDate(cur);
  $('#day-input').value=cur;
  var list=$('#entry-list');
  if(!curClass){ list.innerHTML='<div class="sheet"><div class="empty"><span class="mark">ש</span><p>אין עדיין כיתות בשכבה.<br>לחצו על ＋ ליד שם הכיתה כדי לפתוח כיתה ראשונה.</p></div></div>'; $('#day-meter').style.width='0%'; $('#day-count').textContent=''; return; }
  var st=sortedStudents();
  if(!st.length){ list.innerHTML='<div class="sheet"><div class="empty"><span class="mark">ש</span><p>אין תלמידים בכיתה הזו.<br>אפשר להדביק את כל השמות יחד במסך ההגדרות.</p><button class="btn" id="goto-set" style="max-width:240px;margin:0 auto">מעבר להגדרות</button></div></div>'; $('#goto-set').onclick=function(){go('set');}; $('#day-meter').style.width='0%'; $('#day-count').textContent=''; return; }
  var html='',done=0;
  for(var i=0;i<st.length;i++){
    var s=st[i],r=rec(cur,s.id); if(r)done++;
    var segs='';for(var j=0;j<ORDER.length;j++){var k=ORDER[j];segs+='<button data-s="'+k+'" aria-pressed="'+(r&&r.s===k)+'">'+STATUS[k].label+'</button>';}
    var note=r&&r.n?r.n:'';
    html+='<div class="row'+(r?' done':'')+'" data-id="'+s.id+'"><div class="row-top"><div class="sigil">'+esc(s.name.charAt(0))+'</div><div class="row-name">'+esc(s.name)+'</div><button class="note-btn'+(note?' has':'')+'" data-act="note">'+(note?'הערה ✓':'הערה')+'</button></div><div class="seg">'+segs+'</div><div class="note-wrap'+(note?' open':'')+'"><input type="text" value="'+esc(note)+'" placeholder="סיבה או הערה קצרה"></div></div>';
  }
  list.innerHTML=html;
  $('#day-meter').style.width=(done/st.length*100)+'%';
  $('#day-count').textContent=done+'/'+st.length;
}
$('#entry-list').addEventListener('click',function(e){
  var row=e.target.closest('.row');if(!row)return;var sid=row.dataset.id;
  var seg=e.target.closest('.seg button');
  if(seg){var k=seg.dataset.s,a=CA();if(!a[cur])a[cur]={};var prev=a[cur][sid];if(prev&&prev.s===k)delete a[cur][sid];else a[cur][sid]={s:k,n:prev?prev.n:''};save();renderEntry();return;}
  if(e.target.closest('[data-act="note"]')){var w=row.querySelector('.note-wrap');w.classList.toggle('open');if(w.classList.contains('open'))w.querySelector('input').focus();}
});
$('#entry-list').addEventListener('change',function(e){
  if(e.target.tagName!=='INPUT')return;var row=e.target.closest('.row');if(!row)return;var sid=row.dataset.id,v=e.target.value.trim();
  if(!rec(cur,sid)){toast('בחרו קודם סטטוס לתלמיד');e.target.value='';return;}
  CA()[cur][sid].n=v;save();renderEntry();
});
$('#day-prev').onclick=function(){cur=shift(cur,-1);renderEntry();};
$('#day-next').onclick=function(){cur=shift(cur,1);renderEntry();};
$('#btn-today').onclick=function(){cur=today();renderEntry();};
$('#day-open').onclick=function(){var i=$('#day-input');if(i.showPicker){try{i.showPicker();return;}catch(e){}}i.style.position='static';i.style.opacity=1;i.style.width='100%';i.style.height='auto';i.style.pointerEvents='auto';i.style.marginTop='10px';i.style.padding='8px';i.style.borderRadius='8px';};
$('#day-input').onchange=function(){if(this.value){cur=this.value;renderEntry();}};
$('#btn-all-ontime').onclick=function(){if(!sortedStudents().length)return;var a=CA();if(!a[cur])a[cur]={};var st=sortedStudents();for(var i=0;i<st.length;i++){if(!a[cur][st[i].id])a[cur][st[i].id]={s:'ontime',n:''};}save();renderEntry();toast('כל מי שלא סומן — נרשם כבזמן');};
$('#btn-clear-day').onclick=function(){if(!confirm('למחוק את כל הדיווחים של '+gregDate(cur)+' בכיתה זו?'))return;delete CA()[cur];save();renderEntry();toast('הדיווחים של היום נמחקו');};

/* ============ נתונים ============ */
var range='week';
function rangeDates(){var to=today(),from;if(range==='week')from=shift(to,-6);else if(range==='month')from=shift(to,-29);else if(range==='term')from='2000-01-01';else{from=$('#dash-from').value||shift(to,-6);to=$('#dash-to').value||today();}return[from,to];}
$('#v-dash .chips').addEventListener('click',function(e){var c=e.target.closest('.chip');if(!c)return;range=c.dataset.range;all('#v-dash .chip').forEach(function(x){x.classList.toggle('on',x===c);});$('#dash-custom').style.display=range==='custom'?'grid':'none';if(range==='custom'){if(!$('#dash-from').value)$('#dash-from').value=shift(today(),-29);if(!$('#dash-to').value)$('#dash-to').value=today();}renderDash();});
$('#dash-from').onchange=renderDash;$('#dash-to').onchange=renderDash;
function donut(c){var total=c.ontime+c.late+c.excused+c.absent,col={ontime:'var(--ok)',late:'var(--late)',excused:'var(--excused)',absent:'var(--absent)'},svg='<circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--rule)" stroke-width="5"/>';if(total){var off=25;for(var i=0;i<ORDER.length;i++){var k=ORDER[i],pct=c[k]/total*100;if(pct<=0)continue;svg+='<circle cx="21" cy="21" r="15.9" fill="none" stroke="'+col[k]+'" stroke-width="5" stroke-dasharray="'+pct.toFixed(2)+' '+(100-pct).toFixed(2)+'" stroke-dashoffset="'+off.toFixed(2)+'"/>';off-=pct;if(off<0)off+=100;}}$('#donut').innerHTML=svg;var leg='';for(var j=0;j<ORDER.length;j++){var kk=ORDER[j];leg+='<div><i style="background:'+col[kk]+'"></i>'+STATUS[kk].label+'<b>'+c[kk]+'</b></div>';}$('#legend').innerHTML=leg;var rate=total?Math.round(c.ontime/total*100):0;$('#dist-pct').textContent=total?rate+'% בזמן':'אין נתונים';}
function renderDash(){
  if(!curClass){['#st-days','#st-ontime','#st-late','#st-absent'].forEach(function(s){$(s).textContent='0';});donut({ontime:0,late:0,excused:0,absent:0});$('#alerts-list').innerHTML='<div><span class="hint">אין כיתה נבחרת.</span></div>';$('#camp-list').innerHTML='';return;}
  var r=rangeDates(),from=r[0],to=r[1],t=tally(from,to,null);
  $('#st-days').textContent=t.days;$('#st-ontime').textContent=t.ontime;$('#st-late').textContent=t.late;$('#st-absent').textContent=t.absent;donut(t);
  var al=C().alerts,aFrom=shift(today(),-(al.days-1));
  $('#alert-rule').textContent=al.max+'+ אירועים ב־'+al.days+' ימים';
  var rows=[],st=sortedStudents();for(var i=0;i<st.length;i++){var c=tally(aFrom,today(),st[i].id),ev=c.late+c.absent;if(ev>=al.max)rows.push({s:st[i],late:c.late,abs:c.absent,ev:ev});}
  rows.sort(function(a,b){return b.ev-a.ev;});
  $('#alerts-list').innerHTML=rows.length?rows.map(function(x){return '<div class="alert"><div class="grow">'+esc(x.s.name)+'<small>'+x.late+' איחורים · '+x.abs+' חיסורים</small></div><button class="icon-btn" data-open="'+x.s.id+'">›</button></div>';}).join(''):'<div><span class="hint">אין חריגות בטווח הזה.</span></div>';
  var camp=C().camp,cf=camp.from||from,ct=camp.to||to;
  $('#camp-title').textContent=camp.name||'מבצע';
  $('#camp-when').textContent=(camp.from&&camp.to)?shortDate(camp.from)+'–'+shortDate(camp.to):'ללא תאריכים';
  var board=st.map(function(s){var c=tally(cf,ct,s.id);var p=c.ontime*(+camp.pts.ontime||0)+c.late*(+camp.pts.late||0)+c.excused*(+camp.pts.excused||0);return{name:s.name,p:p,ontime:c.ontime};}).sort(function(a,b){return b.p-a.p||b.ontime-a.ontime;});
  $('#camp-list').innerHTML=board.length?board.map(function(x,i){return '<div><div class="rank'+(i===0&&x.p>0?' top':'')+'">'+(i+1)+'</div><div class="grow">'+esc(x.name)+'</div><div class="num">'+x.p+'</div></div>';}).join(''):'<div><span class="hint">אין תלמידים בכיתה.</span></div>';
}
$('#alerts-list').addEventListener('click',function(e){var b=e.target.closest('[data-open]');if(!b)return;go('student');$('#sel-student').value=b.dataset.open;renderReport();});

/* ============ תלמיד ============ */
function fillStudentSelect(){var sel=$('#sel-student'),keep=sel.value;sel.innerHTML='<option value="">בחירת תלמיד…</option>'+sortedStudents().map(function(s){return '<option value="'+s.id+'">'+esc(s.name)+'</option>';}).join('');sel.value=keep;if(!$('#rep-from').value)$('#rep-from').value=shift(today(),-29);if(!$('#rep-to').value)$('#rep-to').value=today();}
$('#sel-student').onchange=renderReport;$('#rep-from').onchange=renderReport;$('#rep-to').onchange=renderReport;
function findStudent(id){var s=CS();return s[id]?{id:id,name:s[id].name,phone:s[id].phone||''}:null;}
function renderReport(){
  var id=$('#sel-student').value,s=findStudent(id);
  if(!s){$('#rep-body').style.display='none';$('#rep-empty').style.display='block';return;}
  $('#rep-empty').style.display='none';$('#rep-body').style.display='block';
  var from=$('#rep-from').value||shift(today(),-29),to=$('#rep-to').value||today();
  var t=tally(from,to,id),total=t.ontime+t.late+t.excused+t.absent,rate=total?Math.round(t.ontime/total*100):0;
  var a=CA(),ds=datesBetween(from,to).filter(function(d){return a[d][id];}).reverse();
  var hist=ds.map(function(d){var r=a[d][id];var opts=ORDER.map(function(k){return '<option value="'+k+'"'+(k===r.s?' selected':'')+'>'+STATUS[k].label+'</option>';}).join('');return '<div><div class="num" style="width:44px">'+shortDate(d)+'</div><div class="grow" style="font-size:12.5px;color:var(--muted)">'+esc(r.n||weekday(d))+'</div><select class="hist" data-date="'+d+'" style="padding:5px 8px;border:1px solid var(--rule);border-radius:7px;background:#fbf7ef;font-size:12.5px">'+opts+'</select></div>';}).join('');
  $('#rep-body').innerHTML='<div class="stats"><div class="stat"><b>'+rate+'%</b><span>בזמן</span></div><div class="stat s-ontime"><b>'+t.ontime+'</b><span>בזמן</span></div><div class="stat s-late"><b>'+t.late+'</b><span>איחורים</span></div><div class="stat s-absent"><b>'+t.absent+'</b><span>חיסורים</span></div></div><div class="sheet"><div class="sheet-head"><h2>יומן דיווחים</h2><span class="hint">'+total+' רשומות</span></div><div class="lines" id="hist-lines">'+(hist||'<div><span class="hint">אין דיווחים בטווח שנבחר.</span></div>')+'</div></div><div class="sheet"><div class="sheet-head"><h2>הודעה להורים</h2><span class="hint">ניסוח מהנתונים</span></div><div class="sheet-body"><div class="chips" style="margin-bottom:10px"><button class="chip on" data-tone="auto">לפי הנתונים</button><button class="chip" data-tone="praise">שבח</button><button class="chip" data-tone="concern">עדכון וחיזוק</button></div><textarea id="msg" class="field" style="min-height:190px"></textarea><div class="btn-row"><button class="btn" id="btn-copy">העתקה</button><button class="btn gold" id="btn-wa">שליחה בוואטסאפ</button></div><label class="f" style="margin-top:11px">טלפון ההורים</label><input type="tel" id="rep-phone" class="field" value="'+esc(s.phone)+'" placeholder="05X-XXXXXXX"></div></div>';
  buildMsg('auto');
  $('#hist-lines').addEventListener('change',function(e){var sel=e.target.closest('select.hist');if(!sel)return;CA()[sel.dataset.date][id].s=sel.value;save();renderReport();toast('הדיווח עודכן');});
  $('#rep-body').querySelector('.chips').addEventListener('click',function(e){var c=e.target.closest('.chip');if(!c)return;all('#rep-body .chip').forEach(function(x){x.classList.toggle('on',x===c);});buildMsg(c.dataset.tone);});
  $('#rep-phone').onchange=function(){CS()[id].phone=this.value.trim();save();};
  $('#btn-copy').onclick=function(){var ta=$('#msg');ta.select();if(navigator.clipboard)navigator.clipboard.writeText(ta.value).then(function(){toast('ההודעה הועתקה');});else{document.execCommand('copy');toast('ההודעה הועתקה');}};
  $('#btn-wa').onclick=function(){var p=($('#rep-phone').value||'').replace(/\D/g,'');if(p.indexOf('0')===0)p='972'+p.slice(1);else if(p.indexOf('972')!==0&&p.length===9)p='972'+p;window.open('https://wa.me/'+(p||'')+'?text='+encodeURIComponent($('#msg').value),'_blank');};
  function buildMsg(tone){
    var name=s.name,pct=rate;
    if(tone==='auto')tone=pct>=90?'praise':(pct>=75?'neutral':'concern');
    var open='בס"ד\nשלום רב להורי '+name+',\n\n';
    var span='ריכזנו את נתוני ההגעה לתפילת שחרית בין '+gregDate(from)+' ל־'+gregDate(to)+':\n';
    var body='• הגעה בזמן: '+t.ontime+'\n• איחורים: '+t.late+'\n• היעדרויות מאושרות: '+t.excused+'\n• היעדרויות ללא אישור: '+t.absent+'\n• אחוז הגעה בזמן: '+pct+'%\n\n';
    var mid;
    if(tone==='praise')mid='רצינו לשתף אתכם בהערכה. '+name+' מקפיד להגיע בזמן ומהווה דוגמה לחבריו, וההתמדה הזו ניכרת גם באווירת הלימוד. ישר כוח על החינוך בבית.\n\n';
    else if(tone==='neutral')mid='התמונה הכללית טובה, ולצידה יש עוד מקום להידוק בכמה בקרים. נשמח אם תסייעו ל'+name+' ביציאה מוקדמת יותר מהבית, כדי להגיע בתחילת התפילה.\n\n';
    else mid='בתקופה האחרונה יש קושי בהגעה בזמן לתפילה. אנו מאמינים ש'+name+' יכול להשתפר, ונשמח לחשוב יחד אתכם איך לסייע. אשמח לשיחה קצרה בנושא.\n\n';
    var sign='בברכה,\n'+(C().teacher||'צוות הכיתה')+(C().name?'\n'+C().name:'');
    $('#msg').value=open+span+body+mid+sign;
  }
}

/* ============ הגדרות ============ */
function renderSettings(){
  $('#layer-code-label').textContent=layer||'—';
  if(!curClass){ $('#set-class-name').value='';$('#set-teacher').value='';$('#roster').innerHTML='<div><span class="hint">פתחו כיתה כדי לנהל אותה.</span></div>';$('#count-label').textContent='';return; }
  var c=C();
  $('#set-class-name').value=c.name;$('#set-teacher').value=c.teacher||'';
  $('#camp-name').value=c.camp.name||'';$('#camp-from').value=c.camp.from||'';$('#camp-to').value=c.camp.to||'';
  $('#pt-ontime').value=c.camp.pts.ontime;$('#pt-late').value=c.camp.pts.late;$('#pt-excused').value=c.camp.pts.excused;
  $('#al-days').value=c.alerts.days;$('#al-max').value=c.alerts.max;
  var st=sortedStudents();$('#count-label').textContent=st.length+' תלמידים';
  $('#klass-label').textContent=[c.name,c.teacher].filter(Boolean).join(' · ');
  $('#roster').innerHTML=st.length?st.map(function(s){return '<div data-id="'+s.id+'"><div class="sigil">'+esc(s.name.charAt(0))+'</div><div class="grow">'+esc(s.name)+(s.phone?'<small class="hint" style="display:block">'+esc(s.phone)+'</small>':'')+'</div><button class="icon-btn" data-act="rename" title="שם">✎</button><button class="icon-btn" data-act="del" title="הסרה">✕</button></div>';}).join(''):'<div><span class="hint">הרשימה ריקה.</span></div>';
}
$('#roster').addEventListener('click',function(e){var b=e.target.closest('[data-act]');if(!b)return;var id=b.closest('[data-id]').dataset.id,s=findStudent(id);if(b.dataset.act==='rename'){var n=prompt('שם התלמיד',s.name);if(n&&n.trim()){CS()[id].name=n.trim();save();renderSettings();}}else{if(!confirm('להסיר את '+s.name+'? הדיווחים שלו בכיתה זו יימחקו.'))return;delete CS()[id];var a=CA();for(var d in a)delete a[d][id];save();renderSettings();toast('התלמיד הוסר');}});
$('#btn-add-names').onclick=function(){if(!curClass){toast('פתחו קודם כיתה');return;}var lines=$('#add-names').value.split('\n').map(function(x){return x.trim();}).filter(Boolean);if(!lines.length){toast('לא הוזנו שמות');return;}var s=CS(),existing=Object.keys(s).map(function(k){return s[k].name;}),added=0;lines.forEach(function(n){if(existing.indexOf(n)!==-1)return;s[uid('s')]={name:n,phone:''};added++;});$('#add-names').value='';save();renderSettings();toast(added?'נוספו '+added+' תלמידים':'כל השמות כבר קיימים');};
$('#btn-rename-class').onclick=function(){if(!curClass)return;var v=$('#set-class-name').value.trim();if(!v)return;C().name=v;save();refreshClassLists();renderSettings();toast('שם הכיתה עודכן');};
$('#set-teacher').onchange=function(){if(!curClass)return;C().teacher=this.value.trim();save();renderSettings();};
$('#btn-save-camp').onclick=function(){if(!curClass)return;var c=C();c.camp.name=$('#camp-name').value.trim()||'מבצע';c.camp.from=$('#camp-from').value;c.camp.to=$('#camp-to').value;c.camp.pts={ontime:+$('#pt-ontime').value||0,late:+$('#pt-late').value||0,excused:+$('#pt-excused').value||0,absent:0};save();toast('המבצע נשמר');};
$('#btn-save-alerts').onclick=function(){if(!curClass)return;C().alerts.days=Math.max(1,+$('#al-days').value||14);C().alerts.max=Math.max(1,+$('#al-max').value||3);save();toast('ההתראות נשמרו');};

/* גיבוי / ייצוא */
function download(name,text,type){var blob=new Blob(['﻿'+text],{type:(type||'application/json')+';charset=utf-8'});var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},800);}
$('#btn-export').onclick=function(){download('shacharit-'+layer+'-'+today()+'.json',JSON.stringify(D,null,1));toast('קובץ הגיבוי ירד');};
$('#btn-csv').onclick=function(){var rows=[['כיתה','תאריך','יום','תלמיד','סטטוס','הערה']];for(var cid in D.classes){var cname=D.classes[cid].name,a=D.att[cid]||{},s=D.students[cid]||{};Object.keys(a).sort().forEach(function(d){for(var id in a[d]){if(!s[id])continue;rows.push([cname,d,weekday(d),s[id].name,STATUS[a[d][id].s]?STATUS[a[d][id].s].label:'',a[d][id].n||'']);}});}var csv=rows.map(function(r){return r.map(function(c){return '"'+String(c).replace(/"/g,'""')+'"';}).join(',');}).join('\n');download('shacharit-'+today()+'.csv',csv,'text/csv');toast('הקובץ ירד');};
$('#btn-change-code').onclick=function(){
  var nc=prompt('קוד שכבה חדש — כל הכיתות והנתונים הקיימים יועברו אליו.\nשימו לב: כל המורים יצטרכו לעבור לקוד החדש.');
  nc=normalizeCode(nc);
  if(!nc)return;
  if(nc===layer){toast('זה כבר הקוד הנוכחי');return;}
  function finish(){try{localStorage.setItem(CACHE_PREFIX+nc,JSON.stringify(D));localStorage.setItem(LKEY,nc);}catch(e){}toast('הקוד הוחלף — טוען מחדש');setTimeout(function(){location.reload();},700);}
  if(online&&db){ db.ref('layers/'+nc).set(D).then(finish).catch(function(){toast('שגיאה בהעברה, נסו שוב');}); }
  else { finish(); }
};
$('#btn-logout').onclick=function(){if(!confirm('לצאת ולהחליף קוד שכבה? הנתונים נשמרים בענן ותחזרו אליהם עם אותו קוד.'))return;try{localStorage.removeItem(LKEY);}catch(e){}location.reload();};

/* ============ שער כניסה ============ */
function normalizeCode(c){ return (c||'').trim().toLowerCase().replace(/\s+/g,'-'); }
function enterWith(code){
  code=normalizeCode(code);
  if(!code){ $('#gate-err').textContent='יש להקליד קוד שכבה.'; return; }
  try{ localStorage.setItem(LKEY,code); }catch(e){}
  connect(code,function(){
    $('#gate').style.display='none';
    refreshClassLists();
    if(!$('#rep-from').value){} // יוגדר בכניסה למסך
    go('entry');
  });
}
$('#gate-enter').onclick=function(){ enterWith($('#gate-code').value); };
$('#gate-code').addEventListener('keydown',function(e){ if(e.key==='Enter') enterWith(this.value); });
$('#gate-offline').onclick=function(){
  var c=normalizeCode($('#gate-code').value)||'local';
  online=false; enterWith(c);
};

/* ============ התקנה / service worker ============ */
if('serviceWorker' in navigator && location.protocol.indexOf('http')===0){
  window.addEventListener('load',function(){ navigator.serviceWorker.register('sw.js').catch(function(){}); });
}
var deferredPrompt=null;
window.addEventListener('beforeinstallprompt',function(e){ e.preventDefault();deferredPrompt=e;var b=$('#btn-install');if(b)b.style.display='block'; });
$('#btn-install').onclick=function(){ if(!deferredPrompt){toast('פתחו את תפריט הדפדפן ובחרו “התקנת אפליקציה”');return;}deferredPrompt.prompt();deferredPrompt.userChoice.then(function(){deferredPrompt=null;$('#btn-install').style.display='none';}); };
window.addEventListener('appinstalled',function(){deferredPrompt=null;var b=$('#btn-install');if(b)b.style.display='none';toast('שחרית הותקנה במכשיר');});

/* ============ הפעלה ============ */
var saved='';
try{ saved=localStorage.getItem(LKEY)||''; }catch(e){}
var cfg=window.FIREBASE_CONFIG;
var configured=cfg&&cfg.apiKey&&cfg.apiKey.indexOf('הדבק')===-1&&cfg.databaseURL&&cfg.databaseURL.indexOf('הדבק')===-1;
if(!configured){ $('#gate-msg').textContent='החיבור לענן עדיין לא הוגדר. אפשר להיכנס במצב מקומי (מכשיר זה בלבד) עד שה־Firebase יחובר.'; }
if(saved){ enterWith(saved); }
else { $('#gate-code').focus(); }

})();
