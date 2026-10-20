import {openMicrophone,connectCapture} from './mic-input.js';

export function wav(parts,rate){
  const length=parts.reduce((n,p)=>n+p.length,0);
  if(!Number.isInteger(rate)||rate<8000||rate>48000||length<rate*.1||length>rate*30)throw Error('请录制 0.1 到 30 秒语音。');
  const buffer=new ArrayBuffer(44+length*2),view=new DataView(buffer);
  const text=(offset,s)=>{for(let i=0;i<s.length;i++)view.setUint8(offset+i,s.charCodeAt(i));};
  text(0,'RIFF');view.setUint32(4,36+length*2,true);text(8,'WAVE');text(12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
  text(36,'data');view.setUint32(40,length*2,true);let offset=44;
  for(const part of parts)for(const value of part){view.setInt16(offset,Math.max(-1,Math.min(1,value))*32767,true);offset+=2;}
  let raw='';const bytes=new Uint8Array(buffer);
  for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(raw);
}

export class Microphone{
  constructor(level=()=>{}){this.level=level;this.epoch=0;this.recording=false;}
  async start(device='default',onLimit=()=>{}){
    this.cancel();const epoch=this.epoch;
    const stream=await openMicrophone(navigator.mediaDevices,device);
    if(epoch!==this.epoch){stream.getTracks().forEach(t=>t.stop());return false;}
    this.stream=stream;
    try{
      const ctx=this.ctx=new AudioContext({sampleRate:16000});await ctx.resume();
      await ctx.audioWorklet.addModule('/static/mic-worklet.js');
      if(epoch!==this.epoch)return false;
      const {source,filter}=connectCapture(ctx,stream);this.source=source;this.filter=filter;
      this.node=new AudioWorkletNode(ctx,'mic-capture');this.silent=ctx.createGain();this.silent.gain.value=0;
      filter.connect(this.node);this.node.connect(this.silent);this.silent.connect(ctx.destination);
      this.parts=[];this.samples=0;this.recording=true;this.accepting=true;this.rate=ctx.sampleRate;this.limited=false;
      this.node.port.onmessage=({data})=>{
        if(epoch!==this.epoch)return;
        if(data.type==='flushed'){this.flushed?.();return;}
        if(!this.accepting||!data.length)return;
        const remaining=this.rate*30-this.samples;
        if(remaining<=0)return;
        const part=data.length>remaining?data.slice(0,remaining):data;
        this.parts.push(part);this.samples+=part.length;
        this.level(Math.round(this.samples/this.rate));
        if(this.samples>=this.rate*30&&!this.limited){this.limited=true;onLimit();}
      };
      return true;
    }catch(e){if(epoch===this.epoch)this.cancel();throw e;}
  }
  async finish(){
    if(!this.recording)throw Error('没有正在进行的录音。');
    this.recording=false;const epoch=this.epoch;
    await new Promise(resolve=>{const timer=setTimeout(resolve,250);this.flushed=()=>{clearTimeout(timer);resolve();};this.node.port.postMessage({type:'flush'});});
    if(epoch!==this.epoch)throw Error('录音已取消。');
    this.accepting=false;
    try{return wav(this.parts,this.rate);}finally{this.cancel();}
  }
  cancel(){
    this.epoch++;this.recording=false;this.accepting=false;this.flushed?.();this.flushed=null;
    this.stream?.getTracks().forEach(t=>t.stop());this.stream=null;
    this.source?.disconnect();this.filter?.disconnect();this.node?.disconnect();this.silent?.disconnect();
    this.ctx?.close().catch(()=>{});this.ctx=null;this.parts=[];this.samples=0;
  }
}
