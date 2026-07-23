
const quotes=[
  'Трезвость не отнимает жизнь — она возвращает тебе все её цвета.',
  'Каждое спокойное утро — медаль, которую невозможно купить.',
  'Ты не отказываешься от зависимости. Ты выбираешь свободу.',
  'Сегодняшний выбор строит человека, которым ты будешь гордиться завтра.',
  'Сильный не тот, кто никогда не падал, а тот, кто выбрал подняться.',
  'Без зависимости появляется место для мечтаний, близких и настоящей радости.',
  'Один честный день превращается в неделю, неделя — в новую жизнь.',
  'Твоё будущее не требует идеальности. Оно просит не сдаваться сегодня.',
  'Трезвая жизнь — это возвращение домой, к самому себе.',
  'Самая важная победа происходит тихо: когда ты выбираешь себя.',
  'Пусть сегодня будет не лёгким, а настоящим и твоим.',
  'Ты уже в пути. Каждый следующий шаг делает дорогу светлее.'
];
const state={today:null,archive:{days:[],stats:{}},selected:null};
const $=s=>document.querySelector(s);
const ruDate=d=>new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',year:'numeric'}).format(new Date(d+'T12:00:00'));
const ruTime=s=>new Intl.DateTimeFormat('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(s));
const STORE_KEY='vitina-road-diary-v1',ACCESS_PIN='268413';
function localToday(){const d=new Date(),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`}
function loadStore(){try{return JSON.parse(localStorage.getItem(STORE_KEY))||{days:{}}}catch{return {days:{}}}}
function saveStore(data){localStorage.setItem(STORE_KEY,JSON.stringify(data))}
function apiError(message,status){throw Object.assign(new Error(message),{status})}
async function api(path,options={}){const method=options.method||'GET',payload=options.body?JSON.parse(options.body):{},data=loadStore(),today=localToday();
  if(path==='/api/session')return {authenticated:sessionStorage.getItem('vitina-auth')==='1'};
  if(path==='/api/login'){if(String(payload.pin)!==ACCESS_PIN)apiError('Неверный код доступа',401);sessionStorage.setItem('vitina-auth','1');return {ok:true}}
  if(path==='/api/logout'){sessionStorage.removeItem('vitina-auth');return {ok:true}}
  if(sessionStorage.getItem('vitina-auth')!=='1')apiError('Требуется вход',401);
  if(path==='/api/today'){const day=data.days[today]||null;return {date:today,started:!!day,day}}
  if(path==='/api/days'&&method==='POST'){if(payload.date!==today)apiError('Запись можно создать только за сегодняшний день',400);if(data.days[today])apiError('Сегодняшний день уже начат',409);const statement=String(payload.statement||'').trim();if(!statement)apiError('Напиши фразу',400);data.days[today]={date:today,statement,created_at:new Date().toISOString(),thoughts:[]};saveStore(data);return {ok:true,date:today}}
  if(path==='/api/thoughts'&&method==='POST'){if(payload.date!==today)apiError('Мысли можно добавлять только сегодня',400);if(!data.days[today])apiError('Сначала начни сегодняшний день',409);const text=String(payload.text||'').trim();if(!text)apiError('Запись не может быть пустой',400);const item={id:Date.now(),text,created_at:new Date().toISOString()};data.days[today].thoughts.push(item);saveStore(data);return item}
  if(path==='/api/archive'){const days=Object.values(data.days).sort((a,b)=>b.date.localeCompare(a.date)).map(d=>({date:d.date,statement:d.statement,created_at:d.created_at,thought_count:d.thoughts.length,last_activity:d.thoughts.at(-1)?.created_at||d.created_at}));let streak=0,c=new Date(today+'T12:00:00');while(data.days[c.toISOString().slice(0,10)]){streak++;c.setDate(c.getDate()-1)}return {days,stats:{days:days.length,thoughts:days.reduce((s,d)=>s+d.thought_count,0),streak}}}
  if(path.startsWith('/api/days/')){const date=path.slice('/api/days/'.length),day=data.days[date];if(!day)apiError('В этот день записей нет',404);return day}
  apiError('Неизвестная операция',404)
}
function toast(text){const el=$('#toast');el.textContent=text;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),3000)}
function title(){$('#animatedTitle').textContent='Витина дорога в счастливое будущее'}
function updateQuote(){const block=Math.floor(Date.now()/600000);$('#quote').textContent=quotes[block%quotes.length];const left=600-(Math.floor(Date.now()/1000)%600);$('#quoteNext').textContent=`новая мысль через ${Math.floor(left/60)}:${String(left%60).padStart(2,'0')}`}
function timeline(day){const box=$('#timeline');if(!day){box.innerHTML='<div class="empty">В этот день записей пока нет.</div>';return}const entries=[{created_at:day.created_at,text:day.statement,kind:'Начало дня'},...(day.thoughts||[]).map(x=>({...x,kind:'Мысль'}))];box.innerHTML=entries.map(e=>`<article class="event"><div class="event-time">${ruTime(e.created_at)} · ${e.kind}</div><div class="event-text"></div></article>`).join('');[...box.querySelectorAll('.event-text')].forEach((el,i)=>el.textContent=entries[i].text)}
function renderCalendar(){const now=new Date(state.today.date+'T12:00:00');const y=now.getFullYear(),m=now.getMonth();$('#calTitle').textContent=new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric'}).format(now);const archived=new Set(state.archive.days.map(x=>x.date));const first=new Date(y,m,1),count=new Date(y,m+1,0).getDate();let html=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(x=>`<div class="dow">${x}</div>`).join('');let offset=(first.getDay()+6)%7;html+='<div></div>'.repeat(offset);for(let d=1;d<=count;d++){const iso=`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;const cls=iso===state.today.date?'today':archived.has(iso)?'archived':'';html+=`<button class="cal-day ${cls}" data-date="${iso}" ${cls?'':'disabled'} aria-label="${ruDate(iso)}">${d}</button>`}$('#calendar').innerHTML=html;document.querySelectorAll('.cal-day.archived,.cal-day.today').forEach(b=>b.addEventListener('click',()=>selectDay(b.dataset.date)))}
async function selectDay(date){try{const day=await api('/api/days/'+date);state.selected=date;$('#timelineTitle').textContent=`${ruDate(date)} · ${day.thoughts.length+1} событий`;$('#showToday').classList.toggle('hidden',date===state.today.date);timeline(day);if(date!==state.today.date)document.querySelector('.timeline-panel').scrollIntoView({behavior:'smooth'})}catch(e){if(e.status===404){state.selected=date;$('#timelineTitle').textContent=ruDate(date);timeline(null)}}}
async function refresh(){state.today=await api('/api/today');state.archive=await api('/api/archive');state.selected=state.today.date;$('#scoreDate').textContent=ruDate(state.today.date).toUpperCase();$('#todayLabel').textContent=ruDate(state.today.date);$('#statDays').textContent=state.archive.stats.days;$('#statStreak').textContent=state.archive.stats.streak;$('#statThoughts').textContent=state.archive.stats.thoughts;$('#heroDay').textContent=Math.max(1,state.archive.stats.days);$('#startState').classList.toggle('hidden',state.today.started);$('#activeState').classList.toggle('hidden',!state.today.started);if(state.today.started){$('#activeStatement').textContent=state.today.day.statement;$('#activeTime').textContent=`Зафиксировано в ${ruTime(state.today.day.created_at)}`;await selectDay(state.today.date)}else{$('#timelineTitle').textContent='События сегодняшнего дня';timeline(null)}renderCalendar()}
$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();$('#loginError').textContent='';try{await api('/api/login',{method:'POST',body:JSON.stringify({pin:$('#pin').value})});$('#pin').value='';$('#loginModal').classList.add('hidden');$('#app').classList.remove('hidden');await refresh()}catch(err){$('#loginError').textContent=err.message}})
$('#logout').addEventListener('click',async()=>{await api('/api/logout',{method:'POST'});location.reload()});
$('#startDay').addEventListener('click',async()=>{const btn=$('#startDay');$('#startError').textContent='';btn.disabled=true;try{await api('/api/days',{method:'POST',body:JSON.stringify({date:state.today.date,statement:$('#statement').value})});toast('Первый шаг сохранён. Сегодня ты выбрал себя.');await refresh()}catch(e){$('#startError').textContent=e.message}finally{btn.disabled=false}});
$('#thoughtForm').addEventListener('submit',async e=>{e.preventDefault();const text=$('#thought').value.trim();$('#thoughtError').textContent='';if(!text)return;const btn=e.currentTarget.querySelector('button');btn.disabled=true;try{await api('/api/thoughts',{method:'POST',body:JSON.stringify({date:state.today.date,text})});$('#thought').value='';toast('Мысль сохранена в истории дня');await refresh()}catch(err){$('#thoughtError').textContent=err.message}finally{btn.disabled=false}});
$('#showToday').addEventListener('click',()=>selectDay(state.today.date));$('#goToday').addEventListener('click',()=>selectDay(state.today.date));
(async function init(){title();updateQuote();setInterval(updateQuote,1000);const session=await api('/api/session');if(session.authenticated){$('#loginModal').classList.add('hidden');$('#app').classList.remove('hidden');await refresh()}})();
