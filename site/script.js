(() => {
  const $ = (id) => document.getElementById(id);
  const state = { ctx:null, analyser:null, running:false, queue:[], current:null, deck:0, stopTimers:[], gainA:null, gainB:null, nextStartAt:0 };
  const sampleUrl = './assets/tracks/sonic_forage_sa3_small_music_deep_echo_8s.mp3';

  async function checkWebGPU(){
    const badge=$('gpuBadge');
    if('gpu' in navigator){
      try{ const adapter = await navigator.gpu.requestAdapter(); badge.textContent = adapter ? 'WebGPU ready' : 'WebGPU unavailable'; }
      catch(e){ badge.textContent='WebGPU blocked'; }
    } else badge.textContent='WebGPU not supported';
  }

  function hashPrompt(s){ let h=2166136261>>>0; for(const ch of s){h^=ch.charCodeAt(0); h=Math.imul(h,16777619)} return h>>>0; }
  function rng(seed){ return () => (seed = Math.imul(1664525, seed) + 1013904223 >>> 0) / 2**32; }

  async function ensureAudio(){
    if(state.ctx) return state.ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state.ctx = new Ctx();
    state.analyser = state.ctx.createAnalyser(); state.analyser.fftSize = 1024;
    state.analyser.connect(state.ctx.destination);
    state.gainA = state.ctx.createGain(); state.gainB = state.ctx.createGain();
    state.gainA.connect(state.analyser); state.gainB.connect(state.analyser);
    return state.ctx;
  }

  async function decodeUrl(url){ const ctx=await ensureAudio(); const res=await fetch(url,{cache:'force-cache'}); if(!res.ok) throw new Error('fetch '+res.status); return await ctx.decodeAudioData(await res.arrayBuffer()); }

  function encodeWav(buffer){
    const ch=buffer.numberOfChannels, len=buffer.length, sr=buffer.sampleRate, bytes=44+len*ch*2;
    const ab=new ArrayBuffer(bytes), v=new DataView(ab); let o=0;
    const ws=s=>{for(let i=0;i<s.length;i++)v.setUint8(o++,s.charCodeAt(i))};
    ws('RIFF'); v.setUint32(o,bytes-8,true); o+=4; ws('WAVEfmt '); v.setUint32(o,16,true); o+=4; v.setUint16(o,1,true); o+=2; v.setUint16(o,ch,true); o+=2; v.setUint32(o,sr,true); o+=4; v.setUint32(o,sr*ch*2,true); o+=4; v.setUint16(o,ch*2,true); o+=2; v.setUint16(o,16,true); o+=2; ws('data'); v.setUint32(o,len*ch*2,true); o+=4;
    const data=[...Array(ch)].map((_,i)=>buffer.getChannelData(i));
    for(let i=0;i<len;i++) for(let c=0;c<ch;c++){ let s=Math.max(-1,Math.min(1,data[c][i])); v.setInt16(o, s<0?s*0x8000:s*0x7fff, true); o+=2; }
    return new Blob([ab],{type:'audio/wav'});
  }

  async function synthPromptLoop(prompt, duration, mood){
    const seed=hashPrompt(prompt+'|'+mood), rand=rng(seed), sr=48000;
    const off=new OfflineAudioContext(2, Math.floor(duration*sr), sr);
    const master=off.createGain(); master.gain.value=.22; master.connect(off.destination);
    const scale=[0,2,3,5,7,10,12]; const base=48 + Math.floor(rand()*12);
    const delay=off.createDelay(1.5); delay.delayTime.value=.28+rand()*.42; const fb=off.createGain(); fb.gain.value=.32; delay.connect(fb); fb.connect(delay); delay.connect(master);
    const filt=off.createBiquadFilter(); filt.type='lowpass'; filt.frequency.value=900+rand()*2600; filt.Q.value=.8; filt.connect(delay); filt.connect(master);
    for(let bar=0; bar<duration; bar+=.5){
      const n=base+scale[Math.floor(rand()*scale.length)]+(rand()>.72?12:0); const f=440*Math.pow(2,(n-69)/12);
      const osc=off.createOscillator(); osc.type=rand()>.5?'triangle':'sine'; osc.frequency.value=f;
      const g=off.createGain(); const t=bar; g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(.12+rand()*.08,t+.018); g.gain.exponentialRampToValueAtTime(.001,t+.22+rand()*.45);
      osc.connect(g); g.connect(filt); osc.start(t); osc.stop(Math.min(duration,t+1.2));
    }
    for(let t=0; t<duration; t+=1){
      const o=off.createOscillator(); o.type='sine'; o.frequency.value=55*(mood.includes('dub')?1:1.5);
      const g=off.createGain(); g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(.26,t+.02); g.gain.exponentialRampToValueAtTime(.001,t+.24);
      o.connect(g); g.connect(master); o.start(t); o.stop(t+.35);
    }
    const noiseBuf=off.createBuffer(1, sr*.08, sr); const arr=noiseBuf.getChannelData(0); for(let i=0;i<arr.length;i++) arr[i]=(rand()*2-1)*Math.pow(1-i/arr.length,2);
    for(let t=.5; t<duration; t+=.5){ const n=off.createBufferSource(); n.buffer=noiseBuf; const g=off.createGain(); g.gain.value=.035; n.connect(g); g.connect(master); n.start(t); }
    const rendered=await off.startRendering(); return {buffer:rendered, url:URL.createObjectURL(encodeWav(rendered)), seed};
  }

  function addQueue(item){ state.queue.push(item); renderQueue(); if(state.running && !state.current) playNext(); }
  function renderQueue(){ $('queue').innerHTML = state.queue.map((q,i)=>`<li><b>${i===0?'NEXT':'QUEUED'}</b> ${q.title}<br><small>${q.prompt}</small></li>`).join('') || '<li>Queue empty — add a prompt.</li>'; }
  function updateNow(s){ $('now').textContent=s; }

  async function playNext(){
    if(!state.running || state.queue.length===0) return;
    const item=state.queue.shift(); renderQueue(); const ctx=await ensureAudio(); if(ctx.state==='suspended') await ctx.resume();
    const source=ctx.createBufferSource(); source.buffer=item.buffer; source.loop=true;
    const deckGain = state.deck ? state.gainB : state.gainA; const other = state.deck ? state.gainA : state.gainB; state.deck=1-state.deck;
    const now=ctx.currentTime, fade=Number($('xfade').value)||4;
    deckGain.gain.cancelScheduledValues(now); deckGain.gain.setValueAtTime(0,now); deckGain.gain.linearRampToValueAtTime(1, now+fade);
    other.gain.cancelScheduledValues(now); other.gain.setValueAtTime(other.gain.value, now); other.gain.linearRampToValueAtTime(0, now+fade);
    source.connect(deckGain); source.start(now);
    if(state.current?.source){ const old=state.current.source; state.stopTimers.push(setTimeout(()=>{try{old.stop()}catch{}}, (fade+0.5)*1000)); }
    state.current={...item, source}; updateNow(`${item.title} — ${Math.round(item.buffer.duration)}s loop, crossfade ${fade}s`);
    const nextMs=Math.max(4000,(item.buffer.duration-fade-1)*1000); state.stopTimers.push(setTimeout(()=>{ if(state.queue.length) playNext(); }, nextMs));
  }

  async function queueLocal(){
    const prompt=$('prompt').value.trim(); const duration=Number($('duration').value)||16; const mood=$('mood').value;
    updateNow('Generating browser loop…'); const r=await synthPromptLoop(prompt,duration,mood);
    addQueue({title:`Browser loop seed ${r.seed}`, prompt, buffer:r.buffer, url:r.url}); updateNow('Queued browser-generated loop.'); if(state.running && !state.current) playNext();
  }

  async function queueSample(){ const buffer=await decodeUrl(sampleUrl); addQueue({title:'SA3 deep echo sample', prompt:'Verified Modal Stable Audio 3 sample', buffer, url:sampleUrl}); }

  async function queueModal(){
    const backend=$('backend').value.trim(); if(!backend){ alert('Paste a Modal backend URL first, or use local browser generation.'); return; }
    updateNow('Calling Modal backend…');
    const body={prompt:$('prompt').value.trim(), duration:Number($('duration').value)||16, crossfade:Number($('xfade').value)||4};
    const headers={'content-type':'application/json'}; if($('apiKey').value) headers.authorization='Bearer '+$('apiKey').value;
    const res=await fetch(backend,{method:'POST',headers,body:JSON.stringify(body)}); if(!res.ok) throw new Error('Modal HTTP '+res.status);
    const j=await res.json(); let buffer;
    if(j.audio_base64){ const bin=Uint8Array.from(atob(j.audio_base64), c=>c.charCodeAt(0)); buffer=await (await ensureAudio()).decodeAudioData(bin.buffer); }
    else if(j.audio_url){ buffer=await decodeUrl(j.audio_url); }
    else throw new Error('Modal response needs audio_url or audio_base64');
    addQueue({title:j.title||'Modal generated chunk', prompt:body.prompt, buffer, url:j.audio_url||''}); updateNow('Queued Modal chunk.');
  }

  function draw(){
    const c=$('viz'), g=c.getContext('2d'), w=c.width, h=c.height; requestAnimationFrame(draw);
    g.fillStyle='#020409'; g.fillRect(0,0,w,h); const grad=g.createLinearGradient(0,0,w,h); grad.addColorStop(0,'#69ffd0'); grad.addColorStop(.5,'#6da8ff'); grad.addColorStop(1,'#ff65d8'); g.strokeStyle=grad; g.lineWidth=3;
    if(!state.analyser){ g.fillStyle='#69ffd0'; g.font='28px monospace'; g.fillText('press start to boot the deck',40,80); return; }
    const data=new Uint8Array(state.analyser.frequencyBinCount); state.analyser.getByteFrequencyData(data); g.beginPath();
    for(let i=0;i<data.length;i++){ const x=i/data.length*w, y=h-(data[i]/255)*h*.86-20; if(i===0)g.moveTo(x,y);else g.lineTo(x,y); } g.stroke();
    const avg=data.reduce((a,b)=>a+b,0)/data.length; $('meters').innerHTML=`<div>signal ${Math.round(avg)}</div><div class="meter"><span style="width:${Math.min(100,avg)}%"></span></div>`;
  }

  $('startBtn').onclick=async()=>{ state.running=true; await ensureAudio(); if(state.queue.length===0) await queueSample(); playNext(); };
  $('stopBtn').onclick=()=>{ state.running=false; state.stopTimers.forEach(clearTimeout); state.stopTimers=[]; try{state.current?.source.stop()}catch{} state.current=null; updateNow('Stopped'); };
  $('seedBtn').onclick=queueSample; $('queueLocal').onclick=()=>queueLocal().catch(e=>updateNow('Local generation error: '+e.message)); $('queueModal').onclick=()=>queueModal().catch(e=>updateNow('Modal error: '+e.message));
  $('saveBackend').onclick=()=>{ localStorage.setItem('sf_backend',$('backend').value); updateNow('Backend saved in this browser.'); };
  $('clearBackend').onclick=()=>{ localStorage.removeItem('sf_backend'); $('backend').value=''; };
  $('backend').value=localStorage.getItem('sf_backend')||'';
  checkWebGPU(); renderQueue(); draw();
})();