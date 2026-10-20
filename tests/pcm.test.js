import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../web/pcm-worklet.js',import.meta.url),'utf8');
function player(rate){
  let Processor;const events=[];
  vm.runInNewContext(source,{
    AudioWorkletProcessor:class {constructor(){this.port={postMessage:d=>events.push(d)};}},
    sampleRate:rate,Int16Array,registerProcessor:(name,c)=>{Processor=c;}
  });
  const p=new Processor({processorOptions:{sampleRate:24000}});
  return {p,events,send:d=>p.port.onmessage({data:d})};
}
for(const rate of [24000,44100,48000]){
  test(`PCM keeps duration/pitch at ${rate} Hz, including odd chunk boundaries`,()=>{
    const {p,events,send}=player(rate),seconds=.7;
    const input=Int16Array.from({length:24000*seconds},(_,i)=>Math.round(10000*Math.sin(2*Math.PI*220*i/24000)));
    for(let i=0;i<input.length;i+=997)send({type:'pcm',audio:input.slice(i,i+997).buffer});
    send({type:'end'});
    const output=[];let running=true,blocks=0;
    while(running&&blocks++<1000){
      const out=new Float32Array(128);running=p.process([],[[out]]);output.push(...out);
    }
    assert(!running);assert.equal(events.filter(e=>e.type==='finished').length,1);
    assert.equal(events.at(-1).playedSamples,input.length);
    assert(Math.abs(output.length/rate-seconds)<128/rate+.001);
    let crossings=0;for(let i=1;i<Math.floor(seconds*rate);i++)if(output[i-1]<=0&&output[i]>0)crossings++;
    assert(Math.abs(crossings-220*seconds)<=1);
    assert.equal(events.at(-1).underruns,0);
  });
}
test('stop drops queued sound; generation end waits until queued audio drains',()=>{
  const {p,events,send}=player(48000);
  send({type:'pcm',audio:new Int16Array(24000).fill(1000).buffer});send({type:'end'});
  assert(p.process([],[[new Float32Array(128)]]));
  assert(!events.some(e=>e.type==='finished'));
  send({type:'stop'});const out=new Float32Array(128);
  assert.equal(p.process([],[[out]]),false);assert(out.every(x=>x===0));
});
