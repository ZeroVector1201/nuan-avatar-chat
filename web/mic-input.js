// Use browser DSP without letting AGC continuously amplify distant voices.
export function captureConstraints(deviceId,supported={}){
  return {audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:false,
    channelCount:1,...(supported.voiceIsolation?{voiceIsolation:true}:{}),
    ...(deviceId?{deviceId:{exact:deviceId}}:{})},video:false};
}

export async function openMicrophone(mediaDevices,deviceId='default'){
  const selected=deviceId||'default',supported=mediaDevices.getSupportedConstraints?.()||{};
  try{return await mediaDevices.getUserMedia(captureConstraints(selected,supported));}
  catch(error){
    // Some browsers do not expose Chromium's virtual default input. Only that
    // alias can fall back to browser selection; keep explicit device choices.
    const missingDefault=selected==='default'&&(error.name==='NotFoundError'||
      (error.name==='OverconstrainedError'&&error.constraint==='deviceId'));
    if(!missingDefault)throw error;
    return mediaDevices.getUserMedia(captureConstraints('',supported));
  }
}

export function connectCapture(ctx,stream){
  const source=ctx.createMediaStreamSource(stream),filter=ctx.createBiquadFilter();
  // Remove handling/desk/air-conditioning rumble while preserving speech.
  filter.type='highpass';filter.frequency.value=90;filter.Q.value=.707;
  source.connect(filter);return {source,filter};
}

// Pointer/keyboard ownership is explicit: leaving the page or losing the
// gesture cancels, and a late event can never submit a second recording.
export function bindHoldButton(button,{start,finish,cancel}){
  let owner=null;
  const begin=id=>{if(owner!==null||button.disabled)return;owner=id;if(start()===false)owner=null;};
  const end=(id,abort=false)=>{if(owner!==id||owner===null)return;owner=null;(abort?cancel:finish)();};
  const abort=()=>{if(owner!==null)end(owner,true);};
  button.addEventListener('pointerdown',e=>{
    if(e.button!==0)return;e.preventDefault();begin(e.pointerId);
    if(owner===e.pointerId)button.setPointerCapture(e.pointerId);
  });
  button.addEventListener('pointerup',e=>{
    const box=button.getBoundingClientRect();
    end(e.pointerId,e.clientX<box.left||e.clientX>box.right||e.clientY<box.top||e.clientY>box.bottom);
  });
  for(const name of ['pointercancel','lostpointercapture'])button.addEventListener(name,e=>end(e.pointerId,true));
  button.addEventListener('keydown',e=>{
    if(e.code==='Escape'){abort();return;}
    if(['Space','Enter'].includes(e.code)){e.preventDefault();if(!e.repeat)begin(e.code);}
  });
  button.addEventListener('keyup',e=>{if(['Space','Enter'].includes(e.code)){e.preventDefault();end(e.code);}});
  button.addEventListener('blur',abort);
  button.addEventListener('contextmenu',e=>e.preventDefault());
  window.addEventListener('blur',abort);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)abort();});
  return {abort};
}
